import { featureTitle } from '../contracts/feature-title.js';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { planningResume } from '../core/resume.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  RunStageSchema,
  WorkflowClassSchema,
  WORKFLOW_CLASSES,
  type Plan,
  type RunStage,
  type WorkflowClass,
} from '../contracts/index.js';
import { buildExecutionContext, buildPlanningPipeline } from '../app/execution-context.js';
import type { StateStore } from '../app/state-store.js';
import { resolveRole } from '../core/role.js';
import type { WorkflowClassificationResult, WorkflowEvidence } from '../core/adaptive-workflow.js';
import { runPaths } from '../app/paths.js';
import {
  createRunWithIdentity,
  revise,
  type ActionError,
  type ReviseMode,
  type ReviseResult,
  type RunActionDeps,
} from '../app/run-actions.js';
import {
  chooseInstructionSource,
  DESCRIPTION_WORDING,
  readInstruction,
  type InstructionFlags,
  type InstructionIO,
} from './instruction-source.js';
import { actionDeps, currentRunId, exitCodeFor, render } from './approve.js';
import { nodeAdapters } from './adapters.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import { writeProgress } from './render/progress.js';
import type { GlobalOptions } from './index.js';

export interface FeatureOptions {
  readonly cache?: boolean;
  readonly from?: string;
  readonly skipReview?: boolean;
  readonly workflow?: string;
  /** `--grounded`: see `PipelineOptions.grounded`. */
  readonly grounded?: boolean;
}

/** The seams a test replaces: where the text is read from, and what runs once it is. */
export interface FeatureSourceDeps {
  readonly io: InstructionIO;
  readonly run: typeof runFeatureCommand;
}

/**
 * `feature` with its description read the way `revise` reads its instruction (D15).
 *
 * Measured on AF-2026-004, 11/09/2026: the description was 9 KB with backticks, quotes and
 * paragraph breaks, and the run had to be started from a Node script calling `spawn` with
 * an argv, because every shell mangled the text before Agent Flow saw it — the exact
 * defect the comment beside `revise`'s argument already described. Same chooser, same
 * reader, same three sources; only the noun in the refusals changes, so the person who
 * typed `feature` is not told about an "instruction".
 *
 * Resolved before anything else runs: a refused invocation costs no context build, and
 * `--edit` opens an editor only for a command that will use what gets typed.
 */
export async function runFeatureFromSource(
  flags: InstructionFlags,
  options: FeatureOptions,
  globals: GlobalOptions,
  deps: FeatureSourceDeps = { io: nodeInstructionIO(), run: runFeatureCommand },
): Promise<ExitCodeValue> {
  const source = chooseInstructionSource(flags, DESCRIPTION_WORDING);
  if (source.kind === 'refused') {
    process.stderr.write(`${source.reason}\n`);
    return ExitCode.CONFIG_ERROR;
  }

  const read = await readInstruction(source, deps.io, DESCRIPTION_WORDING);
  if (!read.ok) {
    process.stderr.write(`${read.reason}\n`);
    return ExitCode.CONFIG_ERROR;
  }

  return deps.run(read.instruction, options, globals);
}

/**
 * `agent-flow feature "<description>"` — the planning half of the workflow.
 *
 * Stops at a plan on purpose. Nothing is implemented until a human has read the
 * SDD and the task breakdown and approved them (§17).
 */
