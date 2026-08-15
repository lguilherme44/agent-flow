import { describe, expect, it } from 'vitest';
import { ProjectConfigSchema } from '../../src/contracts/index.js';
import {
  classifyWorkflow,
  getCeremonyBudget,
  evaluateStopCondition,
} from '../../src/core/adaptive-workflow.js';

describe('Adaptive Workflow Classifier', () => {
  it('classifies documentation and typos as TRIVIAL', () => {
    const res = classifyWorkflow('Fix typo in README documentation');
    expect(res.workflow).toBe('trivial');
    expect(res.deterministic).toBe(true);

    const budget = getCeremonyBudget(res.workflow);
    expect(budget.maxPlanningCalls).toBe(1);
    expect(budget.maxRevisionCycles).toBe(0);
    expect(budget.maxTasks).toBe(1);
  });

  it('classifies UI, theme and CSS features as SIMPLE', () => {
    const res = classifyWorkflow('Add dark mode theme toggle to the landing page');
    expect(res.workflow).toBe('simple');
    expect(res.deterministic).toBe(true);

    const budget = getCeremonyBudget(res.workflow);
    expect(budget.maxPlanningCalls).toBe(2);
    expect(budget.maxRevisionCycles).toBe(1);
    expect(budget.maxTasks).toBe(3);
  });

  it('classifies static-web stack projects as SIMPLE by default', () => {
    const res = classifyWorkflow('Add portfolio about section', {
      projectConfig: ProjectConfigSchema.parse({
        project: { name: 'my-portfolio', type: 'static-web' },
      }),
    });
    expect(res.workflow).toBe('simple');
  });

  it('classifies security, auth, migration and destructive requests as HIGH-RISK', () => {
    const testCases = [
      'Implement user authentication with JWT token refresh',
      'Run database migration to drop table legacy_users',
      'Integrate Stripe payment checkout billing flow',
      'Configure IAM permission roles and secret credentials in terraform',
    ];

    for (const testCase of testCases) {
      const res = classifyWorkflow(testCase);
      expect(res.workflow).toBe('high-risk');
      expect(res.highRiskSignalsDetected.length).toBeGreaterThan(0);

      const budget = getCeremonyBudget(res.workflow);
      expect(budget.maxPlanningCalls).toBe(5);
      expect(budget.maxRevisionCycles).toBe(3);
    }
  });

  it('refuses unsafe downgrades of HIGH-RISK requests to trivial, simple, or standard', () => {
    const overrides: Array<'trivial' | 'simple' | 'standard'> = ['trivial', 'simple', 'standard'];
    for (const explicitOverride of overrides) {
      const res = classifyWorkflow('Add auth token verification to payment gateway', {
        explicitOverride,
      });

      expect(res.workflow).toBe('high-risk');
      expect(res.rationale).toContain('refused');
      expect(res.highRiskSignalsDetected).toContain('auth');
      expect(res.highRiskSignalsDetected).toContain('token');
      expect(res.highRiskSignalsDetected).toContain('payment');
    }

    // Explicit override to high-risk is valid and preserved
    const validHighRisk = classifyWorkflow('Add auth token verification to payment gateway', {
      explicitOverride: 'high-risk',
    });
    expect(validHighRisk.workflow).toBe('high-risk');
    expect(validHighRisk.rationale).toContain('Explicit workflow override');
  });

  it('honors valid explicit overrides when no high-risk signals are present', () => {
    const res = classifyWorkflow('Add customer feedback form', {
      explicitOverride: 'high-risk',
    });
    expect(res.workflow).toBe('high-risk');
    expect(res.rationale).toContain('Explicit workflow override');
  });

  it('defaults to STANDARD for unclassified backend/feature requests', () => {
    const res = classifyWorkflow('Implement webhooks dispatcher for background jobs');
    expect(res.workflow).toBe('standard');
    const budget = getCeremonyBudget(res.workflow);
    expect(budget.maxPlanningCalls).toBe(5);
    expect(budget.maxRevisionCycles).toBe(2);
    expect(budget.maxTasks).toBe(8);
  });

  it('escalates to HIGH-RISK when repository files contain sensitive database/auth/payment paths', () => {
    const res = classifyWorkflow('Add user login and session handling', {
      files: ['src/auth/jwt.ts', 'src/db/migrations/001_users.sql'],
    });
    expect(res.workflow).toBe('high-risk');
    expect(res.highRiskSignalsDetected.some((s) => s.includes('auth'))).toBe(true);
  });
});

describe('Ceremony Budget Stop Conditions', () => {
  it('stops TRIVIAL workflow immediately if a revision is attempted', () => {
    const stop = evaluateStopCondition('trivial', 1, true);
    expect(stop.shouldStop).toBe(true);
    expect(stop.reason).toContain('TRIVIAL workflow does not support automated revision');
  });

  it('allows 1 revision cycle in SIMPLE workflow, then triggers STOP_AND_ASK_HUMAN', () => {
    const allowFirst = evaluateStopCondition('simple', 0, true);
    expect(allowFirst.shouldStop).toBe(false);

    const stopSecond = evaluateStopCondition('simple', 1, true);
    expect(stopSecond.shouldStop).toBe(true);
    expect(stopSecond.reason).toContain('STOP_AND_ASK_HUMAN');
  });

  it('allows up to 2 revision cycles in STANDARD workflow', () => {
    expect(evaluateStopCondition('standard', 1, true).shouldStop).toBe(false);
    expect(evaluateStopCondition('standard', 2, true).shouldStop).toBe(true);
    expect(evaluateStopCondition('standard', 2, true).reason).toContain('STOP_AND_ASK_HUMAN');
  });

  it('allows up to 3 revision cycles in HIGH-RISK workflow', () => {
    expect(evaluateStopCondition('high-risk', 2, true).shouldStop).toBe(false);
    expect(evaluateStopCondition('high-risk', 3, true).shouldStop).toBe(true);
    expect(evaluateStopCondition('high-risk', 3, true).reason).toContain('STOP_AND_ASK_HUMAN');
  });
});
