import { resolve as resolvePath } from 'node:path';
import { ReviewResultSchema, type ReviewResult } from '../contracts/index.js';
import { review, type ReviewOutcome, type RunActionDeps } from '../app/run-actions.js';
import { nodeInstructionIO } from './feature.js';
import {
  OBSERVATION_WORDING,
  readInstruction,
  type InstructionIO,
} from './instruction-source.js';
import type { CorrectiveRound } from '../app/corrective-round.js';
import {
  SHORT_HEAD_LENGTH,
  type checkDefinitionOfDone,
  type MechanicalVerification,
} from '../core/definition-of-done.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import { actionDeps, currentRunId, exitCodeFor, printWarnings, render } from './approve.js';
import type { GlobalOptions } from './index.js';

/**
 * `agent-flow review` — verification, final review, and the Definition of Done.
 *
 * A thin adapter since M2-06, and for two reasons rather than tidiness.
 *
 * The workflow *moves the run*: it writes `verification.json` and
 * `final-review.json`, and it sets the run's stage and status. Under MVP 2 it
 * also runs `lint · typecheck · test · build` inside the **integration worktree**
 * — the same checkout the Integrator merges into — which is why it now takes the
 * run execution lease in worktree mode and answers `run_busy` to a second caller
 * (§18.2, §19.1). None of that can live in a command handler that only the
 * terminal can reach.
 *
 * So the decisions are in `app/run-actions.ts`, which the local server calls too,
 * and what is left here is what a CLI is for: turning an outcome into words and
 * an exit code.
 */
export interface ReviewCommandOptions {
  readonly fix?: boolean;
  /** `--e2e-observed "<text>"`, or `-` to read stdin. */
  readonly e2eObserved?: string;
  /** `--e2e-observed-file <path>`, for an observation a shell argument would mangle. */
  readonly e2eObservedFile?: string;
  /** `--observed-by <name>`: the human who observed it. Required with an observation. */
  readonly observedBy?: string;
  /** `--e2e-head <sha>`: the build the human tested, checked against the head under review. */
  readonly e2eHead?: string;
  /** `--evidence <files...>`: images of what the human saw, copied into the run (dogfood 09/10). */
  readonly evidence?: readonly string[];
}

type ObservationInput = {
  readonly by: string;
  readonly words: string;
  readonly head?: string;
  readonly evidence?: readonly string[];
};

/** The seams a test replaces. The defaults are what every real invocation uses. */
export interface ReviewCommandDeps {
  readonly io: InstructionIO;
  readonly actionDeps: (globals: GlobalOptions) => RunActionDeps;
}

/**
 * The observation — the human's words from exactly one of the two text flags, their name,
 * and the build they tested — or none, when no observation flag was given. Read before
 * anything about the run, as `answer` reads its text (FR-001).
 *
 * **A name is required.** The run records this terminal as `keyboard`, which an AI driving
 * the CLI is too, so the name is the only thing that says a person saw it. The name's bound
 * and the words' are the use case's to judge (`HumanDecision`); here only presence.
 */