export async function runFeatureCommand(
  description: string,
  options: FeatureOptions,
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  // Outside the `try`, because the catch is the one place it is read: the stage a
  // failed run stopped in is what makes the resume line below complete.
  let lastStarted: string | undefined;
  // And for the same reason, the store: the other half of that line is the workflow
  // class, and it is written by the pipeline rather than known here (D17).
  let store: StateStore | undefined;

  try {
    const from = options.from === undefined ? undefined : parseStage(options.from);

    // Assembles the whole graph, and validates the roles while doing it — a role
    // pointing at a runner that is not registered is a configuration mistake, and
    // finding it three expensive stages in would waste everything already spent.
    const context = await buildExecutionContext({
      ...nodeAdapters(),
      projectDir: globals.cwd,
      globalConfigPath: globals.globalConfigPath,
    });

    store = context.store;

    if (globals.dryRun) {
      printExecutionPlan(context.config.global, context.capabilities, globals);
      return ExitCode.OK;
    }

    let workflowOverride: WorkflowClass | undefined;
    if (options.workflow !== undefined) {
      const parsed = WorkflowClassSchema.safeParse(options.workflow);
      if (!parsed.success) {
        process.stderr.write(
          `Invalid workflow class "${options.workflow}". Supported classes: ${WORKFLOW_CLASSES.join(', ')}\n`,
        );
        return ExitCode.CONFIG_ERROR;
      }
      workflowOverride = parsed.data;
    }

    // Resuming must continue the existing run, not start a fresh one. Creating a
    // new run here would leave its artifacts empty and silently re-run the very
    // stages `--from` exists to skip — the opposite of the intent, at full cost.
    const run =
      from === undefined
        ? await createRunWithIdentity(context, description)
        : ((await context.store.loadCurrentRun()) ??
          (() => {
            throw new Error(
              'No run to resume. Start one with `agent-flow feature "<description>"` first.',
            );
          })());

    // The same pipeline the revise use case builds, from the same helper. Two
    // wirings of one pipeline is how the two stop being identical.
    const pipeline = buildPlanningPipeline(context);

    // The title, not the request: a 5 KB description echoed here was the run's whole name.
    process.stdout.write(`Run ${run.runId} — ${featureTitle(description)}\n`);
    process.stdout.write('Planning feature...\nNo implementation will occur before approval.\n\n');

    const result = await pipeline.run(run.runId, description, {
      ...(options.cache === false ? { noCache: true } : {}),
      ...(from === undefined ? {} : { from }),
      ...(options.skipReview === true ? { skipReview: true } : {}),
      ...(options.grounded === true ? { grounded: true } : {}),
      ...(workflowOverride !== undefined ? { workflow: workflowOverride } : {}),
      onProgress: (stage, status) => {
        if (status === 'started') lastStarted = stage;
        writeStageProgress(stage, status, globals.verbose);
      },
    });

    const paths = runPaths(globals.cwd, run.runId);

    if (globals.json) {
      process.stdout.write(`${JSON.stringify({ runId: run.runId, plan: result.plan }, null, 2)}\n`);
      return ExitCode.OK;
    }

    // **Only the artifacts this run actually wrote** (D11).
    //
    // The `simple` and `trivial` workflows have no SDD stage, and this block printed its
    // path regardless — measured on a real `--workflow simple` run, which listed
    // `…/runs/AF-2026-001/sdd.md` for a file `ls` says is not there. A path a person is
    // told to read and cannot open is worse than saying nothing: the first guess is that
    // the run is broken.
    //
    // Asked of the filesystem rather than inferred from the workflow class, so a stage
    // that stops writing its artifact cannot leave this message claiming otherwise.
    const written = [
      { label: 'SDD  ', path: paths.sdd },
      { label: 'Plan ', path: paths.plan },
    ].filter((artifact) => existsSync(artifact.path));

    process.stdout.write(
      [
        '',
        `${String(result.plan.tasks.length)} tasks planned.`,
        '',
        ...(result.classification === undefined ? [] : classificationLines(result.classification)),
        ...operatorVerificationLines(result.plan),
        ...written.map((artifact) => `  ${artifact.label}  ${artifact.path}`),
        '',
        written.length > 1
          ? 'Read both before approving — the automated review checks the plan against'
          : 'Read it before approving — the automated review checks the plan, but it is',
        written.length > 1
          ? 'the SDD, but it is not the one accountable for it.'
          : 'not the one accountable for it.',
        '',
        nextStepAfterPlanning(result.review?.verdict),
        '',
      ].join('\n'),
    );

    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`\n${rendered.message}\n`);
    process.stderr.write(resumeHint(lastStarted, await classOf(store)));
    return rendered.exitCode;
  }
}

/**
 * The run's workflow class, or nothing — read inside a `catch`, so it may not throw.
 *
 * The class is what decides which stages a resume keeps, and it is decided by the
 * pipeline rather than by this command: `--workflow` is an override that is usually
 * absent, and the classifier can elevate past it. So the answer is read back from the
 * state the pipeline wrote, which is the only place it is true.
 *
 * **Swallows everything on purpose.** This runs while another error is being reported,
 * and a store that cannot be read must not replace the failure the operator needs to
 * see with one about reading the store. Without a class the sentence says less (see
 * `resumeHint`), which is the correct amount to say.
 */
