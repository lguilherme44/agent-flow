import { describe, expect, it } from 'vitest';
import { ProjectConfigSchema } from '../../src/contracts/index.js';
import {
  classifyWorkflow,
  getCeremonyBudget,
  evaluateStopCondition,
  nextWorkflowClass,
} from '../../src/core/adaptive-workflow.js';

describe('nextWorkflowClass (FR-014)', () => {
  it('steps each class up by one', () => {
    expect(nextWorkflowClass('trivial')).toBe('simple');
    expect(nextWorkflowClass('simple')).toBe('standard');
    expect(nextWorkflowClass('standard')).toBe('high-risk');
  });

  it('has nowhere to go from high-risk', () => {
    expect(nextWorkflowClass('high-risk')).toBeUndefined();
  });
});

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

    const authDotRes = classifyWorkflow('Configure user session', { files: ['src/auth.config.ts'] });
    expect(authDotRes.workflow).toBe('high-risk');

    const authenticationRes = classifyWorkflow('Fix login authentication endpoint', {
      files: ['src/authentication/handler.ts'],
    });
    expect(authenticationRes.workflow).toBe('high-risk');

    const migrationRes = classifyWorkflow('Alter database table schema', {
      files: ['db/migrations/002_accounts.sql'],
    });
    expect(migrationRes.workflow).toBe('high-risk');
    expect(migrationRes.highRiskSignalsDetected.some((s) => s.includes('migration'))).toBe(true);

    const paymentRes = classifyWorkflow('Process customer billing invoice and card payment', {
      files: ['src/services/payment.ts'],
    });
    expect(paymentRes.workflow).toBe('high-risk');
    expect(paymentRes.highRiskSignalsDetected.some((s) => s.includes('payment'))).toBe(true);

    const cardRes = classifyWorkflow('Process card verification', { files: ['src/stripe/client.ts'] });
    expect(cardRes.workflow).toBe('high-risk');

    const invoiceRes = classifyWorkflow('Send invoice reminder', { files: ['src/billing/api.ts'] });
    expect(invoiceRes.workflow).toBe('high-risk');

    const nonCorrelated = classifyWorkflow('Update banner styling in UI', {
      files: ['src/db/migrations/002.sql', 'src/services/payment.ts'],
    });
    expect(nonCorrelated.workflow).toBe('standard');
    expect(nonCorrelated.highRiskSignalsDetected).toHaveLength(0);
  });

  /**
   * Both halves of the file-fact rule used to be substring tests, and both were measured
   * producing a refusal on work that touches no data, no money and no identity.
   *
   * This matters more than a mis-labelled workflow: an explicit `--workflow standard` is
   * overridden once a signal is detected, and HIGH-RISK refreshes discovery and demands the
   * full ceremony. A false positive here is every run in that repository paying for both.
   */
  it('does not escalate on words that merely contain a signal, or on paths that merely contain one', () => {
    // `unselectable` contains `table`. Measured on a real request: a Flutter app whose
    // product directory is `migration_partner/` (a user migrated between storefronts,
    // not a schema migration) was refused planning over this sentence.
    const prose = classifyWorkflow(
      'Expanding image/* to jpg and png makes a HEIC photo unselectable on devices that shoot HEIC by default',
      { files: ['lib/src/features/migration_partner/pages/migrated_to_partner_page.dart'] },
    );
    expect(prose.workflow).toBe('standard');
    expect(prose.highRiskSignalsDetected).toHaveLength(0);

    // The path alone must not arm the rule, even when the prose does mention data words.
    const productDirectory = classifyWorkflow('Alter the lookup table used by the mapper', {
      files: ['lib/src/features/migration_partner/utils/file_selector.dart'],
    });
    expect(productDirectory.workflow).toBe('standard');
    expect(productDirectory.highRiskSignalsDetected).toHaveLength(0);

    // The word half, ISOLATED: a path that genuinely names the concern, with prose whose
    // only "match" is a substring inside an unrelated word. Without the word check this
    // escalates; the previous two cases cannot catch that, because the path fix alone
    // already stops them before the prose is consulted.
    const substringOnly = classifyWorkflow('Make the HEIC photo unselectable in the picker', {
      files: ['db/migrations/001_users.sql'],
    });
    expect(substringOnly.workflow).toBe('standard');
    expect(substringOnly.highRiskSignalsDetected).toHaveLength(0);

    // Same shape for the other two concerns.
    const authorRes = classifyWorkflow('Show the post author and let the user edit it', {
      files: ['src/features/author/profile.ts'],
    });
    expect(authorRes.workflow).toBe('standard');

    const paymentishRes = classifyWorkflow('Rename the invoice column header', {
      files: ['src/ui/repayment_banner.ts'],
    });
    expect(paymentishRes.workflow).toBe('standard');

    // Positive control: the real thing still escalates, so the narrowing did not blind it.
    const genuine = classifyWorkflow('Alter database table schema', {
      files: ['lib/src/features/migration_partner/x.dart', 'db/migrations/003_orders.sql'],
    });
    expect(genuine.workflow).toBe('high-risk');
    expect(genuine.highRiskSignalsDetected.some((s) => s.includes('migration'))).toBe(true);
  });
});

