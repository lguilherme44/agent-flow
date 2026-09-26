import { createHash } from 'node:crypto';
import { stringify as toYaml } from 'yaml';
import type { EffectiveConfig, Plan, ReviewResult, RunStage } from '../contracts/index.js';
import { PlanSchema } from '../contracts/index.js';
import type { Clock, FileSystem, ProcessRunner } from '../ports/index.js';
import type { GitCommand } from '../adapters/git/git-command.js';
import type { PlanningBaseMoment } from './run-git-identity.js';
import type { StageRunner } from './stage-runner.js';
import { StageFailure } from './stage-runner.js';
import type { StateStore } from './state-store.js';
import { agentFlowPaths } from './paths.js';
import type { RunnerCapabilitiesMap } from '../core/role.js';
import { PlanReviewService } from './plan-review-service.js';
import {
  ARCHITECTURE_IMPACT_STAGE,
  DISCOVERY_STAGE,
  PLANNING_STAGE,
  PLANNING_TRIVIAL_STAGE,
  PLANNING_SIMPLE_STAGE,
  SDD_STAGE,
} from './stages/definitions.js';
import { checkPlan, type PlanCitations } from './stages/planning-checks.js';
import { buildValidationRegistry, type ValidationRegistry } from '../core/validation-registry.js';
import type { ExecutorCommands } from '../core/command-grants.js';
import {
  computeFingerprint,
  fingerprintDifferences,
  fingerprintsMatch,
  readFingerprint,
  writeFingerprint,
} from './discovery-cache.js';
import {
  classifyWorkflow,
  getCeremonyBudget,
  type WorkflowClass,
  type WorkflowClassificationResult,
} from '../core/adaptive-workflow.js';
import { readProjectInstructions } from './project-instructions.js';

/** Ordered stages of the planning half of the workflow. */
export const PLANNING_STAGES: readonly RunStage[] = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
];

/**
 * How many times a plan the checks refused is handed back to the planner before a person
 * is asked.
 *
 * One, and bounded on purpose: the checks are arithmetic over the plan — a file two
 * independent tasks both declare, a requirement no task covers — and a planner that cannot
 * fix an arithmetic report in one more call is not going to fix it in five. The second
 * refusal is a person's to read.
 */
export const MAX_PLAN_CHECK_REPAIRS = 1;

/**
 * The feature request with the checks' report attached, for the planner's second call.
 *
 * The same shape `revise` uses to carry a person's instruction, because it is the same
 * act: somebody read the refusal and asked for the plan again with these words. Here the
 * somebody is the pipeline, and the words are the checks' own.
 */
export function withCheckProblems(featureRequest: string, problems: readonly string[]): string {
  return [
    featureRequest.trim(),
    '',
    '---',
    '',
    'Your previous plan was refused by the mechanical checks below. Return the whole plan',
    'again with exactly these problems fixed, and change nothing else:',
    ...problems.map((problem) => `- ${problem}`),
  ].join('\n');
}

export interface PlanningPipelineOptions {
  readonly fs: FileSystem;
  readonly clock: Clock;
  /** Used to fingerprint the repository for cache invalidation. */
  readonly processRunner: ProcessRunner;
  /** The hook-isolated `git` wrapper the discovery fingerprint reads through. */
  readonly git: GitCommand;
  /**
   * Evaluates §6.2's gate between stages. Injected as a function rather than as
   * a `GitWorkspaces` so that the pipeline cannot grow a second opinion about
   * what a precondition is — there is one implementation, in
   * `run-git-identity.ts`, and this is a call to it.
   */
  readonly planningBaseGate?: PlanningGate;
  readonly store: StateStore;
  readonly stageRunner: StageRunner;
  readonly config: EffectiveConfig;
  readonly capabilities: RunnerCapabilitiesMap;
  /**
   * What the executor may run, from `executorCommandsOf` (FR-008).
   *
   * Computed by the composition root rather than here, so the planning pipeline, `doctor`
   * and the server read one answer from one function. Absent reads as unknown — nothing is
   * claimed about the executor, so no plan is refused for citing a command — which is what
   * every wiring that predates the grant was already getting.
   */
  readonly executorCommands?: ExecutorCommands;
  /** Maps a runner id to its provider, for judging review independence. */
  readonly providerOf: (runnerId: string) => string | undefined;
  readonly projectDir: string;
  /**
   * Builds the ranked repository index `discovery` starts from.
   *
   * **Optional, and it reaches exactly one stage.** Structural context earns its tokens
   * where an agent is deciding *what to look at*, and costs correctness where it is writing
   * code — measured across four models at 25% fewer input tokens in the localisation step
   * and 5pp of Pass@1 lost in the editing step (arXiv 2606.14061). `discovery` is the
   * former; `implementation` is the latter, and `test/architecture.test.ts` holds that line
   * rather than this comment.
   *
   * Absent, every stage runs exactly as it did before — which is what the twenty-odd test
   * wirings that predate this rely on, and what a repository without Git falls back to.
   */
  readonly buildRepoMap?: () => Promise<string | undefined>;
}