async function classOf(store: StateStore | undefined): Promise<WorkflowClass | undefined> {
  if (store === undefined) return undefined;
  try {
    return (await store.loadCurrentRun())?.workflow;
  } catch {
    return undefined;
  }
}

/**
 * Where to pick the run back up, printed at the point the run stopped.
 *
 * `--from` already resumes a stage keeping the artifacts before it, and the
 * pipeline supports it well. Nothing on the failure path said so: a planning stage
 * dying printed the runner's error and stopped, and the only command offered
 * afterwards was `revise` — which is the wrong tool here twice over. It prepends
 * *"Revision requested by the reviewer"* to the request, and no reviewer asked
 * for anything when an HTTP call failed; and it spends one of the run's revision
 * cycles, which a `standard` workflow only has two of.
 *
 * The stage is known — it is the one that had started — so the line can be
 * complete rather than a pointer to `--help`.
 *
 * Quiet when the failure happened before any stage began: there is nothing to
 * resume from, and a suggestion that cannot be followed is worse than none.
 */
export function resumeHint(stage: string | undefined, workflow?: WorkflowClass): string {
  if (stage === undefined) return '';

  // **Named rather than asserted** (D7). This said "the stages before this one are kept",
  // and a measured resume from `sdd` re-ran discovery — ten minutes of a frontier model,
  // because the resume point reaches only the two stages that go through
  // `stageOrExisting`. The fold in `core/resume.ts` is the single answer; this renders it.
  //
  // **And no default class** (D17). The parameter defaulted to `standard`, so the one
  // caller that had no class to give — the failure path, which is where this sentence is
  // read — printed the `standard` answer for every run. Measured on AF-2026-004, a
  // `high-risk` run: *"Kept: discovery, architecture-impact, sdd"*, and the resume it
  // suggested spent thirteen minutes of Opus re-running discovery. A default that is
  // right most of the time is how the fold's answer gets discarded at the surface; when
  // the class is unknown the clause is omitted, because no claim beats a wrong one.
  const resume = workflow === undefined ? undefined : planningResume(stage as RunStage, workflow);
  const kept =
    resume === undefined
      ? ''
      : resume.kept.length === 0
        ? 'Nothing before it is reused. '
        : `Kept: ${resume.kept.join(', ')}. `;
  const rerun =
    resume === undefined || resume.rerun.length === 0
      ? ''
      : `Runs again: ${resume.rerun.join(', ')}. `;

  return (
    `\n${kept}${rerun}Resume with:\n` +
    `  agent-flow feature "<same description>" --from ${stage}\n` +
    `\nUse \`revise\` instead only when the plan itself needs changing — it spends a\n` +
    `revision cycle and tells the planner a reviewer asked for the change.\n`
  );
}

/**
 * One line per stage. Delegates to the shared renderer — `run` had the identical
 * defect and the fix should not exist twice.
 */
export function writeStageProgress(stage: string, status: string, verbose: boolean): void {
  writeProgress(stage, status, verbose);
}

/**
 * `agent-flow revise "<instruction>"` — re-plan with extra guidance.
 *
 * Invalidates any approval before re-running. The gate is granted to a specific
 * plan (§17), so a plan produced after approval has not been through it — and
 * leaving the flag set would let unreviewed work execute.
 */

/**
 * Which stages a revision may re-enter, and why the list is two long rather than four.
 *
 * `planning` is the default and the common case: the finding is about the plan. `sdd` is
 * for a finding about the specification — the case that had no answer at all, where the
 * planner corrects the plan, the plan then contradicts a specification nothing can change,
 * and the next review rejects it for the contradiction. Measured: the cycle could not
 * converge, and the way out was a fresh run costing a full planning pass to change one row
 * of one table.
 *
 * `discovery` and `architecture-impact` are deliberately absent. Discovery is
 * feature-agnostic and cached across runs, so re-entering there is `--no-cache` on a fresh
 * run rather than a revision of this one — and offering the most expensive stage in the
 * product as a response to a review finding is not a kindness.
 */