describe('negation-aware high-risk signals (FR-010, FR-011)', () => {
  it('does not count a high-risk word a negator covers, and records it as negated evidence', () => {
    const res = classifyWorkflow('não trafega token nem dado de sessão');
    expect(res.workflow).not.toBe('high-risk');
    expect(res.highRiskSignalsDetected).toEqual([]);
    expect(res.evidence).toContainEqual({
      signal: 'token',
      excerpt: 'não trafega token nem dado de sessão',
      source: 'text',
      negated: true,
    });

    // Positive control: the same words without the negator are high-risk, so the negator
    // is what took the signal out.
    expect(classifyWorkflow('trafega token nem dado de sessão').workflow).toBe('high-risk');
  });

  it('keeps high-risk what is not negated, including the hyphen and possessive forms', () => {
    const requests = [
      'corrigir a expiração no token JWT',
      // `sem` is three words before `token`, outside the two-word window.
      'corrigir o login sem expor o token',
      'criar a migration que adiciona a coluna status',
      'fix the auth-token refresh',
      'move the session-store',
      'run the pre-migration check',
      "rotate the token's secret",
    ];
    for (const request of requests) {
      const res = classifyWorkflow(request);
      expect(res.workflow, request).toBe('high-risk');
      expect(res.evidence.filter((e) => e.negated !== true).length, request).toBeGreaterThan(0);
    }
  });

  it('ends the negation at a sentence break, and only at a real one', () => {
    expect(classifyWorkflow('Não mexe no CSS. Token rotation for the API').workflow).toBe('high-risk');
    expect(classifyWorkflow('Não. Token rotation for the API').workflow).toBe('high-risk');
    expect(classifyWorkflow('Sem\ntoken rotation for the API').workflow).toBe('high-risk');
    expect(classifyWorkflow('never state; token rotation').workflow).toBe('high-risk');
    // Positive control: without the break the negator reaches the signal.
    expect(classifyWorkflow('Não token rotation for the API').workflow).not.toBe('high-risk');
    // A `.` not followed by whitespace, as in `run-actions.ts`, does not break a sentence.
    expect(classifyWorkflow('never state.token rotation').workflow).not.toBe('high-risk');
  });

  it('does not treat `no` or `nem` as negators', () => {
    const res = classifyWorkflow('não trafega token nem session');
    expect(res.workflow).toBe('high-risk');
    expect(res.highRiskSignalsDetected).toEqual(['session']);
  });

  it('counts the window before the first word of a multi-word signal', () => {
    const res = classifyWorkflow('ship it without database migration');
    expect(res.workflow).not.toBe('high-risk');
    expect(res.evidence.filter((e) => e.negated === true).map((e) => e.signal)).toEqual(
      expect.arrayContaining(['migration', 'database migration']),
    );
  });

  it('counts a signal when any one of its occurrences is not negated', () => {
    const res = classifyWorkflow('sem token aqui; troca o token da API');
    expect(res.workflow).toBe('high-risk');
    expect(res.evidence).toContainEqual({ signal: 'token', excerpt: 'troca o token da API', source: 'text' });
    expect(res.evidence).toContainEqual({ signal: 'token', excerpt: 'sem token aqui', source: 'text', negated: true });
  });

  it('applies negation to the file-fact mention words', () => {
    const negated = classifyWorkflow('Rename the report, without user changes', { files: ['src/auth/jwt.ts'] });
    expect(negated.workflow).toBe('standard');
    expect(negated.evidence).toContainEqual({
      signal: 'auth',
      excerpt: 'Rename the report, without user changes',
      source: 'file',
      file: 'src/auth/jwt.ts',
      negated: true,
    });

    // Positive control: the same path with the mention not negated still escalates.
    const counted = classifyWorkflow('Rename the report for the user', { files: ['src/auth/jwt.ts'] });
    expect(counted.workflow).toBe('high-risk');
    expect(counted.evidence).toContainEqual({
      signal: 'auth',
      excerpt: 'Rename the report for the user',
      source: 'file',
      file: 'src/auth/jwt.ts',
    });
    expect(counted.rationale).toContain('"Rename the report for the user"');
  });
});