/**
 * Asked between planning stages, and at planning start.
 *
 * Resolves to a refusal reason when the run cannot proceed, and to `null` when
 * it can — including, without asking Git anything, for every run that is not in
 * worktree mode.
 */
export type PlanningGate = (
  runId: string,
  moment: PlanningBaseMoment,
) => Promise<PlanningRefusalFacts | null>;

/** What the gate found, in Appendix A's vocabulary. */
export interface PlanningRefusalFacts {
  readonly code: string;
  readonly detail: string;
  /** What to do about it. */
  readonly action: string;
}

/**
 * Whose mistake this is, and therefore which exit code it deserves.
 *
 * `configuration` means the project is not set up — the user edits a file. `repository`
 * means the working tree or history is in a state a Git command resolves. The CLI maps
 * these to `CONFIG_ERROR` and `EXECUTION_ERROR`, so the decision is made once, here, by
 * the layer that knows what went wrong — rather than by the renderer matching on a code
 * string it would have to be kept in step with.
 *
 * Defaults to `repository`, which is what every refusal predating AR-01 was.
 */
export type PlanningRefusalKind = 'configuration' | 'repository';

/**
 * What `architecture-impact` and `sdd` receive in place of the map for a grounded request.
 *
 * Instructions rather than a map, because the stages that read it are the ones that found
 * what changed the plans on 23/09/2026, by reading code rather than the map. Both declare
 * `workingDirectory: true`, so they can do exactly what this asks.
 */
export const GROUNDED_DISCOVERY_NOTE = [
  '# Repository map',
  '',
  'Discovery did not run: this request is grounded. Whoever wrote it has already investigated',
  'the repository, and the request carries that investigation.',
  '',
  'Treat every file, symbol, line, value and behaviour the request cites as a claim, and confirm',
  'it in the code before relying on it. Map only what this change touches: the functions it',
  'changes, their callers (search for them: a consumer the request does not name is the most',
  'likely thing it missed), the tests that cover them, and any other reader of their output.',
  'Where the code contradicts the request, say so plainly.',
].join('\n');

export class PlanningRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly action: string,
    readonly kind: PlanningRefusalKind = 'repository',
  ) {
    super(message);
    this.name = 'PlanningRefusal';
  }
}

export interface PipelineOptions {
  /** Re-runs discovery even when a valid cache exists. */
  readonly noCache?: boolean;
  /** Resumes from a stage, keeping the artifacts already produced. */
  readonly from?: RunStage;
  /** Stops after planning, without the automated review. */
  readonly skipReview?: boolean;
  /** Explicit workflow override or predetermined workflow. */
  readonly workflow?: WorkflowClass;
  /**
   * Who supplied {@link workflow} (FR-014). Omitted with a `workflow` present means
   * `operator`, so `feature --workflow` and the Deck's select need say nothing; a re-plan
   * handing back the class the run already has says `carried`.
   */
  readonly workflowOrigin?: 'operator' | 'carried';
  /**
   * The request carries its own investigation, written by an orchestrating model that
   * already read the code. A fresh discovery is skipped (a valid cached map is still
   * used), and the impact is told to confirm the request's claims in the repository.
   * Persisted on the run; see `RunState.grounded`.
   */
  readonly grounded?: boolean;
  readonly onProgress?: (
    stage: RunStage,
    status: 'started' | 'completed' | 'cached' | 'stale' | 'repairing' | 'skipped',
  ) => void;
}

export interface PipelineResult {
  readonly runId: string;
  readonly plan: Plan;
  readonly stagesRun: RunStage[];
  /** Absent when the pipeline was asked to stop before review. */
  readonly review?: ReviewResult;
  /**
   * The classification this run planned under, so a renderer can say which class, where it
   * came from, which words decided it and how to correct it (FR-015) without reading the
   * event log back.
   */
  readonly classification?: WorkflowClassificationResult;
}

/** What {@link PlanningPipeline.warm} measured. It measures; it does not judge. */
export interface WarmResult {
  /** False when a valid cache already answered, and nothing was spent. */
  readonly ran: boolean;
  readonly elapsedMs: number;
}

/**
 * Adaptive planning pipeline (M2.1-C).
 *
 * Runs the minimal necessary ceremony for each workflow class:
 *   - TRIVIAL: Direct Plan (1 call) -> Approval
 *   - SIMPLE: Short Plan (1 call) -> Plan Review (1 call) -> Approval
 *   - STANDARD: Discovery -> Impact -> SDD -> Planning -> Plan Review -> Approval
 *   - HIGH-RISK: Full Discovery -> Full SDD -> Strict Planning -> Cross-provider Review -> Approval
 */
export class PlanningPipeline {
  constructor(private readonly options: PlanningPipelineOptions) {}