export async function readObservation(
  options: ReviewCommandOptions,
  io: InstructionIO,
): Promise<{ ok: true; observation?: ObservationInput } | { ok: false; reason: string }> {
  const textGiven = options.e2eObserved !== undefined || options.e2eObservedFile !== undefined;
  const evidenceGiven = (options.evidence ?? []).length > 0;
  if (!textGiven && (options.observedBy !== undefined || options.e2eHead !== undefined || evidenceGiven)) {
    return {
      ok: false,
      reason:
        '--observed-by, --e2e-head and --evidence describe an observation: give it with --e2e-observed ' +
        '"<their words>" or --e2e-observed-file <path>.',
    };
  }
  if (textGiven && (options.observedBy === undefined || options.observedBy.trim() === '')) {
    return {
      ok: false,
      reason:
        'Name the human who observed it: --observed-by "<their name>". ' +
        'agent-flow records this terminal as keyboard, so the name is what says a person saw it.',
    };
  }
  if (options.e2eObserved !== undefined && options.e2eObservedFile !== undefined) {
    return {
      ok: false,
      reason:
        'Give the observation one way only: --e2e-observed "<text>" (or - for stdin), ' +
        'or --e2e-observed-file <path>.',
    };
  }
  const source =
    options.e2eObservedFile !== undefined
      ? { kind: 'file' as const, path: options.e2eObservedFile }
      : options.e2eObserved === '-'
        ? { kind: 'stdin' as const }
        : options.e2eObserved !== undefined
          ? { kind: 'argument' as const, instruction: options.e2eObserved }
          : undefined;
  if (source === undefined) return { ok: true };

  const read = await readInstruction(source, io, OBSERVATION_WORDING);
  if (!read.ok) return { ok: false, reason: read.reason };
  const head = options.e2eHead?.trim();
  return {
    ok: true,
    observation: {
      by: (options.observedBy ?? '').trim(),
      words: read.instruction,
      ...(head === undefined ? {} : { head }),
      ...(evidenceGiven ? { evidence: [...(options.evidence ?? [])] } : {}),
    },
  };
}

