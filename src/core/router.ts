import type { Task, WorkflowRole } from '../contracts/index.js';

/**
 * Task → executor role (§15).
 *
 * Deterministic code, not a model decision. The planner classifies a task —
 * complexity, risk, flags — and the router turns that classification into a
 * role. The spec is explicit about the split (§2.3): a model may describe the
 * work, but the choice of who runs it stays in code, because routing has to be
 * reproducible and auditable. The same plan must always route the same way.
 *
 * Overridable thresholds, but never an overridable *shape*: whatever a project
 * configures, the answer is still a pure function of the task.
 */

export interface RoutingPolicy {
  /**
   * Anything at or above this risk goes to the strongest executor, whatever its
   * complexity says. A one-line change to a widely used contract is cheap to
   * write and expensive to get wrong.
   */
  readonly complexAtRisk: Task['risk'];
  /** Flags that force the complex executor regardless of anything else. */
  readonly complexFlags: readonly (keyof Task['flags'])[];
  /** Trivial routing requires low risk as well; set false to route on complexity alone. */
  readonly trivialRequiresLowRisk: boolean;
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  complexAtRisk: 'high',
  complexFlags: ['architectureDecision', 'crossModule', 'externalIntegration'],
  trivialRequiresLowRisk: true,
};

const RISK_ORDER: readonly Task['risk'][] = ['low', 'medium', 'high'];

function atLeast(risk: Task['risk'], threshold: Task['risk']): boolean {
  return RISK_ORDER.indexOf(risk) >= RISK_ORDER.indexOf(threshold);
}

export function routeTask(
  task: Task,
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): WorkflowRole {
  // Checked before complexity: a task the planner called trivial can still be
  // the one that changes an interface everything depends on.
  if (policy.complexFlags.some((flag) => task.flags[flag])) return 'executor.complex';
  if (atLeast(task.risk, policy.complexAtRisk)) return 'executor.complex';

  if (task.complexity === 'complex') return 'executor.complex';

  if (task.complexity === 'trivial') {
    return policy.trivialRequiresLowRisk && task.risk !== 'low'
      ? 'executor.normal'
      : 'executor.trivial';
  }

  return 'executor.normal';
}

/** Explains a routing decision, for `status` and for logs. */
export function explainRouting(task: Task, policy: RoutingPolicy = DEFAULT_ROUTING_POLICY): string {
  const flag = policy.complexFlags.find((candidate) => task.flags[candidate]);
  if (flag) return `flag ${flag} is set`;
  if (atLeast(task.risk, policy.complexAtRisk)) return `risk is ${task.risk}`;
  if (task.complexity === 'complex') return 'complexity is complex';
  if (task.complexity === 'trivial' && policy.trivialRequiresLowRisk && task.risk !== 'low') {
    return `trivial but risk is ${task.risk}`;
  }
  return `complexity is ${task.complexity}`;
}