  /**
   * Discovery on its own, so the first feature is not the one that pays for it.
   *
   * The map is feature-agnostic — that is why it is cached at all — but nothing could
   * build it ahead of time, so the first real request funded a stage that has nothing to
   * do with it. On a large repository that is the most expensive stage in the run, and
   * when it does not fit the role's budget the request it was attached to dies with it:
   * measured, a monorepo's discovery ran 15min00s into a 900 s limit and took the whole
   * planning run down at the first stage.
   *
   * Returns the numbers rather than judging them. Whether 78% of a budget is comfortable
   * is a question for whoever configured the budget, and `cli/init.ts` is where that gets
   * said — this layer measures.
   *
   * `elapsedMs` is wall-clock around the call and includes the cache check, which is a
   * `stat` and a hash against a stage that spends minutes inside one CLI invocation. On a
   * cache hit it is the cache check and nothing else, which is why `ran` is reported
   * beside it instead of leaving a reader to infer it from a small number.
   */
  async warm(
    runId: string,
    options: { readonly onProgress?: PipelineOptions['onProgress'] } = {},
  ): Promise<WarmResult> {
    const stagesRun: RunStage[] = [];
    const startedAt = this.options.clock.monotonicMs();

    await this.discover(runId, {
      projectConfig: this.renderProjectConfig(),
      agentsMd: await this.readAgentsMd(),
      useCache: true,
      onProgress: options.onProgress,
      stagesRun,
    });

    return {
      // `discover` pushes the stage only when it actually invoked the runner, so this is
      // the cache answer rather than a second guess at it.
      ran: stagesRun.length > 0,
      elapsedMs: this.options.clock.monotonicMs() - startedAt,
    };
  }

