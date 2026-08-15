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
  PLANNING_SIMPLE_STAGE,
  SDD_STAGE,
} from './stages/definitions.js';
import { checkPlan } from './stages/planning-checks.js';
import { buildValidationRegistry } from '../core/validation-registry.js';
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
} from '../core/adaptive-workflow.js';

/** Ordered stages of the planning half of the workflow. */
export const PLANNING_STAGES: readonly RunStage[] = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
];

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
  /** Maps a runner id to its provider, for judging review independence. */
  readonly providerOf: (runnerId: string) => string | undefined;
  readonly projectDir: string;
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

export class PlanningRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly action: string,
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
  readonly onProgress?: (
    stage: RunStage,
    status: 'started' | 'completed' | 'cached' | 'stale',
  ) => void;
}

export interface PipelineResult {
  readonly runId: string;
  readonly plan: Plan;
  readonly stagesRun: RunStage[];
  /** Absent when the pipeline was asked to stop before review. */
  readonly review?: ReviewResult;
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
      // Resolve workflow classification
      const state = await store.loadRun(runId);
      let workflow: WorkflowClass = options.workflow ?? state.workflow ?? 'standard';

      if (options.workflow !== undefined) {
        workflow = options.workflow;
        await store.updateRun(runId, (s) => ({ ...s, workflow }));
      } else if (state.workflow === undefined) {
        const classification = classifyWorkflow(featureRequest, {
          projectDir: this.options.projectDir,
          projectConfig: this.options.config.project,
        });
        workflow = classification.workflow;
        await store.updateRun(runId, (s) => ({ ...s, workflow }));
        await store.appendEvent(runId, 'workflow_classified', {
          workflow,
          rationale: classification.rationale,
          budget: getCeremonyBudget(workflow),
          highRiskSignals: classification.highRiskSignalsDetected,
        });
      }

      // §6.2, moment one: verify repository readiness at planning start
      await this.assertReady(runId, 'planning start');

      // ---- TRIVIAL workflow branch (1 model call)
      if (workflow === 'trivial') {
        options.onProgress?.('planning', 'started');
        const result = await this.options.stageRunner.run(PLANNING_SIMPLE_STAGE, runId, {
          featureRequest,
          projectConfig,
          validationCommands: this.renderValidationCommands(),
          agentsMd,
        });

        const plan = PlanSchema.parse(result.data);
        const problems = checkPlan(plan, '', buildValidationRegistry(this.options.config.project));
        if (plan.tasks.length > 1) {
          problems.push(`TRIVIAL workflow ceremony budget allows at most 1 task (got ${plan.tasks.length}).`);
        }

        if (problems.length > 0) {
          await store.appendEvent(runId, 'stage_failed', { stage: 'planning', problems });
          throw new StageFailure(
            'planning',
            'invalid_output',
            `The plan violates TRIVIAL ceremony budget/checks:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
            undefined,
            result.execution,
          );
        }

        stagesRun.push('planning');
        options.onProgress?.('planning', 'completed');
        await store.updateRun(runId, (s) => ({ ...s, status: 'waiting_for_approval' }));
        return { runId, plan, stagesRun };
      }

      // ---- SIMPLE workflow branch (2 model calls: short plan + plan review)
      if (workflow === 'simple') {
        options.onProgress?.('planning', 'started');
        const result = await this.options.stageRunner.run(PLANNING_SIMPLE_STAGE, runId, {
          featureRequest,
          projectConfig,
          validationCommands: this.renderValidationCommands(),
          agentsMd,
        });

        const plan = PlanSchema.parse(result.data);
        const plannerRunner = result.execution.runner;

        const problems = checkPlan(plan, '', buildValidationRegistry(this.options.config.project));
        if (plan.tasks.length > 3) {
          problems.push(`SIMPLE workflow ceremony budget allows at most 3 tasks (got ${plan.tasks.length}).`);
        }

        if (problems.length > 0) {
          await store.appendEvent(runId, 'stage_failed', { stage: 'planning', problems });
          throw new StageFailure(
            'planning',
            'invalid_output',
            `The plan violates SIMPLE ceremony budget/checks:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
            undefined,
            result.execution,
          );
        }

        stagesRun.push('planning');
        options.onProgress?.('planning', 'completed');

        if (options.skipReview === true) {
          await store.updateRun(runId, (s) => ({ ...s, status: 'waiting_for_approval' }));
          return { runId, plan, stagesRun };
        }

        // ---- Plan review
        options.onProgress?.('plan-review', 'started');
        const review = await this.planReview().reviewSimple({
          runId,
          plan,
          featureRequest,
          authors: [plannerRunner],
        });

        stagesRun.push('plan-review');
        options.onProgress?.('plan-review', 'completed');

        await store.updateRun(runId, (s) => ({
          ...s,
          status: review.verdict === 'PASS' ? 'waiting_for_approval' : 'plan_rejected',
        }));

        return { runId, plan, stagesRun, review };
      }

