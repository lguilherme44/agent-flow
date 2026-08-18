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
import { projectRun } from '../core/run-projection.js';
import { loadConfig } from '../config/loader.js';
import { describeIsolation, type IsolationReport } from '../app/run-git-identity.js';
import { integrationRef } from '../core/worktree-policy.js';
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
    const completedStages = (await store.readEvents(state.runId))
      .filter((event) => event.type === 'stage_completed')
      .map((event) => event.detail['stage'])
      .filter((stage): stage is string => typeof stage === 'string');

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

    process.stdout.write(
      `${render(
        state,
        plan?.success ? plan.data.tasks.length : 0,
        review?.success ? review.data : null,
        completedStages,
        isolation,
        conflicts,
      )}\n`,
    );

    // C-22, at the one surface a person is most likely to be looking at when a run stops.
    // Rendered after the run summary rather than instead of it: the escalation says what to
    // do, and the summary is the context that makes the instruction make sense.
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
): string[] {
  const done = new Set(completedStages);

  return PLANNING_STAGES.map((stage) => {
    const label = STAGE_LABELS[stage] ?? stage;
    const mark = done.has(stage)
      ? '✓'
      : stage === currentStage && status === 'running'
        ? '…'
        : '·';
    return `  ${label.padEnd(16)}${mark}`;
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

function render(
  state: RunState,
  taskCount: number,
  review: ReturnType<typeof ReviewResultSchema.parse> | null,
  completedStages: readonly string[],
  isolation: IsolationReport | null,
  conflicts: readonly { task: string; attempt: number; paths: readonly string[] }[],
): string {
  const lines: string[] = [
    `Feature: ${state.feature}`,
    `Run: ${state.runId}`,
    '',
    'PLANNING',
    '',
  ];

  lines.push(...renderPlanningProgress(completedStages, state.stage, state.status));

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

  if (state.degradations.length > 0) {
    lines.push('Degraded:');
    for (const degradation of state.degradations) {
      lines.push(`  · ${degradation.reason}`);
      lines.push(`    ${degradation.impact}`);
    }
    lines.push('');
  }

  lines.push(`Status:\n${state.status.toUpperCase()}`);

  if (state.status === 'waiting_for_approval') {
    lines.push('', 'Read the SDD and the plan, then: agent-flow approve');
  }
  if (state.status === 'plan_rejected') {
    lines.push('', 'The review rejected this plan. Revise it with: agent-flow revise "<instruction>"');
  }

  return lines.join('\n');
}