describe('the cross-module guard on simple (FR-012)', () => {
  const request = 'Change the button color in the Deck feed rendered by run-actions.ts';

  it('keeps a styling request that names cross-module code out of simple, quoting both excerpts', () => {
    const res = classifyWorkflow(request);
    expect(res.workflow).toBe('standard');
    expect(res.rationale).toContain(`color "${request}"`);
    expect(res.rationale).toContain(`run-actions "${request}"`);
    expect(res.evidence).toEqual([
      { signal: 'color', excerpt: request, source: 'text' },
      { signal: 'run-actions', excerpt: request, source: 'text' },
    ]);

    // Positive control: without the cross-module mention the styling words still decide.
    expect(classifyWorkflow('Change the button color in the Deck feed').workflow).toBe('simple');
  });

  it('matches every cross-module term, with `.` literal', () => {
    for (const term of ['scheduler', 'state.json', 'state-store', 'state.schema']) {
      expect(classifyWorkflow(`Adjust the badge color shown by the ${term} module`).workflow, term).toBe('standard');
    }
    // `.` is literal: `stateXjson` is not `state.json`.
    expect(classifyWorkflow('Adjust the badge color shown by stateXjson').workflow).toBe('simple');
  });

  it('leaves the trivial, high-risk and static-web rules and their order unchanged', () => {
    expect(classifyWorkflow('Fix typo in the run-actions.ts color label').workflow).toBe('trivial');
    expect(classifyWorkflow('Change the token color in run-actions.ts').workflow).toBe('high-risk');
    const staticWeb = classifyWorkflow(request, {
      projectConfig: ProjectConfigSchema.parse({ project: { name: 'site', type: 'static-web' } }),
    });
    expect(staticWeb.workflow).toBe('simple');
  });
});