const REVISABLE_STAGES = ['sdd', 'planning'] as const;

export interface ReviseCommandFlags extends InstructionFlags {
  readonly from?: string;
  /** `--decision`: replan without spending a revision cycle (FR-013). */
  readonly decision?: boolean;
  /** `--escalate`: replan one workflow class up, under its budget (FR-014). */
  readonly escalate?: boolean;
}

/** The seams a test replaces. The defaults are what every real invocation uses. */
export interface ReviseCommandDeps {
  readonly io: InstructionIO;
  readonly revise: typeof revise;
  readonly actionDeps: (globals: GlobalOptions) => RunActionDeps;
}

/**
 * Which budget mode the flags ask for, or the refusal of asking for two (FR-015).
 *
 * Refused here rather than in the use case because the use case cannot be asked it: `revise`
 * takes one mode, so "both" is a sentence only the command line can form. A decision spends
 * nothing inside the class and an escalation changes the class; picking one of them for the
 * operator would record a decision they did not make.
 */
export function reviseModeOf(
  flags: Pick<ReviseCommandFlags, 'decision' | 'escalate'>,
): { readonly ok: true; readonly mode: ReviseMode } | { readonly ok: false; readonly error: ActionError } {
  if (flags.decision === true && flags.escalate === true) {
    return {
      ok: false,
      error: {
        code: 'invalid_input',
        message:
          '--decision and --escalate are two different decisions: a decision replans within ' +
          'this workflow class, an escalation moves the run to the next one.',
        action: 'Choose one of them.',
      },
    };
  }
  if (flags.decision === true) return { ok: true, mode: 'decision' };
  if (flags.escalate === true) return { ok: true, mode: 'escalation' };
  return { ok: true, mode: 'revision' };
}