  async run(
    runId: string,
    featureRequest: string,
    options: PipelineOptions = {},
  ): Promise<PipelineResult> {
    const { store } = this.options;
    const stagesRun: RunStage[] = [];
    const skipUntil = options.from ? PLANNING_STAGES.indexOf(options.from) : 0;

    const projectConfig = this.renderProjectConfig();
    const agentsMd = await this.readAgentsMd();

    await store.writeArtifact(runId, 'request', `${featureRequest}\n`);

    try {
      // Resolve workflow classification safely with deterministic facts & override checks
      const state = await store.loadRun(runId);
      const explicitOverride = options.workflow ?? state.workflow;
      // FR-014. A class handed in by the caller is the operator's unless the caller says it
      // is carried; a class read back from the run with nothing handed in is always carried.
      // Both used to be recorded as "set by operator", so every `--from` resume and every
      // re-plan claimed a person had chosen a class nobody had touched.
      const overrideOrigin: 'operator' | 'carried' =
        options.workflow === undefined ? 'carried' : (options.workflowOrigin ?? 'operator');
      const repoFiles = await collectRepoFactPaths(this.options.fs, this.options.projectDir);
      const classification = classifyWorkflow(featureRequest, {
        explicitOverride,
        overrideOrigin,
        projectDir: this.options.projectDir,
        projectConfig: this.options.config.project,
        files: repoFiles,
      });
      const workflow: WorkflowClass = classification.workflow;
      // Bound once, and it is the same object the event below records. Two calls would be
      // two answers to "what was this run's budget", and the whole defect this closes was
      // a budget that was written down and not used.
      const budget = getCeremonyBudget(workflow);
      const grounded = options.grounded === true || state.grounded === true;
      await store.updateRun(runId, (s) => ({ ...s, workflow, status: 'running', ...(grounded ? { grounded: true } : {}) }));
      await store.appendEvent(runId, 'workflow_classified', {
        workflow,
        rationale: classification.rationale,
        budget,
        highRiskSignals: classification.highRiskSignalsDetected,
        // Additive keys on an open `detail` (FR-014): a legacy reader sees the four above
        // exactly as before, and the Deck renders from these when they are present.
        origin: classification.origin,
        detected: classification.detected,
        ...(classification.requested === undefined ? {} : { requested: classification.requested }),
        evidence: classification.evidence,
      });

      // §6.2, moment one: verify repository readiness at planning start
      await this.assertReady(runId, 'planning start');

      // ---- TRIVIAL workflow branch (1 model call)
      if (workflow === 'trivial') {
        const { plan } = await this.planUntilChecksPass({
          runId,
          stage: PLANNING_TRIVIAL_STAGE,
          featureRequest,
          vars: {
            projectConfig,
            validationCommands: this.renderValidationCommands(),
            executorCommands: this.renderExecutorCommands(),
            agentsMd,
          },
          sddText: '',
          ceremonyProblems: (candidate) =>
            candidate.tasks.length > 1
              ? [`TRIVIAL workflow ceremony budget allows at most 1 task (got ${String(candidate.tasks.length)}).`]
              : [],
          refusal: 'The plan violates TRIVIAL ceremony budget/checks:',
          onProgress: options.onProgress,
        });

        stagesRun.push('planning');
        options.onProgress?.('planning', 'completed');
        await store.updateRun(runId, (s) => ({ ...s, status: 'waiting_for_approval' }));
        return { runId, plan, stagesRun, classification };
      }

      // ---- SIMPLE workflow branch (2 model calls: short plan + plan review)
      if (workflow === 'simple') {
        const { plan, result } = await this.planUntilChecksPass({
          runId,
          stage: PLANNING_SIMPLE_STAGE,
          featureRequest,
          vars: {
            projectConfig,
            validationCommands: this.renderValidationCommands(),
            executorCommands: this.renderExecutorCommands(),
            agentsMd,
          },
          sddText: '',
          ceremonyProblems: (candidate) =>
            candidate.tasks.length > 3
              ? [`SIMPLE workflow ceremony budget allows at most 3 tasks (got ${String(candidate.tasks.length)}).`]
              : [],
          refusal: 'The plan violates SIMPLE ceremony budget/checks:',
          onProgress: options.onProgress,
        });
        const plannerRunner = result.execution.runner;

        stagesRun.push('planning');
        options.onProgress?.('planning', 'completed');

        if (options.skipReview === true) {
          await store.updateRun(runId, (s) => ({ ...s, status: 'waiting_for_approval' }));
          return { runId, plan, stagesRun, classification };
        }

        // ---- Plan review
        options.onProgress?.('plan-review', 'started');
        const review = await this.planReview().reviewSimple({
          runId,
          plan,
          featureRequest,
          authors: [plannerRunner],
          executorContext: this.renderExecutorContext('feature request'),
        });

        stagesRun.push('plan-review');
        options.onProgress?.('plan-review', 'completed');

        await store.updateRun(runId, (s) => ({
          ...s,
          status: review.verdict === 'PASS' ? 'waiting_for_approval' : 'plan_rejected',
        }));

        return { runId, plan, stagesRun, review, classification };
      }

      // ---- STANDARD / HIGH-RISK workflows: Full ceremony
      // Discovery: feature-agnostic, therefore cacheable across runs (R-07).
      // In HIGH-RISK, discovery cache is refreshed to avoid stale assumptions.
      const useDiscoveryCache = workflow === 'high-risk' ? false : !(options.noCache ?? false);
      const architecture = await this.discover(runId, {
        projectConfig,
        agentsMd,
        useCache: useDiscoveryCache,
        resumingPast: skipUntil > PLANNING_STAGES.indexOf('discovery'),
        grounded,
        onProgress: options.onProgress,
        stagesRun,
      });

      await this.assertReady(runId, 'architecture-impact');

      // ---- Architecture impact: what this particular feature reaches.
      const architectureImpact = await this.stageOrExisting(
        'architecture-impact',
        skipUntil,
        runId,
        'architectureImpact',
        { featureRequest, architecture, projectConfig, agentsMd },
        stagesRun,
        options.onProgress,
      );

      await this.assertReady(runId, 'sdd');

      // ---- SDD: the contract every later stage is judged against.
      const sdd = await this.stageOrExisting(
        'sdd',
        skipUntil,
        runId,
        'sdd',
        { featureRequest, architecture, architectureImpact, projectConfig, agentsMd },
        stagesRun,
        options.onProgress,
      );

      await this.assertReady(runId, 'planning');

      // ---- Planning.
      const { plan, result } = await this.planUntilChecksPass({
        runId,
        stage: PLANNING_STAGE,
        featureRequest,
        vars: {
          sdd,
          architectureImpact,
          projectConfig,
          validationCommands: this.renderValidationCommands(),
          executorCommands: this.renderExecutorCommands(),
        },
        sddText: sdd,
        // **The bound the run already recorded, finally applied.**
        //
        // `trivial` and `simple` enforced theirs from the start; `standard` and `high-risk`
        // passed an empty check, so the task half of the ceremony budget was declared and
        // never used. Measured live: a `high-risk` run wrote
        // `workflow_classified { budget: { maxTasks: 8 } }` into its own event log and then
        // accepted a twelve-task plan, with nothing refusing, warning or degrading.
        //
        // A budget recorded in the audit trail and not applied is worse than no budget: it
        // tells a later reader that a bound held when it did not. And the cost was real —
        // the cross-provider review of that plan objected that one task carried six
        // independent responsibilities, which is what a plan does when nothing pushes back
        // on its size.
        //
        // Through `ceremonyProblems` rather than as a refusal, so it behaves like the other
        // two: the planner is asked again with the problem attached, which is the loop that
        // already turns a rejected plan into an accepted one.
        ceremonyProblems: (candidate) =>
          candidate.tasks.length > budget.maxTasks
            ? [
                `${workflow.toUpperCase()} workflow ceremony budget allows at most ` +
                  `${String(budget.maxTasks)} tasks (got ${String(candidate.tasks.length)}). ` +
                  'Merge what belongs together, or split the feature.',
              ]
            : [],
        refusal: 'The plan does not satisfy the SDD:',
        onProgress: options.onProgress,
      });
      const plannerRunner = result.execution.runner;

      stagesRun.push('planning');
      options.onProgress?.('planning', 'completed');

      if (options.skipReview === true) {
        await store.updateRun(runId, (s) => ({ ...s, status: 'waiting_for_approval' }));
        return { runId, plan, stagesRun, classification };
      }

      // ---- Plan review, in a fresh context holding only the artifacts (§27).
      options.onProgress?.('plan-review', 'started');
      const review = await this.planReview().review({
        runId,
        plan,
        sdd,
        architectureImpact,
        authors: [plannerRunner],
        executorContext: this.renderExecutorContext('SDD'),
      });

      stagesRun.push('plan-review');
      options.onProgress?.('plan-review', 'completed');

      await store.updateRun(runId, (s) => ({
        ...s,
        status: review.verdict === 'PASS' ? 'waiting_for_approval' : 'plan_rejected',
      }));

      return { runId, plan, stagesRun, review, classification };
    } catch (error) {
      if (error instanceof PlanningRefusal) {
        await store.updateRun(runId, (state) => ({
          ...state,
          status: 'failed',
        }));
        await store.appendEvent(runId, 'planning_refused', {
          code: error.code,
          detail: error.message,
          action: error.action,
        });
      } else {
        await store.updateRun(runId, (state) => ({
          ...state,
          status: 'failed',
        }));
      }
      throw error;
    }
  }