describe('classification evidence (FR-013)', () => {
  it('cuts the excerpt to the sentence around the match, with whitespace collapsed', () => {
    const res = classifyWorkflow('First we tidy up.   Then   the\ttoken   refresh moves! Done.');
    expect(res.evidence).toEqual([{ signal: 'token', excerpt: 'Then the token refresh moves', source: 'text' }]);
    expect(res.rationale).toBe(
      'High-risk security/data/infrastructure signals detected: token "Then the token refresh moves".',
    );
  });

  it('centres a long sentence on the match, at most 80 characters, with an ellipsis where cut', () => {
    const filler = 'lorem ipsum dolor sit amet '.repeat(6);
    const res = classifyWorkflow(`${filler}the token refresh ${filler}`);
    const [entry] = res.evidence;
    expect(entry?.signal).toBe('token');
    expect(entry?.excerpt.length).toBeLessThanOrEqual(80);
    expect(entry?.excerpt.startsWith('…')).toBe(true);
    expect(entry?.excerpt.endsWith('…')).toBe(true);
    expect(entry?.excerpt).toContain('the token refresh');
    expect(res.rationale).toContain(`token "${entry?.excerpt}"`);

    // Cut on one side only: the match near the start keeps the start and loses the end.
    const early = classifyWorkflow(`Rotate the token ${filler}`).evidence[0]?.excerpt ?? '';
    expect(early.length).toBeLessThanOrEqual(80);
    expect(early.startsWith('Rotate the token')).toBe(true);
    expect(early.endsWith('…')).toBe(true);
  });

  it('records the deciding trivial or simple signal', () => {
    expect(classifyWorkflow('Fix typo in README documentation').evidence).toEqual([
      { signal: 'typo', excerpt: 'Fix typo in README documentation', source: 'text' },
    ]);
    const simple = classifyWorkflow('Add dark mode theme toggle to the landing page');
    expect(simple.evidence).toEqual([
      { signal: 'dark mode', excerpt: 'Add dark mode theme toggle to the landing page', source: 'text' },
    ]);
    expect(simple.rationale).toContain('dark mode "Add dark mode theme toggle to the landing page"');
  });

  it('keeps the default rationale when no signal decided', () => {
    const res = classifyWorkflow('Implement webhooks dispatcher for background jobs');
    expect(res.evidence).toEqual([]);
    expect(res.rationale).toBe('Standard feature workflow requiring complete architectural discovery and SDD contract.');
  });
});

describe('classification origin (FR-014)', () => {
  it('is detected without an override', () => {
    const res = classifyWorkflow('Implement webhooks dispatcher for background jobs');
    expect(res.origin).toBe('detected');
    expect(res.detected).toBe('standard');
    expect(res.requested).toBeUndefined();
  });

  it('is operator for an override with no origin, or with origin operator', () => {
    for (const context of [{}, { overrideOrigin: 'operator' as const }]) {
      const res = classifyWorkflow('Add customer feedback form', { explicitOverride: 'simple', ...context });
      expect(res.workflow).toBe('simple');
      expect(res.origin).toBe('operator');
      expect(res.requested).toBe('simple');
      expect(res.detected).toBe('standard');
      expect(res.rationale).toContain('set by operator');
    }
  });

  it('is carried for a carried class, whose rationale never says the operator set it', () => {
    const carried = classifyWorkflow('Add customer feedback form', {
      explicitOverride: 'standard',
      overrideOrigin: 'carried',
    });
    expect(carried.workflow).toBe('standard');
    expect(carried.origin).toBe('carried');
    expect(carried.requested).toBe('standard');
    expect(carried.detected).toBe('standard');
    expect(carried.rationale).not.toMatch(/operator/i);
  });

  it('keeps a carried high-risk class high-risk even when negation now detects nothing', () => {
    const res = classifyWorkflow('não trafega token nem dado de sessão', {
      explicitOverride: 'high-risk',
      overrideOrigin: 'carried',
    });
    expect(res.workflow).toBe('high-risk');
    expect(res.detected).toBe('standard');
    expect(res.origin).toBe('carried');
    expect(res.rationale).not.toMatch(/operator/i);
  });

  it('holds the no-downgrade invariant for a carried class', () => {
    const res = classifyWorkflow('Add auth token verification to payment gateway', {
      explicitOverride: 'standard',
      overrideOrigin: 'carried',
    });
    expect(res.workflow).toBe('high-risk');
    expect(res.detected).toBe('high-risk');
    expect(res.origin).toBe('carried');
    expect(res.rationale).not.toMatch(/operator/i);
    expect(res.rationale).toContain('token "Add auth token verification to payment gateway"');
  });

  it('ignores an origin given without an override', () => {
    const res = classifyWorkflow('Add customer feedback form', { overrideOrigin: 'carried' });
    expect(res.origin).toBe('detected');
    expect(res.requested).toBeUndefined();
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
