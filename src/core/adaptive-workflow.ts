import type { ProjectConfig } from '../contracts/index.js';

export const WORKFLOW_CLASSES = ['trivial', 'simple', 'standard', 'high-risk'] as const;
export type WorkflowClass = (typeof WORKFLOW_CLASSES)[number];

export interface CeremonyBudget {
  readonly workflow: WorkflowClass;
  readonly maxPlanningCalls: number;
  readonly maxRevisionCycles: number;
  readonly maxTasks: number;
}

export interface WorkflowClassificationResult {
  readonly workflow: WorkflowClass;
  readonly rationale: string;
  readonly deterministic: boolean;
  readonly confidence: number;
  readonly highRiskSignalsDetected: string[];
}

export interface WorkflowClassificationContext {
  readonly projectDir?: string;
  readonly projectConfig?: ProjectConfig;
  readonly isStaticWeb?: boolean;
  readonly explicitOverride?: WorkflowClass;
  readonly files?: readonly string[];
}

/**
 * Keywords that unequivocally indicate high architectural, security, or data risk.
 * A request containing these signals MUST NEVER be automatically downgraded to simple or trivial.
 */
export const HIGH_RISK_SIGNALS: readonly string[] = [
  'auth',
  'authentication',
  'authorization',
  'token',
  'jwt',
  'session',
  'password',
  'credential',
  'secret',
  'permission',
  'rbac',
  'iam',
  'crypto',
  'encryption',
  'decryption',
  'payment',
  'stripe',
  'billing',
  'checkout',
  'migration',
  'database migration',
  'drop table',
  'alter table',
  'schema change',
  'destructive',
  'hard delete',
  'data wipe',
  'infra',
  'infrastructure',
  'terraform',
  'cloudformation',
];

/**
 * Keywords that unequivocally describe trivial, localized edits.
 */
export const TRIVIAL_SIGNALS: readonly string[] = [
  'typo',
  'fix typo',
  'fix spelling',
  'update readme',
  'update documentation',
  'docstring',
  'comment',
  'license text',
  'bump version string',
];

/**
 * Keywords that describe simple scoped UI/styling/isolated tasks.
 */
export const SIMPLE_SIGNALS: readonly string[] = [
  'dark mode',
  'theme',
  'css',
  'style',
  'color',
  'spacing',
  'button style',
  'landing page',
  'header text',
  'favicon',
  'static web',
  'copy change',
  'tooltip text',
  'badge color',
  'font size',
  'layout padding',
];

/**
 * Returns the exact ceremony budget approved for a workflow class.
 */
export function getCeremonyBudget(workflow: WorkflowClass): CeremonyBudget {
  switch (workflow) {
    case 'trivial':
      return {
        workflow: 'trivial',
        maxPlanningCalls: 1,
        maxRevisionCycles: 0,
        maxTasks: 1,
      };
    case 'simple':
      return {
        workflow: 'simple',
        maxPlanningCalls: 2,
        maxRevisionCycles: 1,
        maxTasks: 3,
      };
    case 'standard':
      return {
        workflow: 'standard',
        maxPlanningCalls: 5,
        maxRevisionCycles: 2,
        maxTasks: 8,
      };
    case 'high-risk':
      return {
        workflow: 'high-risk',
        maxPlanningCalls: 5,
        maxRevisionCycles: 3,
        maxTasks: 8,
      };
  }
}

/**
 * Classifies a feature request into a workflow class using deterministic facts first.
 * High-risk signals monotonically elevate the workflow and prevent unsafe downgrades.
 */