  /**
   * Refuses to continue when the run's frozen mode says it must not.
   *
   * One source of truth, asked at each boundary — rather than a second state
   * machine inside the pipeline, or a stage that reads the configuration while
   * its neighbour reads the run. When no gate is wired the pipeline proceeds,
   * which is what keeps every existing sequential caller unchanged.
   */
  private async assertReady(runId: string, moment: PlanningBaseMoment): Promise<void> {
    const refusal = await this.options.planningBaseGate?.(runId, moment);
    if (refusal === null || refusal === undefined) return;

    throw new PlanningRefusal(
      refusal.code,
      `${runId} is an isolated run and this repository is not ready at ${moment}: ${refusal.detail}.`,
      refusal.action,
    );
  }

  /** Shared with the corrective loop, so both plans are judged the same way. */
  /**
   * Asks the planner, checks the plan, and — once — asks again with the problems attached.
   *
   * The planning prompt has promised this since it was written: *"a plan that violates
   * them is rejected and you will be asked again."* Nothing asked again. A refused plan
   * ended the pipeline, and the only ways forward were `revise`, which spends one of the
   * run's two revision cycles on a sentence the checks had already written, or `--from
   * planning`, which re-plans blind. Measured over every run on the machine this was
   * written on: seven planning refusals, five of them the same mechanical fact — two
   * independent tasks declaring one file — and the run that hit it twice in a row ended
   * in `approve --force`.
   *
   * The plan is never edited here. The planner is handed the report and produces a whole
   * new plan, which is exactly what a person typing `revise` would have done with the same
   * words — minus the revision cycle it would have cost them. Bounded by
   * {@link MAX_PLAN_CHECK_REPAIRS}, recorded as `planning_repair_requested`, and announced
   * as its own progress line, so a repair is never mistaken for a first attempt.
   *
   * Every refused attempt still writes `stage_failed` with its problems, as before; the
   * repaired attempt adds `repair` to its own refusal so the two are distinguishable.
   */
  private async planUntilChecksPass(input: {
    readonly runId: string;
    readonly stage: typeof PLANNING_STAGE | typeof PLANNING_SIMPLE_STAGE | typeof PLANNING_TRIVIAL_STAGE;
    readonly featureRequest: string;
    readonly vars: Record<string, string>;
    /** Empty for the workflows that dispense with an SDD. */
    readonly sddText: string;
    /** Ceremony rules that live beside `checkPlan`: budgets a workflow class imposes. */
    readonly ceremonyProblems: (plan: Plan) => string[];
    /** The first line of the refusal a person reads. */
    readonly refusal: string;
    readonly onProgress: PipelineOptions['onProgress'];
  }): Promise<{ plan: Plan; result: Awaited<ReturnType<StageRunner['run']>> }> {
    const { store } = this.options;
    const registry = buildValidationRegistry(this.options.config.project);
    // Every plan this loop sees is the planner's, so the planner-only rules apply (FR-009,
    // FR-024). The corrective round calls `checkPlan` without them.
    const citations: PlanCitations = {
      declared: registry.ids.map((id) => registry.resolve(id) ?? ''),
      executor: this.executorCommands(),
    };
    let request = input.featureRequest;

    for (let repair = 0; ; repair += 1) {
      input.onProgress?.('planning', repair === 0 ? 'started' : 'repairing');
      const result = await this.options.stageRunner.run(input.stage, input.runId, {
        ...input.vars,
        featureRequest: request,
      });

      const plan = PlanSchema.parse(result.data);
      const problems = [
        ...checkPlan(plan, input.sddText, registry, citations),
        ...input.ceremonyProblems(plan),
      ];
      if (problems.length === 0) return { plan, result };

      await store.appendEvent(input.runId, 'stage_failed', {
        stage: 'planning',
        problems,
        ...(repair === 0 ? {} : { repair }),
      });

      if (repair >= MAX_PLAN_CHECK_REPAIRS) {
        throw new StageFailure(
          'planning',
          'invalid_output',
          `${input.refusal}\n${problems.map((p) => `  - ${p}`).join('\n')}`,
          undefined,
          result.execution,
          // Parsed and schema-valid; turned down by a plan rule. Saying
          // `malformed_runner_output` here sends the reader looking at the
          // contract instead of at the plan.
          { failureClass: 'plan_rejected_by_checks' },
        );
      }

      await store.appendEvent(input.runId, 'planning_repair_requested', {
        problems,
        repair: repair + 1,
        maxRepairs: MAX_PLAN_CHECK_REPAIRS,
      });
      request = withCheckProblems(input.featureRequest, problems);
    }
  }

