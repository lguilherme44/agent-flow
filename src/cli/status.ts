import { PlanSchema, ReviewResultSchema, type RunState } from '../contracts/index.js';
import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { SystemClock } from '../adapters/clock/system-clock.js';
import { StateStore } from '../app/state-store.js';
import { PLANNING_STAGES } from '../app/planning-pipeline.js';
import { collectTelemetry } from '../app/telemetry.js';
import { summariseTelemetry } from '../core/telemetry.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import { renderEscalation } from './render/escalation.js';
import { projectRun, type RunProjection } from '../core/run-projection.js';
import { loadConfig } from '../config/loader.js';
import { describeIsolation, type IsolationReport } from '../app/run-git-identity.js';
import { integrationRef } from '../core/worktree-policy.js';
import { CollaborationStore } from '../app/collaboration-store.js';
import { renderCollaboration } from './render/collaboration.js';
import { renderTeam } from './render/team.js';
import { renderReview } from './render/review.js';
import { projectReviews } from '../core/review/view.js';
import { ReviewStore } from '../app/review-store.js';
import { projectTeam } from '../core/team/view.js';
import { deriveAgentRoster } from '../core/collaboration/roster.js';
import { projectThreads } from '../core/collaboration/threads.js';
import { projectHandoffs } from '../core/collaboration/handoffs.js';
import { projectBlackboard } from '../core/collaboration/blackboard.js';
import type { GlobalOptions } from './index.js';

const STAGE_LABELS: Record<string, string> = {
  discovery: 'Discovery',
  'architecture-impact': 'Architecture',
  sdd: 'SDD',
  planning: 'Task Planning',
  'plan-review': 'Plan Review',
};

/**
 * `agent-flow status` — where is this run, and what should worry me?
 *
 * Shows degradations alongside progress. A run that produced a same-provider
 * review is not in the same state as one that did not, and status is where
 * someone looks before deciding whether to approve.
 */
