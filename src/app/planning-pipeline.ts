import { createHash } from 'node:crypto';
import { stringify as toYaml } from 'yaml';
import type { EffectiveConfig, Plan, ReviewResult, RunStage } from '../contracts/index.js';
import { PlanSchema } from '../contracts/index.js';
import type { Clock, FileSystem, ProcessRunner } from '../ports/index.js';
import type { StageRunner } from './stage-runner.js';
import { StageFailure } from './stage-runner.js';
import type { StateStore } from './state-store.js';
import { agentFlowPaths } from './paths.js';
import { resolveRole, type RunnerCapabilitiesMap } from '../core/role.js';
import {
  PLAN_REVIEW_STAGE,
  PlanReviewResponseSchema,
  buildReviewResult,
  reviewIndependence,
} from './stages/plan-review.js';
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
  readonly store: StateStore;
  readonly stageRunner: StageRunner;
  readonly config: EffectiveConfig;
  readonly capabilities: RunnerCapabilitiesMap;
  readonly projectDir: string;
}

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

    // ---- Discovery: feature-agnostic, therefore cacheable across runs (R-07).
    const architecture = await this.discover(runId, {
      projectConfig,
      agentsMd,
      useCache: !(options.noCache ?? false),
      onProgress: options.onProgress,
      stagesRun,
    });

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
    const review = await this.review(runId, {
      sdd,
      architectureImpact,
      plan: JSON.stringify(plan, null, 2),
    });

    stagesRun.push('plan-review');
    options.onProgress?.('plan-review', 'completed');

    await store.updateRun(runId, (state) => ({
      ...state,
      status: review.verdict === 'PASS' ? 'waiting_for_approval' : 'plan_rejected',
    }));

    return { runId, plan, stagesRun, review };
  }

  private async review(
    runId: string,
    vars: Record<string, string>,
  ): Promise<ReviewResult> {
    const { store, config } = this.options;
    const independence = reviewIndependence(config.global);

    if (independence === 'same-provider-fresh-context') {
      // §56 allows this, but the protection cross-provider review exists to
      // provide is simply absent — so it is recorded on the run rather than
      // left for a reader to infer from configuration they cannot see (R-16).
      await store.recordDegradation(runId, {
        kind: 'single_provider',
        reason: 'the planner and the plan reviewer are configured to the same runner',
        impact:
          'the plan review is same-provider: a wrong assumption made while planning may be ' +
          'repeated rather than caught',
      });
    }

    const result = await this.options.stageRunner.run(PLAN_REVIEW_STAGE, runId, vars);
    const response = PlanReviewResponseSchema.parse(result.data);

    const reviewer = resolveRole('planReviewer', config.global, this.options.capabilities, {
      readOnly: true,
    });

    const review = buildReviewResult(
      response,
      {
        runner: reviewer.runner,
        ...(reviewer.model === undefined ? {} : { model: reviewer.model }),
        reasoning: reviewer.reasoning,
      },
      independence,
    );

    await store.writeArtifact(runId, 'planReview', `${JSON.stringify(review, null, 2)}\n`);
    return review;
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
      processRunner: this.options.processRunner,
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
