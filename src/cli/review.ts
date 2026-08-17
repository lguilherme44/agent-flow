import { ReviewResultSchema, type ReviewResult } from '../contracts/index.js';
import { review, type ReviewOutcome } from '../app/run-actions.js';
import type { CorrectiveRound } from '../app/corrective-round.js';
import type {
  checkDefinitionOfDone,
  MechanicalVerification,
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
export async function runReviewCommand(
  options: { fix?: boolean },
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  try {
    const deps = actionDeps(globals);
    const runId = await currentRunId(deps);
    if (runId === null) {
      process.stderr.write('No active run.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    const outcome = await review(deps, runId, {
      ...(options.fix === undefined ? {} : { fix: options.fix }),
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

    if (outcome.value.done.done) return ExitCode.OK;

    if (outcome.value.corrective !== undefined) {
      process.stdout.write(`\n${renderCorrectiveRound(outcome.value.corrective)}\n`);
    } else if (options.fix === true) {
      process.stderr.write(
        '\nThis run has no architecture impact artifact, which the plan review needs.\n',
      );
    }

    return ExitCode.GATE_NOT_SATISFIED;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

const STAGE_HEADINGS = {
  verification: 'Running validation commands',
  inspection: '\nInspecting the implementation',
  'final-review': 'Reviewing against the approved SDD',
} as const;

/**
 * Everything the review found, in the order a person reads it.
 *
 * The degradations come before the verdict on purpose. This is the screen that
 * says FEATURE COMPLETE, and a run that fell back to another provider, ran below
 * its configured effort or reviewed itself reached that verdict on weaker terms
 * — the person reading the verdict is the one who needs to know it (R-16).
 */
function renderOutcome(outcome: ReviewOutcome): string {
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
    round.review.independence === 'cross-provider'
      ? '  reviewed by a different provider from the planner and the reviewer'
      : '  ⚠ same-provider review — no protection against a repeated assumption',
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
  lines.push(
    finalReview.independence === 'cross-provider'
      ? '  reviewed by a different provider from the implementer'
      : '  ⚠ same-provider review — the model that wrote the code is judging it',
  );
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
