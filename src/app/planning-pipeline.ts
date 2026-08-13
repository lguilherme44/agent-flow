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
) => Promise<string | null>;

export interface PipelineOptions {
  /** Re-runs discovery even when a valid cache exists. */
  readonly noCache?: boolean;
  /** Resumes from a stage, keeping the artifacts already produced. */
  readonly from?: RunStage;
  /** Stops after planning, without the automated review. */
  readonly skipReview?: boolean;
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
 * Runs discovery → impact → SDD → planning.
 *
 * State is persisted after every stage rather than at the end (R-08). With the
 * default configuration this pipeline is four expensive calls, and losing the
 * first three because the fourth failed is a bad trade — especially against a
 * subscription quota.
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

    // §6.2, moment one: the map, the SDD and the plan must describe one tree.
    await this.assertReady(runId, 'planning start');

    // ---- Discovery: feature-agnostic, therefore cacheable across runs (R-07).
    const architecture = await this.discover(runId, {
      projectConfig,
      agentsMd,
      useCache: !(options.noCache ?? false),
      onProgress: options.onProgress,
      stagesRun,
    });

    // §6.2, moment two: a stage that observed a different tree from its
    // predecessor produces an artifact that silently disagrees with the one
    // before it. Checked between stages rather than only at the ends.
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
    // Who actually produced the plan — not who was configured to. A fallback
    // may have sent it elsewhere, and that is precisely what decides whether
    // the review that follows is independent of it.
    const plannerRunner = result.execution.runner;

    // Coverage, validation ids and graph checks run after the schema, because
    // they need the SDD and the project config as well. A plan that fails here
    // is a planning failure, not bad luck.
    const problems = checkPlan(plan, sdd, buildValidationRegistry(this.options.config.project));
    if (problems.length > 0) {
      await store.appendEvent(runId, 'stage_failed', { stage: 'planning', problems });
      throw new StageFailure(
        'planning',
        'invalid_output',
        `The plan does not satisfy the SDD:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
        undefined,
        // The plan parsed and then failed a check agent-flow makes itself. It
        // was still written by somebody, and the run should be able to say by
        // whom — the answer is already in hand a few lines above.
        result.execution,
      );
    }

    stagesRun.push('planning');
    options.onProgress?.('planning', 'completed');

    if (options.skipReview === true) {
      await store.updateRun(runId, (state) => ({ ...state, status: 'waiting_for_approval' }));
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

    await store.updateRun(runId, (state) => ({
      ...state,
      status: review.verdict === 'PASS' ? 'waiting_for_approval' : 'plan_rejected',
    }));

    return { runId, plan, stagesRun, review };
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
    const reason = await this.options.planningBaseGate?.(runId, moment);
    if (reason === null || reason === undefined) return;

    throw new StageFailure('planning', 'invalid_output', reason);
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
