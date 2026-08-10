import type { FallbackEvent } from '../adapters/runners/fallback-runner.js';
import type { StateStore } from './state-store.js';

/**
 * Records a substitution on whichever run is in flight.
 *
 * Three separate mistakes lived in the inline version this replaces, and each
 * one on its own was enough to lose the record:
 *
 *   - The promise was discarded with `void`. `recordDegradation` is a
 *     read-modify-write on `state.json`, so the next write — a stage
 *     completing, a status change — started from a state read before the
 *     degradation existed and overwrote it.
 *   - The run id was captured once, when the context was built. A fallback
 *     during a run that started later recorded against the wrong id, or against
 *     `''`.
 *   - Failures were swallowed by the same `void`. `recordDegradation('')`
 *     throws `StateError`, and nobody ever saw it.
 *
 * A fallback is exactly the event a run must be able to explain afterwards: it
 * finished on a provider nobody configured for it. Losing that quietly is worse
 * than the fallback itself.
 */
export function recordFallback(store: StateStore) {
  return async (event: FallbackEvent): Promise<void> => {
    // Resolved when the fallback fires, not when the wiring was assembled.
    const runId = await store.currentRunId();
    if (runId === null) return;

    await store.recordDegradation(runId, {
      kind: 'runner_unavailable_with_fallback',
      reason: `runner "${event.from}" failed with ${event.errorCode}`,
      impact:
        `role "${event.config.role}" ran on "${event.to}" at ${event.config.reasoning}` +
        (event.reasoningClamped ? ' (clamped from the configured level)' : ''),
    });

    await store.appendEvent(runId, 'fallback_used', {
      role: event.config.role,
      from: event.from,
      to: event.to,
      errorCode: event.errorCode,
      reasoning: event.config.reasoning,
      reasoningClamped: event.reasoningClamped,
      ...(event.config.model === undefined ? {} : { model: event.config.model }),
    });
  };
}
