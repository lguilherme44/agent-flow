import { PlanSchema, ReviewResultSchema, type RunState } from '../contracts/index.js';
import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { SystemClock } from '../adapters/clock/system-clock.js';
import { StateStore } from '../app/state-store.js';
import { PLANNING_STAGES } from '../app/planning-pipeline.js';
import { collectTelemetry } from '../app/telemetry.js';
import { summariseTelemetry } from '../core/telemetry.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import { loadConfig } from '../config/loader.js';
import { describeIsolation, type IsolationReport } from '../app/run-git-identity.js';
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

    process.stdout.write(
      `${render(
        state,
        plan?.success ? plan.data.tasks.length : 0,
        review?.success ? review.data : null,
        completedStages,
        isolation,
      )}\n`,
    );
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

function render(
  state: RunState,
  taskCount: number,
  review: ReturnType<typeof ReviewResultSchema.parse> | null,
  completedStages: readonly string[],
  isolation: IsolationReport | null,
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