export async function runReviseCommand(
  flags: ReviseCommandFlags,
  globals: GlobalOptions,
  seams: ReviseCommandDeps = { io: nodeInstructionIO(), revise, actionDeps },
): Promise<ExitCodeValue> {
  try {
    // Validated before anything is read: a bad stage name should not open an editor.
    const from = flags.from ?? 'planning';
    if (!(REVISABLE_STAGES as readonly string[]).includes(from)) {
      process.stderr.write(
        `--from "${from}" is not a stage a revision can re-enter.\n` +
          `  Use one of: ${REVISABLE_STAGES.join(', ')}.\n` +
          `  A finding about the plan is "planning" (the default); one about the\n` +
          `  specification is "sdd", which re-runs planning after it.\n`,
      );
      return ExitCode.CONFIG_ERROR;
    }

    // Beside `--from`, and for the same reason: two budget modes at once is a refusal that
    // needs no state, so it must not cost an editor session or a state read.
    const chosen = reviseModeOf(flags);
    if (!chosen.ok) {
      process.stderr.write(`${render(chosen.error)}\n`);
      return exitCodeFor(chosen.error);
    }

    // AR-08: the instruction may arrive as an argument, a file, stdin or an editor buffer.
    // Which one is decided first because it is pure and free, and a bad invocation should
    // not reach the filesystem at all.
    const source = chooseInstructionSource(flags);
    if (source.kind === 'refused') {
      process.stderr.write(`${source.reason}\n`);
      return ExitCode.CONFIG_ERROR;
    }

    const deps = seams.actionDeps(globals);
    const runId = await currentRunId(deps);
    if (runId === null) {
      process.stderr.write('No active run to revise.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    // Read only once there is something to revise. `--edit` opens an editor and waits, and
    // asking someone to compose a revision for a run that does not exist is the kind of
    // wasted effort a check costing one state read prevents.
    const read = await readInstruction(source, seams.io);
    if (!read.ok) {
      process.stderr.write(`${read.reason}\n`);
      return ExitCode.CONFIG_ERROR;
    }
    const instruction = read.instruction;

    const outcome = await seams.revise(deps, runId, instruction, from as RunStage, chosen.mode);

    if (!outcome.ok) {
      process.stderr.write(`${render(outcome.error)}\n`);
      return exitCodeFor(outcome.error);
    }

    if (outcome.value.approvalCleared) {
      process.stdout.write('The previous approval no longer applies and has been cleared.\n\n');
    }

    process.stdout.write(
      [
        `${String(outcome.value.taskCount)} tasks planned.`,
        ...describeBudget(outcome.value),
        '',
        nextStepAfterPlanning(outcome.value.reviewVerdict),
        '',
      ].join('\n'),
    );

    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

/**
 * What the budget did, for the two modes that exist to not spend it (FR-021).
 *
 * Said back because it is the whole point of the flag: an operator who typed `--decision`
 * at the ceiling needs to see the count did not move, or they will assume it did and stop
 * making decisions. A plain revision prints nothing new, so its output is today's.
 */
function describeBudget(result: ReviseResult): string[] {
  if (result.mode === undefined) return [];

  const count =
    result.revisionCount === undefined || result.maxAllowed === undefined
      ? []
      : [
          `Revision count unchanged: ${String(result.revisionCount)} of ${String(result.maxAllowed)}.`,
        ];

  if (result.mode === 'decision') return ['', 'Decision recorded.', ...count];

  const moved =
    result.fromWorkflow === undefined || result.toWorkflow === undefined
      ? []
      : [`Workflow class: ${result.fromWorkflow} → ${result.toWorkflow}.`];
  return ['', 'Escalation recorded.', ...moved, ...count];
}

/**
 * The four sources, wired to the machine.
 *
 * `$VISUAL` before `$EDITOR` before `vi`, which is the order every other tool that opens an
 * editor uses. `stdio: 'inherit'` because the editor owns the terminal while it runs.
 *
 * Exported for `answer` (P7.1), which reads its text through the same four sources. `what`
 * is the word in the editor's header, so a person answering a task is not told to write a
 * revision.
 */
export function nodeInstructionIO(what = 'revision'): InstructionIO {
  return {
    readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
    readStdin: async () => {
      let text = '';
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) text += chunk as string;
      return text;
    },
    openEditor: async () => {
      const file = join(mkdtempSync(join(tmpdir(), 'agent-flow-revise-')), 'INSTRUCTION.md');
      writeFileSync(
        file,
        [
          '',
          `# Write the ${what} below. Lines starting with # are ignored.`,
          '# Save an empty file to cancel.',
          '',
        ].join('\n'),
        'utf8',
      );

      const editor = process.env['VISUAL'] ?? process.env['EDITOR'] ?? 'vi';
      const result = spawnSync(editor, [file], { stdio: 'inherit', shell: true });
      if (result.status !== 0) return '';

      return readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !line.startsWith('#'))
        .join('\n');
    },
  };
}

function parseStage(value: string): RunStage {
  const result = RunStageSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Unknown stage "${value}". Valid values: discovery, architecture-impact, sdd, planning.`,
    );
  }
  return result.data;
}

/**
 * `--dry-run`: what would run, and on what.
 *
 * With the default configuration a feature costs four heavy calls before a line
 * of code exists. Being able to see the routing without spending any of it is
 * worth the few lines this takes (R-08).
 */
function printExecutionPlan(
  config: Parameters<typeof resolveRole>[1],
  capabilities: Parameters<typeof resolveRole>[2],
  globals: GlobalOptions,
): void {
  const stages: Array<[string, Parameters<typeof resolveRole>[0]]> = [
    ['discovery', 'architect'],
    ['architecture-impact', 'architect'],
    ['sdd', 'sdd'],
    ['planning', 'planner'],
  ];

  process.stdout.write(`Execution plan for ${globals.cwd}\n\n`);

  for (const [stage, role] of stages) {
    const resolved = resolveRole(role, config, capabilities, { readOnly: true });
    const model = resolved.model ?? '(runner default)';
    const clamped = resolved.reasoningClamped ? ' [clamped]' : '';
    process.stdout.write(
      `  ${stage.padEnd(20)} ${role.padEnd(12)} ${resolved.runner.padEnd(10)} ` +
        `${model.padEnd(20)} ${resolved.reasoning}${clamped}\n`,
    );
  }

  process.stdout.write('\nNo runner was invoked.\n');
}

/**
 * What to do next, given what the review actually said.
 *
 * Written as one function because the previous version was a constant string:
 * a run whose plan review returned FAIL still closed with "Then: agent-flow
 * approve", and following that advice hits a gate that refuses. The verdict was
 * printed three lines above and never consulted.
 *
 * `--force` is named rather than hidden. It exists, it is recorded on the run,
 * and someone who has read the findings is entitled to overrule them; omitting
 * it would be its own kind of misdirection.
 */
export function nextStepAfterPlanning(verdict: 'PASS' | 'FAIL' | undefined): string {
  if (verdict !== 'FAIL') return 'Then: agent-flow approve';

  return [
    'The automated review rejected this plan. Its findings are in `agent-flow status`.',
    '',
    'Fix the plan with: agent-flow revise "<instruction>"',
    'Or approve anyway with: agent-flow approve --force  (recorded on the run)',
  ].join('\n');
}

/**
 * The checks the plan says a person must make, one line each (FR-020).
 *
 * Printed because nothing else will ask for them: an operator verification is never a task,
 * so no scheduler runs it and no gate waits on it. The Deck's run detail has no plan-level
 * field either (R-7), which leaves this output and `plan.json` as the places a person meets
 * them. Whitespace is collapsed so a check written across lines still prints as one line.
 *
 * Empty when the plan has none, so the output for every plan without them is unchanged.
 */
export function operatorVerificationLines(plan: Plan): string[] {
  const items = plan.operatorVerifications ?? [];
  if (items.length === 0) return [];

  const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
  return [
    'Operator verifications — the executor cannot make these; check them yourself:',
    ...items.map((item) => `  - ${oneLine(item.check)} (${oneLine(item.reason)})`),
    '',
  ];
}

/**
 * The class this run planned under, where it came from, the words that decided it, and how
 * to correct it (FR-015).
 *
 * `feature` printed nothing about the class, so a request that tripped a bare `token` was
 * planned `high-risk` — a full discovery on a frontier model and a strict review — with the
 * operator told nothing until they read `workflow_classified` in the event log. The excerpt
 * is what makes the class checkable: a person can see at once whether "token" was the thing
 * the change does or a word in a sentence saying it does not touch one.
 *
 * The hint follows what can actually correct it. `--workflow` cannot lower a class that
 * high-risk signals decided (`adaptive-workflow.ts`, the no-downgrade invariant), so that
 * case is told to rephrase instead. A `high-risk` class with no signal behind it was chosen,
 * not detected, so a new run with `--workflow` does lower it; `revise --escalate` is left out
 * there because `high-risk` is the ceiling it would refuse at.
 */
export function classificationLines(classification: WorkflowClassificationResult): string[] {
  const { workflow, origin, detected, requested } = classification;
  const raised = requested !== undefined && requested !== workflow;
  const from =
    origin === 'detected'
      ? 'detected from the request'
      : raised
        ? `${origin === 'operator' ? 'the operator asked for' : 'carried over as'} ${requested}, ` +
          'raised by high-risk signals'
        : origin === 'operator'
          ? `set by the operator; the request alone classifies as ${detected}`
          : 'carried over from the earlier classification';

  const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const named = (entry: WorkflowEvidence): string =>
    entry.file === undefined ? entry.signal : `${entry.signal} (file: ${entry.file})`;
  const evidence = classification.evidence.map((entry) =>
    entry.negated === true
      ? `  Not counted (negated) — ${named(entry)}: "${oneLine(entry.excerpt)}"`
      : `  Decided by ${named(entry)}: "${oneLine(entry.excerpt)}"`,
  );

  const decidedByRisk = workflow === 'high-risk' && classification.highRiskSignalsDetected.length > 0;
  const hint = decidedByRisk
    ? [
        '  A high-risk class cannot be lowered with --workflow. If the quoted mention is not',
        '  what this change does, rephrase the request and start a new run.',
      ]
    : [
        '  To correct it, start a new run with:',
        `    agent-flow feature "<description>" --workflow <class>`,
        ...(workflow === 'high-risk'
          ? []
          : ['  or, before any task runs:', `    agent-flow revise --escalate "<why>"`]),
      ];

  return [`Workflow: ${workflow} — ${from}.`, ...evidence, ...hint, ''];
}

// `createRunWithIdentity` lives in `app/run-actions.ts` now: the dashboard creates runs
// too, and what a run is born with has to be decided in one place.
