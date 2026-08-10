import { PlanSchema, ReviewResultSchema } from '../contracts/index.js';
import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { SystemClock } from '../adapters/clock/system-clock.js';
import { StateStore } from '../app/state-store.js';
import { approveRun, checkApproval, type ApprovalRefusal } from '../app/approval.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import type { GlobalOptions } from './index.js';

/**
 * `agent-flow approve` — the gate before anything is implemented (§17).
 *
 * The refusals here are the point of the command. Approving a plan that failed
 * review, or one nobody reviewed, has to be a deliberate act with `--force`, not
 * something that happens because the command was convenient.
 */
export async function runApproveCommand(
  options: { force?: boolean },
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  const fs = new NodeFileSystem();
  const store = new StateStore({ fs, clock: new SystemClock(), projectDir: globals.cwd });

  try {
    const state = await store.loadCurrentRun();
    if (state === null) {
      process.stderr.write('No active run to approve.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    const planRaw = await store.readArtifact(state.runId, 'plan');
    const reviewRaw = await store.readArtifact(state.runId, 'planReview');

    const plan = planRaw === null ? null : PlanSchema.parse(JSON.parse(planRaw));
    const review = reviewRaw === null ? null : ReviewResultSchema.parse(JSON.parse(reviewRaw));

    const check = checkApproval(state, plan, review);

    // Printed before the decision either way: someone approving a degraded run
    // should know what was lost while they still have the choice (R-16).
    for (const warning of check.warnings) {
      process.stdout.write(`⚠ ${warning}\n`);
    }
    if (check.warnings.length > 0) process.stdout.write('\n');

    if (!check.allowed) {
      const forcible =
        check.refusal?.kind === 'review_failed' || check.refusal?.kind === 'review_missing';

      if (!(forcible && options.force === true)) {
        process.stderr.write(`${explain(check.refusal)}\n`);
        return ExitCode.GATE_NOT_SATISFIED;
      }

      process.stdout.write('Overriding the review gate because --force was given.\n\n');
    }

    if (plan === null) {
      process.stderr.write('There is no plan to approve.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    await approveRun(store, state.runId, plan, { forced: options.force === true });

    process.stdout.write(
      [
        `Approved ${state.runId} — ${String(plan.tasks.length)} tasks.`,
        '',
        'The approval is bound to this exact plan: revise it and the gate closes',
        'again.',
        '',
        'Next: agent-flow run',
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

function explain(refusal: ApprovalRefusal | undefined): string {
  switch (refusal?.kind) {
    case 'no_run':
      return 'No active run. Start one with: agent-flow feature "<description>"';
    case 'no_plan':
      return 'This run has no plan yet. Finish planning first.';
    case 'review_missing':
      return [
        'This plan has not been reviewed.',
        '',
        'Run the review, or approve deliberately with --force.',
      ].join('\n');
    case 'review_failed':
      return [
        `The plan review returned FAIL with ${String(refusal.review.findings.length)} finding(s):`,
        '',
        ...refusal.review.findings.map(
          (finding) => `  [${finding.severity}] ${finding.description}\n      → ${finding.suggestedAction}`,
        ),
        '',
        'Fix the plan with: agent-flow revise "<instruction>"',
        'Or approve anyway with --force, which is recorded on the run.',
      ].join('\n');
    case 'already_approved':
      return 'This run is already approved.';
    default:
      return 'Approval is not possible in the current state.';
  }
}

/** `agent-flow reject` — closes a run without implementing it. */
export async function runRejectCommand(
  reason: string | undefined,
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  const fs = new NodeFileSystem();
  const store = new StateStore({ fs, clock: new SystemClock(), projectDir: globals.cwd });

  try {
    const state = await store.loadCurrentRun();
    if (state === null) {
      process.stderr.write('No active run to reject.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    await store.updateRun(state.runId, (current) => ({ ...current, status: 'plan_rejected' }));
    await store.appendEvent(state.runId, 'run_rejected', {
      reason: reason ?? '(no reason given)',
    });

    process.stdout.write(`Rejected ${state.runId}.\n`);
    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}