  private planReview(): PlanReviewService {
    return new PlanReviewService({
      store: this.options.store,
      stageRunner: this.options.stageRunner,
      providerOf: this.options.providerOf,
    });
  }

  private async discover(
    runId: string,
    context: {
      projectConfig: string;
      agentsMd: string;
      useCache: boolean;
      /**
       * `--from` names a stage after discovery. The operator asked to resume past it, so a
       * map that exists is kept even when its fingerprint no longer matches — the same
       * promise `stageOrExisting` keeps for the impact and the SDD. Measured: without it,
       * `revise --from sdd` re-ran a 10-minute discovery because AGENTS.md had been edited.
       */
      resumingPast?: boolean;
      /** See `PipelineOptions.grounded`. Checked after every cache exit: a valid map is free. */
      grounded?: boolean;
      onProgress: PipelineOptions['onProgress'];
      stagesRun: RunStage[];
    },
  ): Promise<string> {
    const { fs, projectDir } = this.options;
    const cachePath = agentFlowPaths(projectDir).architectureCache;

    if (context.resumingPast === true && (await fs.exists(cachePath))) {
      const current = await computeFingerprint({
        fs,
        git: this.options.git,
        projectDir,
        projectConfig: context.projectConfig,
      });
      const cached = await readFingerprint(fs, projectDir);
      const stale = cached === null || !fingerprintsMatch(cached, current);
      context.onProgress?.('discovery', 'cached');
      // Staleness recorded, not acted on: the operator chose to resume past this stage,
      // and the trace is what lets anyone reading the run see the map was kept anyway.
      await this.options.store.appendEvent(runId, 'stage_reused', {
        stage: 'discovery',
        reason: 'resumed_from_later_stage',
        stale,
        ...(stale && cached !== null ? { changed: fingerprintDifferences(cached, current) } : {}),
      });
      return fs.readFile(cachePath);
    }

    // The repository map does not change because a different feature was
    // requested, so reusing it saves one expensive call per feature. It very
    // much does change when the repository does — and the cache used to be
    // reused on existence alone, so a rewritten codebase kept being planned
    // against a map of what it used to be.
    const fingerprint = await computeFingerprint({
      fs,
      git: this.options.git,
      projectDir,
      projectConfig: context.projectConfig,
    });

    if (context.useCache && (await fs.exists(cachePath))) {
      const cached = await readFingerprint(fs, projectDir);

      if (cached !== null && fingerprintsMatch(cached, fingerprint)) {
        context.onProgress?.('discovery', 'cached');
        // Recorded, not just reported. `onProgress` reaches the terminal of whoever
        // typed the command and nothing else — a dashboard opened afterwards, or by
        // someone else, had no way to tell a reused stage from one that never ran,
        // and showed `pending` for work that was already done.
        await this.options.store.appendEvent(runId, 'stage_reused', {
          stage: 'discovery',
          reason: 'discovery_cache_hit',
        });
        return fs.readFile(cachePath);
      }

      context.onProgress?.('discovery', 'stale');
      if (cached !== null) {
        await this.options.store.appendEvent(runId, 'discovery_cache_invalidated', {
          changed: fingerprintDifferences(cached, fingerprint),
        });
      }
    }

    if (context.grounded === true) {
      await this.options.store.appendEvent(runId, 'stage_skipped', {
        stage: 'discovery',
        reason: 'grounded_request',
      });
      context.onProgress?.('discovery', 'skipped');
      return GROUNDED_DISCOVERY_NOTE;
    }

    context.onProgress?.('discovery', 'started');

    // **Built here rather than passed in, because it is only worth building if the stage
    // is about to run.** Every exit above this line served the map from cache, and parsing
    // a monorepo to hand it to nobody is the waste in miniature.
    //
    // A failure costs the map and nothing else: the prompt says an absent map means the
    // method applies without one, and that is exactly the behaviour every run had before
    // this existed.
    let repoMap = '';
    try {
      repoMap = (await this.options.buildRepoMap?.()) ?? '';
    } catch {
      repoMap = '';
    }

    if (repoMap.length > 0) {
      // Recorded because it is a fact about what the stage was given, and because the
      // whole reason for this artifact is a token bill somebody should be able to check.
      await this.options.store.appendEvent(runId, 'repo_map_built', {
        stage: 'discovery',
        bytes: repoMap.length,
      });
    }

    const result = await this.options.stageRunner.run(DISCOVERY_STAGE, runId, {
      projectDir: this.options.projectDir,
      projectConfig: context.projectConfig,
      agentsMd: context.agentsMd,
      // Always supplied, never in `requiredVars`: the loader refuses a required variable
      // that is empty, and "no map" is a legitimate state rather than a misconfiguration.
      repoMap,
    });

    await fs.mkdirp(agentFlowPaths(projectDir).cacheDir);
    await fs.writeFileAtomic(cachePath, result.text);
    await writeFingerprint(fs, projectDir, fingerprint);

    context.stagesRun.push('discovery');
    context.onProgress?.('discovery', 'completed');
    return result.text;
  }

