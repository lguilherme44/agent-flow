import {
  ALL_WORKFLOW_ROLES,
  roleConfigOf,
  type Degradation,
  type GlobalConfig,
  type HealthStatus,
  type WorkflowRole,
} from '../contracts/index.js';

/**
 * Environment health, computed over *routes* rather than runners (AD-15).
 *
 * A broken runner is not automatically a broken environment. What matters is
 * whether every configured role still has somewhere to run — its primary, or a
 * healthy fallback. Failing the whole tool because one of two CLIs is down would
 * block work that is perfectly possible.
 *
 * The risk that creates is the opposite one: DEGRADED quietly becoming the
 * normal state while nobody notices that reviews stopped being cross-provider.
 * So every degradation carries the concrete capability that was lost, and the
 * caller persists it on the run (R-16). "Environment degraded" on its own would
 * be a warning nobody reads.
 *
 * Pure: it receives observed runner state and configuration, and returns a
 * verdict. The combinatorics here are wide enough that being able to test the
 * whole truth table without touching a process matters.
 */

export interface ObservedRunner {
  readonly id: string;
  readonly installed: boolean;
  readonly executable: boolean;
  readonly auth: 'configured' | 'not_configured' | 'available' | 'unknown';
}

export interface RoleRoute {
  readonly role: WorkflowRole;
  readonly primary: string;
  /** The runner that would actually be used. Null when there is none. */
  readonly effective: string | null;
  readonly viaFallback: boolean;
}

export interface HealthVerdict {
  readonly status: HealthStatus;
  readonly routes: RoleRoute[];
  /** Roles with no healthy primary and no healthy fallback. */
  readonly orphanRoles: WorkflowRole[];
  /**
   * Lost capabilities, ready to persist; the caller stamps `detectedAt`.
   * Only these move the verdict to DEGRADED.
   */
  readonly degradations: Omit<Degradation, 'detectedAt'>[];
  /** Worth printing, but not a lost capability. Never affects the verdict. */
  readonly notes: string[];
}

/**
 * A runner is usable when it is present, runnable, and not known to lack
 * credentials.
 *
 * `unknown` counts as usable on purpose: the shallow check does not probe auth,
 * because doing so costs quota on every `doctor` (R-14). Treating "not checked"
 * as "broken" would make the default invocation useless.
 */
export function isUsable(runner: ObservedRunner): boolean {
  return runner.installed && runner.executable && runner.auth !== 'not_configured';
}

export function assessHealth(
  config: GlobalConfig,
  observed: readonly ObservedRunner[],
): HealthVerdict {
  const usable = new Set(observed.filter(isUsable).map((runner) => runner.id));

  const routes: RoleRoute[] = [];
  const orphanRoles: WorkflowRole[] = [];
  const degradations: Omit<Degradation, 'detectedAt'>[] = [];
  const fallbackUsed = new Set<string>();

  for (const role of ALL_WORKFLOW_ROLES) {
    const primary = roleConfigOf(config.roles, role).runner;

    if (usable.has(primary)) {
      routes.push({ role, primary, effective: primary, viaFallback: false });
      continue;
    }

    const fallback = config.fallback.enabled ? config.fallback.roles[role]?.runner : undefined;

    if (fallback !== undefined && usable.has(fallback)) {
      routes.push({ role, primary, effective: fallback, viaFallback: true });
      fallbackUsed.add(`${primary}→${fallback}`);
      continue;
    }

    routes.push({ role, primary, effective: null, viaFallback: false });
    orphanRoles.push(role);
  }

  for (const substitution of [...fallbackUsed].sort()) {
    const [from, to] = substitution.split('→');
    degradations.push({
      kind: 'runner_unavailable_with_fallback',
      reason: `runner "${String(from)}" is not usable`,
      impact: `roles configured for "${String(from)}" will run on "${String(to)}" instead`,
    });
  }

  // The degradation that actually costs something. §3.2 says cross-provider
  // review exists to stop one model confirming its own mistaken hypothesis;
  // with a single provider that protection is simply gone, and a report that
  // does not say so is omitting the main thing.
  const usableProviders = [...usable];
  if (usableProviders.length === 1 && observed.length > 1) {
    degradations.push({
      kind: 'single_provider',
      reason: `only "${String(usableProviders[0])}" is usable`,
      impact:
        'plan review and final review cannot be cross-provider; they will run same-provider ' +
        'with a fresh context, which does not protect against a repeated wrong assumption',
    });
  }

  const status: HealthStatus =
    orphanRoles.length > 0 || usable.size === 0
      ? 'FAIL'
      : degradations.length > 0
        ? 'DEGRADED'
        : 'OK';

  // Informational, and deliberately *not* a degradation.
  //
  // The shallow check never probes authentication, so this would be true on
  // every healthy machine — and a DEGRADED that is always on is worth nothing.
  // The whole reason for a ternary verdict is that DEGRADED means a capability
  // was actually lost; diluting it with "we did not check" would recreate the
  // problem the model exists to avoid.
  const unverified = observed
    .filter((runner) => isUsable(runner) && runner.auth === 'unknown')
    .map((runner) => runner.id);

  const notes =
    unverified.length > 0
      ? [
          `authentication not verified for: ${unverified.join(', ')} ` +
            '(use `doctor --deep` to check for real)',
        ]
      : [];

  return { status, routes, orphanRoles, degradations, notes };
}