export async function runStatusCommand(globals: GlobalOptions): Promise<ExitCodeValue> {
  const fs = new NodeFileSystem();
  const store = new StateStore({ fs, clock: new SystemClock(), projectDir: globals.cwd });

  try {
    const state = await store.loadCurrentRun();

    if (state === null) {
      process.stdout.write(
        'No active run.\n\nStart one with: agent-flow feature "<description>"\n',
      );
      return ExitCode.OK;
    }

    // What finished, from the log that records completion — see
    // `renderPlanningProgress` for why `state.stage` cannot answer this.
    const events = await store.readEvents(state.runId);
    const stagesOf = (type: string): string[] =>
      events
        .filter((event) => event.type === type)
        .map((event) => event.detail['stage'])
        .filter((stage): stage is string => typeof stage === 'string');

    const completedStages = stagesOf('stage_completed');
    // What has begun, for the `…` marker — see `renderPlanningProgress`.
    const startedStages = stagesOf('stage_started');
    // Reuse is recorded too, and a stage served from cache is not a stage pending.
    const reusedStages = stagesOf('stage_reused');
    // Already on the event, never on a screen until now.
    const contextBytes = new Map<string, number>();
    for (const event of events) {
      if (event.type !== 'stage_context_measured') continue;
      const stage = event.detail['stage'];
      const bytes = event.detail['totalBytes'];
      if (typeof stage === 'string' && typeof bytes === 'number') contextBytes.set(stage, bytes);
    }

    const planRaw = await store.readArtifact(state.runId, 'plan');
    const reviewRaw = await store.readArtifact(state.runId, 'planReview');
    const plan = planRaw === null ? null : PlanSchema.safeParse(JSON.parse(planRaw));
    const review = reviewRaw === null ? null : ReviewResultSchema.safeParse(JSON.parse(reviewRaw));

    if (globals.json) {
      // Telemetry rides along with `--json` only. It is operational detail —
      // where the time went, who actually ran, what fell back — and the human
      // rendering below is about whether this run can move forward.
      const telemetry = await collectTelemetry(store, state);

      process.stdout.write(
        `${JSON.stringify(
          {
            ...state,
            taskCount: plan?.success ? plan.data.tasks.length : 0,
            completedStages,
            review: review?.success ? review.data : null,
            telemetry: { entries: telemetry, summary: summariseTelemetry(telemetry) },
          },
          null,
          2,
        )}\n`,
      );
      return ExitCode.OK;
    }

    // Read for display only. `status` reports what the configuration currently
    // says; it never uses it to decide anything about this run — that was
    // settled when the run was created (I-13). An unreadable configuration
    // costs the isolation line and nothing else.
    const isolation = await describeIsolationFor(state, fs, globals);

    // §15's record, read from the audit trail to *render* it. `events.jsonl` is
    // never a decision input (I-1); showing what it logged is exactly what it is
    // for, and the paths it holds are repository-relative.
    const conflicts = (await store.readEvents(state.runId))
      .filter((event) => event.type === 'integration_conflict')
      .map((event) => ({
        task: String(event.detail['task'] ?? ''),
        attempt: Number(event.detail['attempt'] ?? 0),
        paths: Array.isArray(event.detail['paths'])
          ? event.detail['paths'].filter((path): path is string => typeof path === 'string')
          : [],
      }));

    // Computed before rendering rather than after (C-19, C-20): the headline and its
    // hint come from what the run is doing *now*, not from the last gate it persisted.
    // `state.status` alone is a record of that gate — it stays `plan_rejected` while a
    // revision is already running, and `approved` for the whole of implementation.
    const runtime = projectRun({
      state,
      ...(plan?.success === true
        ? {
            nodes: plan.data.tasks.map((task) => ({
              id: task.id,
              dependencies: [...task.dependencies],
            })),
          }
        : {}),
      events: await store.readEventsBestEffort(state.runId),
    });

    // M4-07. Read through the same projections the prompt was built from and the
    // dashboard renders, so three surfaces cannot describe one thread differently.
    const collaboration = await readCollaboration(store, state, fs, globals);

    // M5-ACC-15, and the same rule the line above follows: folded by `core/team/view.ts`,
    // which is what the API returns and what the dashboard draws.
    const team = await readTeam(store, state, fs, globals);

    // M6-ACC-21, and the same rule the two lines above follow: folded by
    // `core/review/view.ts`, which is what the API returns and the dashboard draws.
    const codeReview = await readCodeReview(store, state, fs, globals);

    process.stdout.write(
      `${render(
        state,
        runtime,
        plan?.success ? plan.data.tasks.length : 0,
        review?.success ? review.data : null,
        completedStages,
        isolation,
        conflicts,
        collaboration,
        team,
        codeReview,
        startedStages,
        reusedStages,
        contextBytes,
      )}\n`,
    );

    // C-22, at the one surface a person is most likely to be looking at when a run stops.
    // Rendered after the run summary rather than instead of it: the escalation says what to
    // do, and the summary is the context that makes the instruction make sense.
    if (runtime.escalation !== undefined) {
      process.stdout.write(`\n${renderEscalation(runtime.escalation)}\n`);
    }

    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

/**
 * One line per planning stage, marked by what actually finished.
 *
 * Derived from `stage_completed` events rather than from `state.stage`, because
 * `state.stage` cannot answer the question. `createRun` initialises it to
 * `discovery`, and the stage runner writes the same value again once discovery
 * succeeds — so "about to start" and "finished" are the identical byte on disk.
 * A run killed during its first stage reported `Discovery ✓`.
 *
 * The third marker matters as much as the other two. A killed process leaves
 * `status: running` on disk, and a stage that is neither finished nor actually
 * executing must not be dressed as either.
 */
export function renderPlanningProgress(
  completedStages: readonly string[],
  currentStage: string,
  status: RunState['status'],
  startedStages: readonly string[] = [],
  reusedStages: readonly string[] = [],
  /**
   * Prompt size per stage, from `stage_context_measured` (AR-09).
   *
   * Recorded on every run since the event existed and surfaced nowhere: on a live run the
   * prompt went from 3.9 KB at discovery to 57.4 KB at plan-review, fifteen-fold, and the
   * only way to see it was to parse `events.jsonl` by hand. It is the number that predicts
   * what a stage costs, and the 80% window warning that would otherwise catch this is
   * inert — it needs a `contextWindow` no runner declares.
   */
  contextBytes: ReadonlyMap<string, number> = new Map(),
): string[] {
  const done = new Set(completedStages);
  const begun = new Set(startedStages);
  const reused = new Set(reusedStages);
  const sized = (stage: string): string => {
    const bytes = contextBytes.get(stage);
    return bytes === undefined ? '' : `  ${(bytes / 1024).toFixed(1)} KB in`;
  };

  return PLANNING_STAGES.map((stage) => {
    const label = STAGE_LABELS[stage] ?? stage;

    if (done.has(stage)) return `  ${label.padEnd(16)}✓${sized(stage)}`;

    // A stage served from cache is satisfied, and printing `·` for it says the
    // opposite. Measured on a real run: discovery came from the fingerprint cache
    // and `status` marked it identically to the stages that had not begun.
    //
    // `✓` with the provenance beside it, rather than a fourth symbol: the mark
    // answers "is this done", the suffix answers "did this run do it" — the same
    // split the dashboard makes with a solid marker in a different tone.
    if (reused.has(stage)) return `  ${label.padEnd(16)}✓ (cached)`;

    // `state.stage` lags behind the log, and the `…` was the casualty. Observed
    // on a real run: the field read `architecture-impact` while `stage_started`
    // for `sdd` was already written and the model was generating — so `sdd`
    // printed `·`, the same mark as the four stages that had not begun.
    //
    // A `stage_started` with no `stage_completed` after it is the stage in
    // flight. The field stays as a fallback for the window before any event
    // exists, exactly as `buildStageTimeline` resolves the same question.
    const running = (begun.has(stage) || stage === currentStage) && status === 'running';
    return `  ${label.padEnd(16)}${running ? '…' : '·'}`;
  });
}

async function describeIsolationFor(
  state: RunState,
  fs: NodeFileSystem,
  globals: GlobalOptions,
): Promise<IsolationReport | null> {
  try {
    const config = await loadConfig({
      fs,
      globalConfigPath: globals.globalConfigPath,
      projectDir: globals.cwd,
    });
    return describeIsolation(state, config);
  } catch {
    return null;
  }
}

/**
 * What an isolated run is doing (§21.4).
 *
 * Four facts, and each answers a question sequential mode never raised: which
 * branch the product is on, how many tasks are actually *integrated* rather than
 * merely finished (I-3), which attempt each task is on, and — for a halted run —
 * which files an integration conflict named.
 *
 * **The branch name is derived from `gitRunKey`, never stored** (§5.3), and no
 * absolute path appears: a worktree path is a machine fact the artifact
 * deliberately does not record (§7.2, §21.3).
 */
export function renderIsolatedProgress(
  state: RunState,
  conflicts: readonly { task: string; attempt: number; paths: readonly string[] }[],
): string[] {
  if (state.isolationMode !== 'worktree') return [];

  const branch = state.gitRunKey === undefined ? undefined : integrationRef(state.gitRunKey);
  const integrated = state.tasks.filter((task) => task.state === 'completed').length;

  const lines: string[] = ['ISOLATION', ''];

  if (branch?.ok === true) lines.push(`  branch          ${branch.value}`);
  if (state.integrationHead !== undefined) {
    lines.push(`  integrated at   ${state.integrationHead.slice(0, 8)}`);
  }
  lines.push(`  integrated      ${String(integrated)} of ${String(state.tasks.length)} task(s)`);

  // Per-task attempt numbers, and only where they are interesting: a task on its
  // first attempt is the normal case, and a column of "1" teaches nobody anything.
  const retried = state.tasks.filter((task) => task.attempts > 1);
  if (retried.length > 0) {
    lines.push('  attempts');
    for (const task of retried) {
      lines.push(`    ${task.id.padEnd(12)}${String(task.attempts)}`);
    }
  }

  if (conflicts.length > 0) {
    lines.push('  integration conflicts');
    for (const conflict of conflicts) {
      lines.push(
        `    ${conflict.task} attempt ${String(conflict.attempt)} — ` +
          `${conflict.paths.slice(0, 5).join(', ')}`,
      );
    }
    lines.push(
      '    two tasks changed the same lines. Revise the plan so they are genuinely',
      '    independent, or make one depend on the other, then: agent-flow retry <task>',
    );
  }

  lines.push('');
  return lines;
}

export function render(
  state: RunState,
  runtime: RunProjection,
  taskCount: number,
  review: ReturnType<typeof ReviewResultSchema.parse> | null,
  completedStages: readonly string[],
  isolation: IsolationReport | null,
  conflicts: readonly { task: string; attempt: number; paths: readonly string[] }[],
  collaboration: string | undefined,
  team?: string | undefined,
  codeReview?: string | undefined,
  /** Stages with a `stage_started` event — see `renderPlanningProgress`. */
  startedStages: readonly string[] = [],
  reusedStages: readonly string[] = [],
  contextBytes: ReadonlyMap<string, number> = new Map(),
): string {
  const lines: string[] = [
    `Feature: ${state.feature}`,
    `Run: ${state.runId}`,
    '',
    'PLANNING',
    '',
  ];

  lines.push(...renderPlanningProgress(completedStages, state.stage, state.status, startedStages, reusedStages, contextBytes));

  lines.push(`  ${'Approval'.padEnd(16)}${state.approved ? '✓' : '·'}`);
  lines.push('');

  // §21.4: the run's mode and the current configuration are two different facts,
  // and a run created before a flag was flipped is not governed by it. Shown
  // always rather than only on a mismatch, so that "worktree" on this screen is
  // a statement about the run rather than an echo of a setting.
  if (isolation !== null) {
    lines.push(`Isolation: ${isolation.runMode ?? 'legacy'}  (captured when this run was created)`);
    lines.push(`  configuration now says useWorktrees: ${String(isolation.configuredWorktrees)}`);
    if (isolation.note !== undefined) lines.push(`  ${isolation.note}`);
    lines.push('');
  }

  if (taskCount > 0) lines.push(`${String(taskCount)} tasks`, '');

  // §21.4: what an isolated run is actually doing. Shown only in worktree mode,
  // because in sequential mode there is no branch, no attempt numbering worth
  // reading, and nothing waiting to be integrated — printing empty headings there
  // would be the tool describing machinery a user never turned on.
  lines.push(...renderIsolatedProgress(state, conflicts));

  if (review !== null) {
    lines.push(`Plan review: ${review.verdict}`);
    // Stated plainly rather than buried: a same-provider review is a weaker
    // guarantee, and this is where someone decides whether to trust it.
    lines.push(
      review.independence === 'cross-provider'
        ? '  reviewed by a different provider from the planner'
        : '  ⚠ same-provider review — no protection against a repeated assumption',
    );
    if (review.findings.length > 0) {
      lines.push(`  ${String(review.findings.length)} finding(s)`);
      for (const finding of review.findings.slice(0, 5)) {
        lines.push(`    [${finding.severity}] ${finding.description}`);
      }
    }
    lines.push('');
  }

  // Before the degradations and after the review, because it is the same kind of fact:
  // something about this run a person weighs before deciding it can move on.
  if (collaboration !== undefined) lines.push(collaboration, '');

  // After the conversation and before the degradations. Who is doing the work is the
  // context that makes an open thread legible — "executor.normal is blocked" reads
  // differently once the screen has said which member that is and what else it holds.
  if (team !== undefined) lines.push(team, '');

  // After the team, because a review is a fact about work somebody did — and reading
  // "TASK-003 changes requested" is easier once the screen has said who wrote it.
  if (codeReview !== undefined) lines.push(codeReview, '');

  if (state.degradations.length > 0) {
    lines.push('Degraded:');
    for (const degradation of state.degradations) {
      lines.push(`  · ${degradation.reason}`);
      lines.push(`    ${degradation.impact}`);
    }
    lines.push('');
  }

  lines.push(`Status:\n${runtime.status.toUpperCase()}`);

  // One hint, from one source (AR §3.6): a gate always names the single action that
  // clears it, and printing anything else here is how a second wording of the same
  // instruction starts to drift from the first.
  if (runtime.gate !== undefined) {
    lines.push('', runtime.gate.action);
  }
  // Two different ways a run stops before a plan, and they need different words
  // and different commands.
  //
  // `plan_rejected_revisable` is the review having read a plan and turned it
  // down: `revise` is exactly right, and spending a revision cycle is the point.
  //
  // A run that died in a planning stage never reached the review, and saying "the
  // review rejected this plan" sends the reader looking for a quality problem
  // that does not exist. `--from` is the tool there: it keeps every artifact
  // before the stage that broke, and costs no revision cycle — which matters,
  // because a `standard` workflow only has two.
  if (runtime.status === 'plan_rejected_revisable') {
    lines.push('', 'The review rejected this plan. Revise it with: agent-flow revise "<instruction>"');
  } else if (runtime.status === 'failed' && state.stage !== 'implementation') {
    lines.push(
      '',
      `This run stopped in "${state.stage}"; the stages before it are kept.`,
      `Resume with: agent-flow feature "<same description>" --from ${state.stage}`,
    );
  }

  return lines.join('\n');
}


/**
 * The run's collaboration, folded exactly as the prompt and the dashboard fold it.
 *
 * `undefined` on every unhappy path, and never an exception: `status` is what a person
 * runs when something is already wrong, and a malformed collaboration log must not be the
 * reason they cannot see the gate they are blocked on.
 */
async function readCollaboration(
  store: StateStore,
  state: RunState,
  fs: NodeFileSystem,
  globals: GlobalOptions,
): Promise<string | undefined> {
  try {
    const collaboration = new CollaborationStore({ fs, projectDir: globals.cwd });
    const messages = await collaboration.readMessages(state.runId);
    const entries = await collaboration.readEntries(state.runId);
    if (messages.length === 0 && entries.length === 0) return undefined;

    const runTerminated = state.status === 'completed' || state.status === 'failed';

    return renderCollaboration({
      // Read for display only, exactly as the isolation line is: whether the feature is
      // on now says nothing about what this run recorded while it was.
      enabled: true,
      threads: projectThreads(messages, { runTerminated }),
      handoffs: projectHandoffs(messages, { runTerminated }),
      entries: projectBlackboard(entries),
    });
  } catch {
    return undefined;
  }
}

/**
 * The run's team, folded exactly as the API and the dashboard fold it.
 *
 * `undefined` on every unhappy path and never an exception, for the same reason
 * `readCollaboration` is: `status` is what a person runs when something is already wrong,
 * and an events log a crash truncated mid-write must not be why they cannot see the gate.
 */
async function readTeam(
  store: StateStore,
  state: RunState,
  fs: NodeFileSystem,
  globals: GlobalOptions,
): Promise<string | undefined> {
  try {
    // Loaded here rather than passed in, exactly as `readIsolation` loads it: a
    // configuration that will not parse is a reason to omit one section, never a reason
    // for `status` to fail.
    const { global: config } = await loadConfig({
      fs,
      globalConfigPath: globals.globalConfigPath,
      projectDir: globals.cwd,
    });

    return renderTeam(
      projectTeam({
        config,
        roster: deriveAgentRoster(config),
        tasks: state.tasks.map((task) => ({ id: task.id, state: task.state })),
        // Best-effort, because this is a read model. The workflow's own reads are strict
        // and fail closed; a screen has to show what it can.
        events: await store.readEventsBestEffort(state.runId),
      }),
    );
  } catch {
    return undefined;
  }
}

/**
 * The run's reviews, folded exactly as the API and the dashboard fold them.
 *
 * `undefined` on every unhappy path and never an exception, for the reason
 * `readCollaboration` and `readTeam` are: `status` is what a person runs when something
 * is already wrong, and an unreadable review log must not be why they cannot see the gate.
 */
async function readCodeReview(
  store: StateStore,
  state: RunState,
  fs: NodeFileSystem,
  globals: GlobalOptions,
): Promise<string | undefined> {
  try {
    const { global: config } = await loadConfig({
      fs,
      globalConfigPath: globals.globalConfigPath,
      projectDir: globals.cwd,
    });

    const reviews = await new ReviewStore({ fs, projectDir: globals.cwd }).readReviews(state.runId);
    if (reviews.length === 0) return undefined;

    const collaboration = new CollaborationStore({ fs, projectDir: globals.cwd });

    return renderReview(
      projectReviews({
        reviews,
        messages: await collaboration.readMessages(state.runId),
        events: await store.readEventsBestEffort(state.runId),
        quality: config.quality,
        roster: deriveAgentRoster(config),
        integratedTrees: await integratedTrees(store, state),
      }),
    );
  } catch {
    return undefined;
  }
}

/**
 * The commit each task is integrated as, from the results the run already wrote.
 *
 * Freshness is identity against this, and nothing else knows both halves — which is why
 * the browser cannot answer it and why this projection can.
 */
async function integratedTrees(
  store: StateStore,
  state: RunState,
): Promise<ReadonlyMap<string, string>> {
  const trees = new Map<string, string>();

  for (const task of state.tasks) {
    try {
      const raw = await store.readTaskResult(state.runId, task.id);
      const tree = raw?.integration?.mergeCommit;
      if (typeof tree === 'string') trees.set(task.id, tree);
    } catch {
      continue;
    }
  }

  return trees;
}