export async function runReviewCommand(
  options: ReviewCommandOptions,
  globals: GlobalOptions,
  seams: ReviewCommandDeps = { io: nodeInstructionIO('observation'), actionDeps },
): Promise<ExitCodeValue> {
  try {
    const observation = await readObservation(options, seams.io);
    if (!observation.ok) {
      process.stderr.write(`${observation.reason}\n`);
      return ExitCode.CONFIG_ERROR;
    }

    const deps = seams.actionDeps(globals);
    const runId = await currentRunId(deps);
    if (runId === null) {
      process.stderr.write('No active run.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    const outcome = await review(deps, runId, {
      ...(options.fix === undefined ? {} : { fix: options.fix }),
      ...(observation.observation === undefined
        ? {}
        : {
            e2eObservation: {
              ...observation.observation,
              // Relative to where the command was typed, as a person reads a path they typed.
              ...(observation.observation.evidence === undefined
                ? {}
                : { evidence: observation.observation.evidence.map((file) => resolvePath(globals.cwd, file)) }),
            },
          }),
      onStage: (stage) => {
        process.stdout.write(`${STAGE_HEADINGS[stage]}\n`);
      },
      onVerificationStep: (step, passed) => {
        process.stdout.write(`  ${passed ? '✓' : '✗'} ${step}\n`);
      },
    });

    printWarnings(outcome);

    if (!outcome.ok) {
      process.stderr.write(`${render(outcome.error)}\n`);
      return exitCodeFor(outcome.error);
    }

    process.stdout.write(`\n${renderOutcome(outcome.value)}\n`);

    if (outcome.value.observationRecorded !== undefined) {
      process.stdout.write(
        `\nThe observation was recorded as ${outcome.value.observationRecorded.amendmentId}` +
          (outcome.value.integration === undefined
            ? ', for this review only (sequential mode names no commit).\n'
            : `, for ${outcome.value.integration.head}.\n`),
      );
    }

    if (outcome.value.done.done) return ExitCode.OK;

    if (outcome.value.awaitingObservation === true) {
      process.stdout.write(
        `\n${awaitingObservationText(outcome.value.integration?.head)}\n` +
          (options.fix === true ? '\n--fix ran no corrective round: no task can reach the target.\n' : ''),
      );
    } else if (outcome.value.corrective !== undefined) {
      process.stdout.write(`\n${renderCorrectiveRound(outcome.value.corrective)}\n`);
    }

    return ExitCode.GATE_NOT_SATISFIED;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

/**
 * What review says when e2e NOT_RUN is all that is missing. A FIX task cannot reach a
 * device; a person holding one can.
 *
 * **Addressed to the reader, who is usually an AI — so it asks for the human.** The first
 * version said "exercise the change on the target yourself, then record what you saw",
 * which told an AI to attest on its own observation. It names the build, so the human can
 * confirm the one they test is the one under review.
 */
export function awaitingObservationText(head: string | undefined): string {
  const short = head?.slice(0, SHORT_HEAD_LENGTH);
  const headFlag = short === undefined ? '' : ` --e2e-head ${short}`;
  return [
    'Only the e2e observation is missing: agent-flow could not exercise the change on its',
    'target, and reviewing again will not change that.',
    '',
    ...(short === undefined
      ? [
          'Ask the human to exercise the change on the target. No commit names this tree, so',
          'their observation counts only for the review it is recorded with.',
        ]
      : [`Ask the human to exercise build ${short} on the target and confirm it is that build.`]),
    'Then record their words and their name, quoted:',
    '',
    `  agent-flow review --e2e-observed "<their words>" --observed-by "<their name>"${headFlag}`,
    `  agent-flow review --e2e-observed-file <path> --observed-by "<their name>"${headFlag}`,
  ].join('\n');
}

const STAGE_HEADINGS = {
  verification: 'Running validation commands',
  inspection: '\nInspecting the implementation',
  e2e: '\nRunning e2e browser tests',
  'final-review': 'Reviewing against the approved SDD',
} as const;

/**
 * Everything the review found, in the order a person reads it.
 *
 * The degradations come before the verdict on purpose. This is the screen that
 * says FEATURE COMPLETE, and a run that fell back to another provider, ran below
 * its configured effort or reviewed itself reached that verdict on weaker terms
 * — the person reading the verdict is the one who needs to know it (R-16).
 *
 * Exported so a test can read the words a person reads (FR-030), over an outcome the real
 * `review` produced, rather than re-deriving them from the Definition of Done.
 */
export function renderOutcome(outcome: ReviewOutcome): string {
  const lines: string[] = [];

  if (outcome.degradations.length > 0) {
    lines.push('This run was degraded:');
    for (const degradation of outcome.degradations) {
      lines.push(`  · ${degradation.reason}`, `    ${degradation.impact}`);
    }
    lines.push('');
  }

  lines.push(
    renderReview(
      {
        verdict: outcome.mechanicalVerification,
        ...(outcome.environmentFailure === undefined
          ? {}
          : { environmentFailure: outcome.environmentFailure }),
      },
      outcome.verificationReview,
      outcome.finalReview,
      outcome.done,
    ),
  );

  // What the e2e agent saved, where a person can open it (dogfood 09/10). Run-relative on
  // disk, so the path printed is the one under the project the command ran in.
  if (outcome.e2eEvidence !== undefined && outcome.e2eEvidence.length > 0) {
    lines.push('', 'E2E screenshots:');
    for (const path of outcome.e2eEvidence) lines.push(`  .agent-flow/runs/${outcome.runId}/${path}`);
  }

  // §19.3: the product of an isolated run is a branch, and the last thing the
  // command prints has to say where the code is. The user's working tree was not
  // modified, and the only way they find out is if the tool says so.
  if (outcome.integration !== undefined) {
    lines.push(
      '',
      `  branch     ${outcome.integration.branch}`,
      `  verified   ${outcome.integration.head}`,
      '',
      'Your working tree was not modified.',
      '',
      `  Review it:   git log --oneline ${outcome.integration.branch}`,
      `  Take it:     git merge ${outcome.integration.branch}`,
    );
  }

  return lines.join('\n');
}

/**
 * What the corrective round did, and what the person should do next.
 *
 * The old copy ended with "Next: agent-flow approve" while the gate refused that
 * exact command, because the corrected plan had no review. Now it says what is
 * true of the plan actually on disk.
 */
function renderCorrectiveRound(round: CorrectiveRound): string {
  if (round.outcome === 'nothing_actionable') {
    return 'No finding was severe enough to become a task.';
  }

  if (round.outcome === 'invalid_plan') {
    return [
      'The corrective tasks would not produce a valid plan, so nothing was written:',
      '',
      ...round.problems.map((problem) => `  - ${problem}`),
    ].join('\n');
  }

  const lines = [
    `${String(round.added.length)} corrective task(s) added to the plan.`,
    '',
    ...round.added.map((task) => `  ${task.id}  ${task.title}`),
    '',
    'They re-enter the same pipeline — routed, executed and validated like',
    'any other task, rather than patched straight into the code.',
    '',
    'The approval was reopened, because the plan is no longer the one that',
    'was approved. The corrected plan was reviewed in its own right:',
    '',
    `  Plan review: ${round.review.verdict}`,
    // One provider is the operator's choice (23/09/2026): said when it is not the case,
    // never warned about when it is.
    ...(round.review.independence === 'cross-provider'
      ? ['  reviewed by a different provider from the planner and the reviewer']
      : []),
  ];

  for (const finding of round.review.findings) {
    lines.push(`  [${finding.severity}] ${finding.description}`);
  }

  lines.push('');
  lines.push(
    round.review.verdict === 'PASS'
      ? 'Next: agent-flow approve, then agent-flow run'
      : 'The review rejected the corrected plan. Revise it with: agent-flow revise "<instruction>"',
  );

  return lines.join('\n');
}

/**
 * Four verdicts, four labels (AD-45, C-11, I-24).
 *
 * The line this replaces read `Verification: ${verification.verdict}` — **the model's**
 * verdict — printed directly beneath four mechanical `✗` marks from `onVerificationStep`.
 * Two different questions with two different authorities, rendered under one label with
 * opposite answers. The Definition of Done was correct; the rendering was not, and the
 * operator reasonably concluded the tool was lying.
 */
function renderReview(
  mechanical: {
    verdict: MechanicalVerification;
    environmentFailure?: { phase: string; detail: string };
  },
  verification: { verdict: string; findings: ReviewResult['findings'] },
  finalReview: ReviewResult,
  done: ReturnType<typeof checkDefinitionOfDone>,
): string {
  const lines: string[] = [];

  // Exit codes, and it says so. `NOT_RUN` is visually distinct from `FAIL` because they
  // send a person to two different places.
  lines.push(`Mechanical verification (exit codes): ${mechanical.verdict}`);
  if (mechanical.verdict === 'NOT_RUN') {
    lines.push(
      '  ⚠ the commands never ran — this is environment readiness, not a regression',
      ...(mechanical.environmentFailure === undefined
        ? []
        : [`  ${mechanical.environmentFailure.phase}: ${mechanical.environmentFailure.detail}`]),
      '  Check `commands.install` in .agent-flow/config.yaml, then run `agent-flow doctor`.',
    );
  }

  lines.push('', `Semantic review (model, advisory): ${verification.verdict}`);
  if (mechanical.verdict === 'NOT_RUN') {
    // Suppressed as a conclusion rather than hidden: it was formed against an environment
    // that could not answer, and saying so is more useful than deleting it.
    lines.push('  ⚠ not a conclusion about the code: the commands could not run');
  }
  for (const finding of verification.findings) {
    lines.push(`  [${finding.severity}] ${finding.description}`);
  }

  lines.push('', `Final review (model, advisory): ${finalReview.verdict}`);
  if (finalReview.independence === 'cross-provider') {
    lines.push('  reviewed by a different provider from the implementer');
  }
  for (const finding of finalReview.findings) {
    lines.push(`  [${finding.severity}] ${finding.description}`);
    lines.push(`      → ${finding.suggestedAction}`);
  }

  lines.push('', 'Definition of Done:');
  for (const condition of done.conditions) {
    const detail = condition.detail === undefined ? '' : ` — ${condition.detail}`;
    lines.push(`  ${condition.met ? '✓' : '✗'} ${condition.name}${detail}`);
  }

  lines.push('');
  lines.push(done.done ? 'FEATURE COMPLETE' : 'NOT DONE');

  if (!done.done) {
    // Stated plainly, because a confident agent saying "finished" is exactly
    // what §42 exists to overrule.
    lines.push('', `Outstanding: ${done.missing.join(', ')}`);
  }

  return lines.join('\n');
}

export { ReviewResultSchema };