/**
 * What a live probe found.
 *
 * Deliberately narrower than the runner error codes. The shallow check asks
 * "could this run?" and a probe answers it with evidence, so only the outcomes
 * that change that answer get their own name. Everything else — a timeout, a
 * malformed reply, a non-zero exit — is `execution_failed`: the runner was
 * reachable and authenticated, and something about *this call* went wrong. That
 * distinction is the same one §55 draws for fallback, and for the same reason.
 */
export const PROBE_OUTCOMES = [
  'healthy',
  'auth_required',
  'runner_unavailable',
  'quota_exceeded',
  'execution_failed',
] as const;

export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

export interface ProbeObservation {
  readonly id: string;
  readonly outcome: ProbeOutcome;
}

/**
 * Folds probe evidence back into what was observed shallowly.
 *
 * The shallow check leaves `auth: 'unknown'` on every runner, because verifying
 * credentials costs quota and `doctor` must stay free (R-14). Its own note says
 * to use `--deep` "to check for real" — so when `--deep` does check, the answer
 * has to reach the verdict rather than being printed beside it.
 *
 * Two outcomes deliberately change nothing:
 *
 *   - `quota_exceeded` means the credentials work and the budget does not, which
 *     is a property of a billing window rather than of this machine. Failing the
 *     environment on it would make `doctor --strict` flap in CI for a condition
 *     that resolves itself.
 *   - `execution_failed` is a bad call, not a broken runner. Treating output
 *     quality as an infrastructure fault is precisely what the fallback policy
 *     forbids, and the same reasoning applies here.
 *
 * Both are still reported to the reader. Silent is not the same as ignored.
 */
export function withProbeEvidence(
  observed: readonly ObservedRunner[],
  probes: readonly ProbeObservation[],
): ObservedRunner[] {
  const byId = new Map(probes.map((probe) => [probe.id, probe.outcome]));

  return observed.map((runner) => {
    switch (byId.get(runner.id)) {
      case 'healthy':
      case 'quota_exceeded':
        // It answered, which is the only direct evidence of working credentials
        // this tool can obtain without reading them.
        return { ...runner, auth: 'available' as const };
      case 'auth_required':
        return { ...runner, auth: 'not_configured' as const };
      case 'runner_unavailable':
        return { ...runner, executable: false };
      default:
        return runner;
    }
  });
}

/** Runners referenced by configuration, in declaration order. */
export function referencedRunners(config: GlobalConfig): string[] {
  const seen = new Set<string>();
  for (const role of ALL_WORKFLOW_ROLES) seen.add(roleConfigOf(config.roles, role).runner);
  for (const roleConfig of Object.values(config.fallback.roles)) seen.add(roleConfig.runner);
  return [...seen];
}