  /** Reuses a persisted artifact when resuming past its stage (R-08). */
  private async stageOrExisting(
    stage: RunStage,
    skipUntil: number,
    runId: string,
    artifact: 'architectureImpact' | 'sdd',
    vars: Record<string, string>,
    stagesRun: RunStage[],
    onProgress: PipelineOptions['onProgress'],
  ): Promise<string> {
    const index = PLANNING_STAGES.indexOf(stage);

    if (index < skipUntil) {
      const existing = await this.options.store.readArtifact(runId, artifact);
      if (existing !== null) {
        onProgress?.(stage, 'cached');
        // See the discovery cache hit above: a resume that reuses an artifact has
        // to leave a trace, or the pipeline view of a `--from` run reads as though
        // the skipped stages never happened.
        await this.options.store.appendEvent(runId, 'stage_reused', {
          stage,
          reason: 'resumed_from_later_stage',
        });
        return existing;
      }
      // Falls through to running the stage: resuming from a later point with a
      // missing prerequisite is a broken resume, not a reason to proceed blind.
    }

    onProgress?.(stage, 'started');
    const definition = stage === 'sdd' ? SDD_STAGE : ARCHITECTURE_IMPACT_STAGE;
    const result = await this.options.stageRunner.run(definition, runId, vars);

    stagesRun.push(stage);
    onProgress?.(stage, 'completed');
    return result.text;
  }

  private renderProjectConfig(): string {
    const project = this.options.config.project;
    return project === undefined
      ? 'No project configuration found. Infer conventions from the repository itself.'
      : toYaml(project).trim();
  }

  /**
   * The validation ids a plan may reference, with the command behind each.
   *
   * The command is shown so the planner can choose sensibly; only the id is
   * ever accepted back. A plan cannot carry a command, so nothing the model
   * writes here can reach a shell.
   */
  private renderValidationCommands(): string {
    const registry = buildValidationRegistry(this.options.config.project);

    if (registry.ids.length === 0) {
      return 'None configured. Use an empty validation list for every task.';
    }

    return validationIdLines(registry).join('\n');
  }

  /** What the executor may run; unknown when the composition root did not say. */
  private executorCommands(): ExecutorCommands {
    return this.options.executorCommands ?? UNKNOWN_EXECUTOR;
  }

  /**
   * Whether the executor blocks render at all (FR-018, FR-019).
   *
   * Only when there is something to say: a validation id, or an executor that reports a
   * prefix or may run anything. Otherwise both blocks are the empty string, and the five
   * prompts are byte-for-byte the ones a commandless project was always sent (NFR-002) —
   * which is what `rendered-prompt-identity.test.ts` holds against fixtures captured before
   * any template was edited.
   */
  private rendersExecutorBlocks(registry: ValidationRegistry): boolean {
    const executor = this.executorCommands();
    return registry.ids.length > 0 || executor.prefixes.length > 0 || executor.any;
  }

