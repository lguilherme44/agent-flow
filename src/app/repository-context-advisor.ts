import type { StageAdvisor, StageAdvisoryRequest } from './stage-runner.js';
import { renderAdvisoryContext } from '../core/advisory-context.js';
import type { RepositoryRetriever } from '../core/repository-retriever.js';
import {
  projectRepositoryRetrievalTelemetry,
  type ContextTelemetryProjectionTrust,
} from '../core/context-telemetry.js';
import type { ContextTelemetryRecorder } from './context-telemetry-recorder.js';

/**
 * The M3-08 production advisor: deterministic repository retrieval, ranked by a
 * local UtilityModel, rendered as an advisory block (§18).
 *
 * Everything about this class is optional by contract (§14.3):
 * - no configured model → bypass;
 * - model unavailable / failing → bypass;
 * - model-invented paths → rejected by the retriever's trust boundary → bypass;
 * - a broken repository → bypass.
 *
 * A bypass returns `undefined`, which the StageRunner treats as "run the stage
 * exactly as if M3 did not exist". It never throws to the stage, because
 * advisory context must never change stage control.
 *
 * When a recorder is wired, every retrieval outcome — success or bypass — is
 * projected into a mechanical telemetry observation, which is where the M3-07
 * projections gain their first production caller.
 */
export interface RepositoryContextAdvisorOptions {
  readonly retriever: RepositoryRetriever;
  readonly telemetry?: Pick<ContextTelemetryRecorder, 'record'>;
  readonly trust?: ContextTelemetryProjectionTrust;
}

export class RepositoryContextAdvisor implements StageAdvisor {
  private readonly retriever: RepositoryRetriever;
  private readonly telemetry?: Pick<ContextTelemetryRecorder, 'record'>;
  private readonly trust?: ContextTelemetryProjectionTrust;

  constructor(options: RepositoryContextAdvisorOptions) {
    this.retriever = options.retriever;
    this.telemetry = options.telemetry;
    this.trust = options.trust;
  }

  async advise(request: StageAdvisoryRequest): Promise<string | undefined> {
    try {
      const result = await this.retriever.retrieve({
        objective: request.objective,
        taskId: request.runId,
      });
      this.emit(result, request.runId);
      if (!result.ok) return undefined;
      return renderAdvisoryContext(result.packet)?.text;
    } catch {
      // Best effort by contract: advisory context never changes stage control.
      return undefined;
    }
  }

  private emit(result: unknown, runId: string): void {
    if (this.telemetry === undefined) return;
    const observation = projectRepositoryRetrievalTelemetry(result, this.trust);
    if (observation !== undefined) this.telemetry.record(runId, observation);
  }
}