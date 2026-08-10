import type { GlobalConfig } from '../contracts/index.js';
import type { AgentRunner } from '../ports/agent-runner.js';
import type { RunnerRegistry } from '../adapters/runners/registry.js';
import { FallbackRunner, type FallbackEvent } from '../adapters/runners/fallback-runner.js';
import { resolveFallback, type ResolvedAgentConfig } from '../core/role.js';

export interface RunnerFactoryOptions {
  readonly registry: RunnerRegistry;
  readonly config: GlobalConfig;
  /** Runner ids already known to be unusable, from `doctor` or a health check. */
  readonly unhealthy?: ReadonlySet<string>;
  readonly onFallback?: (event: FallbackEvent) => void | Promise<void>;
}

/**
 * Produces the runner a resolved role should execute on.
 *
 * This is where fallback stops being configuration and becomes behaviour.
 * Before this existed, `FallbackRunner` was constructed only by its own tests:
 * the runtime asked the registry for a runner by id and got a bare adapter, so
 * a configured fallback did nothing at all — while `doctor` still counted it
 * when deciding whether a role had a route. Doctor and runtime disagreed, and
 * doctor was the optimistic one.
 *
 * Wrapping happens per role rather than per runner, because a fallback belongs
 * to a role: two roles on the same runner can fall back to different places,
 * with different models and different effort.
 */
export function createRunnerFactory(
  options: RunnerFactoryOptions,
): (resolved: ResolvedAgentConfig) => AgentRunner {
  const { registry, config, unhealthy, onFallback } = options;

  return (resolved) => {
    const fallback = resolveFallback(resolved.role, config, registry.capabilities());

    // Nothing to fall back to, and the primary is fine: the plain adapter.
    if (fallback === undefined) return registry.get(resolved.runner);

    const primaryUnhealthy = unhealthy?.has(resolved.runner) === true;

    return new FallbackRunner({
      primary: registry.get(resolved.runner),
      secondary: registry.get(fallback.runner),
      secondaryConfig: fallback,
      triggers: config.fallback.on,
      ...(primaryUnhealthy ? { primaryUnhealthy: true } : {}),
      ...(onFallback === undefined ? {} : { onFallback }),
    });
  };
}