export function classifyWorkflow(
  featureRequest: string,
  context: WorkflowClassificationContext = {},
): WorkflowClassificationResult {
  const normalized = featureRequest.toLowerCase();

  // Detect high risk signals from text
  const detectedHighRisk: string[] = HIGH_RISK_SIGNALS.filter((signal) => {
    // Exact word or substring boundary check
    const regex = new RegExp(`\\b${signal.replace(/\s+/g, '\\s+')}\\b`, 'i');
    return regex.test(normalized);
  });

  // Detect high risk signals from deterministic repository file facts
  if (context.files && context.files.length > 0) {
    for (const file of context.files) {
      const lowerFile = file.toLowerCase();
      if (
        (lowerFile.includes('auth/') || lowerFile.includes('auth.') || lowerFile.includes('authentication')) &&
        !detectedHighRisk.includes('auth')
      ) {
        if (normalized.includes('login') || normalized.includes('session') || normalized.includes('user') || normalized.includes('auth')) {
          detectedHighRisk.push('auth (file: ' + file + ')');
        }
      }
      if (
        (lowerFile.includes('migration') || lowerFile.includes('db/migrations') || lowerFile.includes('schema.')) &&
        !detectedHighRisk.includes('migration')
      ) {
        if (normalized.includes('db') || normalized.includes('table') || normalized.includes('database') || normalized.includes('schema')) {
          detectedHighRisk.push('migration (file: ' + file + ')');
        }
      }
      if (
        (lowerFile.includes('payment') || lowerFile.includes('stripe') || lowerFile.includes('billing')) &&
        !detectedHighRisk.includes('payment')
      ) {
        if (normalized.includes('pay') || normalized.includes('card') || normalized.includes('invoice') || normalized.includes('billing')) {
          detectedHighRisk.push('payment (file: ' + file + ')');
        }
      }
    }
  }

  // Handle explicit override
  if (context.explicitOverride) {
    // Safety Invariant: cannot downgrade a high-risk request to trivial or simple or standard without signaling
    if (
      detectedHighRisk.length > 0 &&
      (context.explicitOverride === 'trivial' || context.explicitOverride === 'simple')
    ) {
      return {
        workflow: 'high-risk',
        rationale:
          `Explicit override "${context.explicitOverride}" refused: high-risk security/data signals ` +
          `detected (${detectedHighRisk.join(', ')}). High-risk operations cannot be downgraded below standard safety.`,
        deterministic: true,
        confidence: 1.0,
        highRiskSignalsDetected: detectedHighRisk,
      };
    }

    return {
      workflow: context.explicitOverride,
      rationale: `Explicit workflow override set by operator to "${context.explicitOverride}".`,
      deterministic: true,
      confidence: 1.0,
      highRiskSignalsDetected: detectedHighRisk,
    };
  }

  // High-risk rule: any high-risk signal immediately elevates to HIGH-RISK
  if (detectedHighRisk.length > 0) {
    return {
      workflow: 'high-risk',
      rationale: `High-risk security/data/infrastructure signals detected: ${detectedHighRisk.join(', ')}.`,
      deterministic: true,
      confidence: 1.0,
      highRiskSignalsDetected: detectedHighRisk,
    };
  }

  // Trivial rule: obvious typo/doc request with low complexity
  const isTrivial = TRIVIAL_SIGNALS.some((sig) => {
    const regex = new RegExp(`\\b${sig.replace(/\s+/g, '\\s+')}\\b`, 'i');
    return regex.test(normalized);
  });
  if (isTrivial && normalized.length < 150) {
    return {
      workflow: 'trivial',
      rationale: 'Deterministic classification: trivial documentation, comment, or typographical fix.',
      deterministic: true,
      confidence: 0.95,
      highRiskSignalsDetected: [],
    };
  }

  // Simple rule: static-web or simple styling/isolated UI/dark mode feature
  const isStaticWeb =
    context.isStaticWeb === true ||
    context.projectConfig?.project?.type === 'static-web';
  const hasSimpleSignals = SIMPLE_SIGNALS.some((sig) => {
    const regex = new RegExp(`\\b${sig.replace(/\s+/g, '\\s+')}\\b`, 'i');
    return regex.test(normalized);
  });

  if (isStaticWeb || hasSimpleSignals) {
    return {
      workflow: 'simple',
      rationale:
        `Deterministic classification: scoped feature without cross-module architectural risks` +
        (isStaticWeb ? ' (static-web project)' : '') +
        (hasSimpleSignals ? ' (styling/isolated UI request)' : '') +
        '.',
      deterministic: true,
      confidence: 0.9,
      highRiskSignalsDetected: [],
    };
  }

  // Default: STANDARD (never use simple as ambiguous fallback)
  return {
    workflow: 'standard',
    rationale: 'Standard feature workflow requiring complete architectural discovery and SDD contract.',
    deterministic: true,
    confidence: 0.85,
    highRiskSignalsDetected: [],
  };
}

/**
 * Finding closure status produced by planner during revision cycles.
 */
export type FindingClosureStatus =
  | 'RESOLVED'
  | 'SUPERSEDED'
  | 'PROPOSE_ACCEPT_WITH_RATIONALE';

export interface FindingClosureItem {
  readonly findingIndex: number;
  readonly status: FindingClosureStatus;
  readonly rationale?: string;
}

/**
 * Verifies whether a workflow has exceeded its ceremony budget stop condition.
 */
export function evaluateStopCondition(
  workflow: WorkflowClass,
  revisionCount: number,
  hasFindings: boolean,
): { shouldStop: boolean; reason?: string } {
  const budget = getCeremonyBudget(workflow);

  if (workflow === 'trivial' && revisionCount > 0) {
    return {
      shouldStop: true,
      reason: 'TRIVIAL workflow does not support automated revision cycles (budget = 0).',
    };
  }

  if (workflow === 'simple' && revisionCount >= budget.maxRevisionCycles && hasFindings) {
    return {
      shouldStop: true,
      reason:
        'STOP_AND_ASK_HUMAN: SIMPLE workflow reached its maximum allowed revision cycle (1 cycle). ' +
        'Residual findings require human decision or workflow elevation.',
    };
  }

  if (revisionCount >= budget.maxRevisionCycles && hasFindings) {
    return {
      shouldStop: true,
      reason:
        `STOP_AND_ASK_HUMAN: ${workflow.toUpperCase()} workflow reached ceremony budget limit ` +
        `(${budget.maxRevisionCycles} revision cycles).`,
    };
  }

  return { shouldStop: false };
}