  /**
   * The planner's executor block, appended to the validation ids (FR-018).
   *
   * It exists because a plan could ask the executor for a measurement it has no grant to
   * make — a build of another branch, a device matrix — and the executor then stops BLOCKED
   * mid-run on a refusal the planner could have foreseen. So the planner is told what the
   * executor can run, and where a measurement it cannot run goes instead.
   *
   * Starts with the blank line that separates it from the ids, so the placeholder sits on
   * the ids' own line and an empty value leaves the template exactly as it was.
   */
  private renderExecutorCommands(): string {
    const registry = buildValidationRegistry(this.options.config.project);
    if (!this.rendersExecutorBlocks(registry)) return '';

    const executor = this.executorCommands();
    const bounded = executor.known && !executor.any;
    return [
      '',
      '',
      '### What the executor may run',
      '',
      ...describeExecutor(executor),
      '',
      ...(bounded
        ? [
            'A task whose title, description or acceptance criteria cite, in code, a command that',
            'neither a validation id nor this list covers is rejected.',
            '',
          ]
        : []),
      'A measurement the executor cannot make — a build of another branch, a cherry-pick, a',
      'device matrix — is never a task. Put it in the plan\'s optional top-level',
      '`operatorVerifications`, one entry per check, and a person makes it:',
      '',
      '```json',
      '"operatorVerifications": [',
      '  { "check": "What to check, and how.", "reason": "Why the executor cannot." }',
      ']',
      '```',
      '',
      'Leave the field out when there is none. The commands in this subsection are command',
      'lines, not validation ids: the ids are the list before it.',
    ].join('\n');
  }

  /**
   * The plan reviewer's block, appended to the plan (FR-019).
   *
   * The reviewer used to see neither the validation ids nor what the executor can run, so
   * it could not notice a task asking for something nobody in the run would execute, nor a
   * gate the design requires that no task lists — the second is how a run could report
   * complete with a required gate that never ran. The mechanical citation check (FR-009)
   * reads only code spans in a declared family; this is its backstop (R-3).
   *
   * `requirer` names what states the gates: the SDD, or — for the simple workflow, which
   * has none — the feature request.
   */
  private renderExecutorContext(requirer: 'SDD' | 'feature request'): string {
    const registry = buildValidationRegistry(this.options.config.project);
    if (!this.rendersExecutorBlocks(registry)) return '';

    const ids = validationIdLines(registry);
    return [
      '',
      '',
      '## What can run',
      '',
      'Validation ids a task may list, each run by the orchestrator after the task:',
      '',
      ...(ids.length === 0 ? ['None configured.'] : ids),
      '',
      ...describeExecutor(this.executorCommands()),
      '',
      'Also flag, as a finding:',
      '',
      '- a task that asks the executor for something it cannot run — a command that neither a',
      '  validation id nor the executor\'s commands cover. That measurement belongs in the',
      '  plan\'s `operatorVerifications`, not in a task;',
      `- a gate the ${requirer} requires that no task lists in its \`validation\`.`,
    ].join('\n');
  }

  /** AGENTS.md, or CLAUDE.md when AGENTS.md has nothing of the repository's — see the module. */
  private async readAgentsMd(): Promise<string> {
    return (await readProjectInstructions(this.options.fs, this.options.projectDir)).text;
  }
}

/** Nothing claimed about the executor: what an absent `executorCommands` reads as. */
const UNKNOWN_EXECUTOR: ExecutorCommands = { known: false, any: false, prefixes: [] };

/** One line per validation id, with the command behind it, in registry order. */
function validationIdLines(registry: ValidationRegistry): string[] {
  return registry.ids.map((id) => `- ${id} (runs: ${registry.resolve(id) ?? ''})`);
}

/**
 * What the executor may run, in the words both prompt blocks share (FR-018, FR-019).
 *
 * Unknown is said as unknown rather than as "nothing": a runner that does not report its
 * grants may well run commands, and telling the planner it cannot would push measurements
 * the executor could make out to a person.
 */
function describeExecutor(executor: ExecutorCommands): string[] {
  if (!executor.known) {
    return [
      'The runner that implements the tasks does not report which commands it may run. Do not',
      'plan a task that depends on the executor running a command: a check belongs in a',
      'validation id, or in `operatorVerifications`.',
    ];
  }
  if (executor.any) return ['The executor that implements the tasks may run any command.'];
  if (executor.prefixes.length === 0) {
    return ['The executor that implements the tasks may run no command itself.'];
  }
  return [
    'The executor that implements the tasks may run these commands itself — each on its own,',
    'or followed by more arguments — and no other:',
    '',
    ...executor.prefixes.map((prefix) => `- \`${prefix}\``),
  ];
}

/** Cache key for discovery output. Currently informational. */
export function architectureCacheKey(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Collects deterministic repository path facts cheaply to feed workflow classification.
 * Scans top-level and first-level candidate directories without heavy recursive traversal.
 */
export async function collectRepoFactPaths(fs: FileSystem, projectDir: string): Promise<string[]> {
  const result: string[] = [];
  try {
    const top = await fs.readDir(projectDir);
    for (const entry of top) {
      if (entry.startsWith('.')) continue;
      result.push(entry);
      const sub = `${projectDir}/${entry}`;
      const stat = await fs.stat(sub);
      if (
        stat?.isDirectory &&
        ['src', 'lib', 'app', 'db', 'auth', 'payment', 'iam', 'migrations'].includes(entry.toLowerCase())
      ) {
        try {
          const children = await fs.readDir(sub);
          for (const child of children) {
            if (!child.startsWith('.')) {
              result.push(`${entry}/${child}`);
            }
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return result;
}
