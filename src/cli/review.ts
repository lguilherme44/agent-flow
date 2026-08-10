import { ReviewResultSchema, type ReviewResult } from '../contracts/index.js';
import { buildExecutionContext, loadPlan } from '../app/execution-context.js';
import { GitClient, renderChanges } from '../adapters/git/git-client.js';
import {
  FINAL_REVIEW_STAGE,
  ReviewResponseSchema,
  VERIFICATION_STAGE,
  authorsOf,
  buildReview,
} from '../app/stages/final-review.js';
import { applyFixes } from '../core/corrective-plan.js';
import { buildValidationRegistry } from '../core/validation-registry.js';
import { planHash } from '../app/approval.js';
import { assessIndependence, explainIndependence } from '../core/independence.js';
import { runVerification, summariseVerification, failureDetail } from '../app/verification-commands.js';
import { checkDefinitionOfDone } from '../core/definition-of-done.js';
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
    const authors = authorsOf(await context.store.readEvents(state.runId));

    process.stdout.write('Reviewing against the approved SDD\n');
    const finalResult = await context.stageRunner.run(FINAL_REVIEW_STAGE, state.runId, {
      sdd,
      plan: JSON.stringify(plan, null, 2),
      diffStat: await git.diffStat(),
      changedFiles,
      commandResults,
    });
    const finalResponse = ReviewResponseSchema.parse(finalResult.data);

    // Judged after both sides have run, and by provider rather than by runner
    // id: two configuration entries can point at the same CLI, and a review
    // across them is independent of nothing.
    const independence = assessIndependence(
      authors,
      finalResult.execution.runner,
      context.registry.providerOf,
    );

    if (independence === 'same-provider-fresh-context') {
      await context.store.recordDegradation(state.runId, {
        kind: 'single_provider',
        reason: explainIndependence(authors, finalResult.execution.runner, context.registry.providerOf),
        impact:
          'the final review is same-provider: the model that wrote the code is also judging it',
      });
    }

    const finalReview = buildReview(
      finalResponse,
      {
        runner: finalResult.execution.runner,
        ...(finalResult.execution.model === undefined ? {} : { model: finalResult.execution.model }),
        reasoning: finalResult.execution.reasoning,
      },
      independence,
    );

    await context.store.writeArtifact(
      state.runId,
      'finalReview',
      `${JSON.stringify(finalReview, null, 2)}\n`,
    );

    // ---- What this run gave up along the way.
    //
    // Reported here and not only in `status`, because this is the screen that
    // says FEATURE COMPLETE. A run that fell back to another provider, ran
    // below its configured effort, reviewed itself, or had its gate overruled
    // by --force reached that verdict on weaker terms, and the person reading
    // the verdict is the one who needs to know it.
    const finalState = await context.store.loadRun(state.runId);
    if (finalState.degradations.length > 0) {
      process.stdout.write('\nThis run was degraded:\n');
      for (const degradation of finalState.degradations) {
        process.stdout.write(`  · ${degradation.reason}\n    ${degradation.impact}\n`);
      }
    }

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
      // The ids a corrective task may cite come from the project's own
      // configuration, never from the finding text: a fix validated by an id
      // that does not resolve fails for the wrong reason.
      const registry = buildValidationRegistry(context.config.project);
      const next = applyFixes(plan, finalReview, { validation: registry.ids });
      const added = next.tasks.length - plan.tasks.length;

      if (added === 0) {
        process.stdout.write('\nNo finding was severe enough to become a task.\n');
        return ExitCode.GATE_NOT_SATISFIED;
      }

      // Stamp the plan review with what it actually judged, before replacing
      // the plan under it. Reviews written before this field existed carry no
      // hash and are treated as covering whatever they are read against — a
      // deliberate concession for runs in flight, and one that would otherwise
      // let this exact stale verdict block the corrected plan.
      const planReviewRaw = await context.store.readArtifact(state.runId, 'planReview');
      if (planReviewRaw !== null) {
        const judged = ReviewResultSchema.parse(JSON.parse(planReviewRaw));
        if (judged.planHash === undefined) {
          await context.store.writeArtifact(
            state.runId,
            'planReview',
            `${JSON.stringify({ ...judged, planHash: planHash(plan) }, null, 2)}\n`,
          );
        }
      }

      await context.store.writeArtifact(state.runId, 'plan', `${JSON.stringify(next, null, 2)}\n`);

      // The plan changed, so the approval no longer covers it. Reopening the
      // gate is the point rather than an inconvenience: a person approved a set
      // of tasks, and this is a different set. `revise` behaves the same way,
      // and a correction round is no more exempt than a revision.
      await context.store.updateRun(state.runId, (current) => ({
        ...current,
        approved: false,
        status: 'waiting_for_approval',
      }));

      process.stdout.write(
        [
          '',
          `${String(added)} corrective task(s) added to the plan.`,
          '',
          ...next.tasks.slice(plan.tasks.length).map((task) => `  ${task.id}  ${task.title}`),
          '',
          'They re-enter the same pipeline — routed, executed and validated like',
          'any other task, rather than patched straight into the code.',
          '',
          'The approval was reopened, because the plan is no longer the one that',
          'was approved.',
          '',
          'Next: agent-flow approve, then agent-flow run',
          '',
        ].join('\n'),
      );
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
