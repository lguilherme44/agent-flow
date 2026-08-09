import { ReviewResultSchema, type ReviewResult } from '../contracts/index.js';
import { buildExecutionContext, loadPlan } from '../app/execution-context.js';
import { GitClient, renderChanges } from '../adapters/git/git-client.js';
import {
  FINAL_REVIEW_STAGE,
  ReviewResponseSchema,
  VERIFICATION_STAGE,
  buildReview,
  finalReviewIndependence,
  findingsToTasks,
} from '../app/stages/final-review.js';
import { runVerification, summariseVerification, failureDetail } from '../app/verification-commands.js';
import { checkDefinitionOfDone } from '../core/definition-of-done.js';
import { resolveRole } from '../core/role.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import type { GlobalOptions } from './index.js';

/**
 * `agent-flow review` — verification, final review, and the Definition of Done.
 *
 * The commands run first and for free. Only then is a model asked anything,
 * and only about what a command cannot see. A broken build is discovered by
 * `npm test` exiting non-zero, not by paying for an opinion.
 */
export async function runReviewCommand(
  options: { fix?: boolean },
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  try {
    const context = await buildExecutionContext({
      projectDir: globals.cwd,
      globalConfigPath: globals.globalConfigPath,
    });

    const state = await context.store.loadCurrentRun();
    if (state === null) {
      process.stderr.write('No active run.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    const [plan, sdd] = await Promise.all([
      loadPlan(context.store, state.runId),
      context.store.readArtifact(state.runId, 'sdd'),
    ]);

    if (plan === null || sdd === null) {
      process.stderr.write('This run has no plan or SDD to review against.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    const git = new GitClient(context.processRunner, globals.cwd);
    const changes = await git.changedFiles();
    const changedFiles = renderChanges(changes);

    // ---- Commands first: deterministic, free, and often decisive.
    process.stdout.write('Running validation commands\n');
    const verification = await runVerification({
      processRunner: context.processRunner,
      project: context.config.project,
      cwd: globals.cwd,
      onStep: (step, result) => {
        process.stdout.write(`  ${result.exitCode === 0 ? '✓' : '✗'} ${step}\n`);
      },
    });

    const commandResults = [
      summariseVerification(verification),
      failureDetail(verification),
    ]
      .filter((part) => part.length > 0)
      .join('\n\n');

    // ---- Verification agent: what a command cannot see.
    process.stdout.write('\nInspecting the implementation\n');
    const verificationResponse = ReviewResponseSchema.parse(
      (
        await context.stageRunner.run(VERIFICATION_STAGE, state.runId, {
          sdd,
          changedFiles,
          commandResults,
          agentsMd: await readAgentsMd(context, globals.cwd),
        })
      ).data,
    );

    await context.store.writeArtifact(
      state.runId,
      'verification',
      `${JSON.stringify(verificationResponse, null, 2)}\n`,
    );

    // ---- Final review: the implementation against the approved SDD.
    const independence = finalReviewIndependence(context.config.global);
    if (independence === 'same-provider-fresh-context') {
      await context.store.recordDegradation(state.runId, {
        kind: 'single_provider',
        reason: 'the final reviewer shares a runner with an executor role',
        impact:
          'the final review is same-provider: the model that wrote the code is also judging it',
      });
    }

    process.stdout.write('Reviewing against the approved SDD\n');
    const finalResponse = ReviewResponseSchema.parse(
      (
        await context.stageRunner.run(FINAL_REVIEW_STAGE, state.runId, {
          sdd,
          plan: JSON.stringify(plan, null, 2),
          diffStat: await git.diffStat(),
          changedFiles,
          commandResults,
        })
      ).data,
    );

    const reviewer = resolveRole('finalReviewer', context.config.global, context.capabilities, {
      readOnly: true,
    });

    const finalReview = buildReview(
      finalResponse,
      {
        runner: reviewer.runner,
        ...(reviewer.model === undefined ? {} : { model: reviewer.model }),
        reasoning: reviewer.reasoning,
      },
      independence,
    );

    await context.store.writeArtifact(
      state.runId,
      'finalReview',
      `${JSON.stringify(finalReview, null, 2)}\n`,
    );

    // ---- Definition of Done, evaluated as code (§42).
    const doneCheck = checkDefinitionOfDone({
      approved: state.approved,
      taskStates: state.tasks.map((task) => task.state),
      verificationPassed: verification.passed,
      finalReviewVerdict: finalReview.verdict,
    });

    process.stdout.write(`\n${renderReview(verificationResponse, finalReview, doneCheck)}\n`);

    await context.store.updateRun(state.runId, (current) => ({
      ...current,
      stage: 'final-review',
      status: doneCheck.done ? 'completed' : current.status,
    }));

    if (doneCheck.done) return ExitCode.OK;

    if (options.fix === true) {
      const fixes = findingsToTasks(finalReview);
      if (fixes.length > 0) {
        process.stdout.write(
          `\n${String(fixes.length)} corrective task(s) would be created from these findings.\n` +
            'They re-enter the same pipeline — routed, executed and reviewed like any other task.\n',
        );
      }
    }

    return ExitCode.GATE_NOT_SATISFIED;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

async function readAgentsMd(
  context: Awaited<ReturnType<typeof buildExecutionContext>>,
  projectDir: string,
): Promise<string> {
  const path = `${projectDir}/AGENTS.md`;
  return (await context.fs.exists(path))
    ? context.fs.readFile(path)
    : 'No AGENTS.md in this repository.';
}

function renderReview(
  verification: { verdict: string; findings: ReviewResult['findings'] },
  finalReview: ReviewResult,
  done: ReturnType<typeof checkDefinitionOfDone>,
): string {
  const lines: string[] = [];

  lines.push(`Verification: ${verification.verdict}`);
  for (const finding of verification.findings) {
    lines.push(`  [${finding.severity}] ${finding.description}`);
  }

  lines.push('', `Final review: ${finalReview.verdict}`);
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
