import {
  CONTEXT_TELEMETRY_EVENT_TYPE,
  type ContextTelemetryObservation,
} from '../contracts/context-telemetry.schema.js';
import { normalizeContextTelemetryObservation } from '../core/context-telemetry.js';
import type { StateStore } from './state-store.js';

type AuditAppender = Pick<StateStore, 'appendEvent'>;

/**
 * The only application seam allowed to append context observations.
 *
 * The call intentionally returns `void`: telemetry is an operational side
 * effect and a caller cannot accidentally await it before continuing a run.
 * Validation happens before the append is started, and every synchronous or
 * asynchronous persistence failure is swallowed without exposing its details.
 */
export class ContextTelemetryRecorder {
  constructor(private readonly audit: AuditAppender) {}

  record(runId: string, input: unknown): void {
    try {
      if (!/^AF-\d{4}-\d{3}$/.test(runId)) return;
      const observation = normalizeContextTelemetryObservation(input);
      if (observation === undefined) return;

      const pending = this.audit.appendEvent(runId, CONTEXT_TELEMETRY_EVENT_TYPE, {
        observation: snapshot(observation),
      });
      void Promise.resolve(pending).catch(() => undefined);
    } catch {
      // Best effort by contract. A telemetry failure never changes run control.
    }
  }
}

function snapshot(observation: ContextTelemetryObservation): ContextTelemetryObservation {
  return Object.freeze({ ...observation });
}