      // ---- STANDARD / HIGH-RISK workflows: Full ceremony
      // Discovery: feature-agnostic, therefore cacheable across runs (R-07).
      const architecture = await this.discover(runId, {
        projectConfig,
        agentsMd,
        useCache: !(options.noCache ?? false),
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
      options.onProgress?.('planning', 'started');
      const result = await this.options.stageRunner.run(PLANNING_STAGE, runId, {
        featureRequest,
        sdd,
        architectureImpact,
        projectConfig,
        validationCommands: this.renderValidationCommands(),
      });

      const plan = PlanSchema.parse(result.data);
      const plannerRunner = result.execution.runner;

      const problems = checkPlan(plan, sdd, buildValidationRegistry(this.options.config.project));
      if (problems.length > 0) {
        await store.appendEvent(runId, 'stage_failed', { stage: 'planning', problems });
        throw new StageFailure(
          'planning',
          'invalid_output',
          `The plan does not satisfy the SDD:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
          undefined,
          result.execution,
        );
      }

      stagesRun.push('planning');
      options.onProgress?.('planning', 'completed');

      if (options.skipReview === true) {
        await store.updateRun(runId, (s) => ({ ...s, status: 'waiting_for_approval' }));
        return { runId, plan, stagesRun };
      }

      // ---- Plan review, in a fresh context holding only the artifacts (§27).
      options.onProgress?.('plan-review', 'started');
      const review = await this.planReview().review({
        runId,
        plan,
        sdd,
        architectureImpact,
        authors: [plannerRunner],
      });

      stagesRun.push('plan-review');
      options.onProgress?.('plan-review', 'completed');

      await store.updateRun(runId, (s) => ({
        ...s,
        status: review.verdict === 'PASS' ? 'waiting_for_approval' : 'plan_rejected',
      }));

      return { runId, plan, stagesRun, review };
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
      onProgress: PipelineOptions['onProgress'];
      stagesRun: RunStage[];
    },
  ): Promise<string> {
    const { fs, projectDir } = this.options;
    const cachePath = agentFlowPaths(projectDir).architectureCache;

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
        return fs.readFile(cachePath);
      }

      context.onProgress?.('discovery', 'stale');
      if (cached !== null) {
        await this.options.store.appendEvent(runId, 'discovery_cache_invalidated', {
          changed: fingerprintDifferences(cached, fingerprint),
        });
      }
    }

    context.onProgress?.('discovery', 'started');
    const result = await this.options.stageRunner.run(DISCOVERY_STAGE, runId, {
      projectDir: this.options.projectDir,
      projectConfig: context.projectConfig,
      agentsMd: context.agentsMd,
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

    return registry.ids
      .map((id) => `- ${id} (runs: ${registry.resolve(id) ?? ''})`)
      .join('\n');
  }

  private async readAgentsMd(): Promise<string> {
    const path = `${this.options.projectDir}/AGENTS.md`;
    return (await this.options.fs.exists(path))
      ? this.options.fs.readFile(path)
      : 'No AGENTS.md in this repository.';
  }
}

/** Cache key for discovery output. Currently informational. */
export function architectureCacheKey(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}
