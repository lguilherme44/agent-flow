import { PlanSchema, ReviewResultSchema, type RunState } from '../contracts/index.js';
import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { SystemClock } from '../adapters/clock/system-clock.js';
import { StateStore } from '../app/state-store.js';
import { PLANNING_STAGES } from '../app/planning-pipeline.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
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

    const planRaw = await store.readArtifact(state.runId, 'plan');
    const reviewRaw = await store.readArtifact(state.runId, 'planReview');
    const plan = planRaw === null ? null : PlanSchema.safeParse(JSON.parse(planRaw));
    const review = reviewRaw === null ? null : ReviewResultSchema.safeParse(JSON.parse(reviewRaw));

    if (globals.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ...state,
            taskCount: plan?.success ? plan.data.tasks.length : 0,
            review: review?.success ? review.data : null,
          },
          null,
          2,
        )}\n`,
      );
      return ExitCode.OK;
    }

    process.stdout.write(`${render(state, plan?.success ? plan.data.tasks.length : 0, review?.success ? review.data : null)}\n`);
    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

function render(
  state: RunState,
  taskCount: number,
  review: ReturnType<typeof ReviewResultSchema.parse> | null,
): string {
  const lines: string[] = [
    `Feature: ${state.feature}`,
    `Run: ${state.runId}`,
    '',
    'PLANNING',
    '',
  ];

  const reached = PLANNING_STAGES.indexOf(state.stage);
  for (const [index, stage] of PLANNING_STAGES.entries()) {
    const label = STAGE_LABELS[stage] ?? stage;
    const mark = index < reached ? '✓' : index === reached ? '✓' : '·';
    lines.push(`  ${label.padEnd(16)}${mark}`);
  }

  lines.push(`  ${'Approval'.padEnd(16)}${state.approved ? '✓' : '·'}`);
  lines.push('');

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
