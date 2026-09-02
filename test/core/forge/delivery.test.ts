import { describe, it, expect } from 'vitest';
import { projectDelivery } from '../../../src/core/forge/delivery.js';
import { ForgeConfigSchema, type DeliveryRecord } from '../../../src/contracts/index.js';

/**
 * M7-ACC-22, M7-ACC-24 and M7-ACC-25: one projection, and it decides nothing local.
 *
 * Every state below is a fold over facts. A stored `deliveryStatus` beside them would be
 * the field that disagrees the first time a sync is interrupted, which is the same reason
 * a finding's status is derived.
 */

const GITHUB = ForgeConfigSchema.parse({ provider: 'github' });
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const record = (overrides: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  runId: 'AF-2026-001',
  provider: 'github',
  repository: { host: 'github.com', owner: 'lguilherme44', repo: 'agent-flow' },
  sourceCommit: SHA,
  checks: [],
  ...overrides,
});

const check = (conclusion: string | undefined, status = 'completed') =>
  ({
    id: `${String(conclusion)}-${status}`,
    name: 'test',
    status,
    ...(conclusion === undefined ? {} : { conclusion }),
  }) as DeliveryRecord['checks'][number];

describe('the states delivery can be in', () => {
  it('is disabled when no provider is configured', () => {
    const view = projectDelivery({ config: ForgeConfigSchema.parse({}) });

    expect(view.state).toBe('disabled');
    expect(view.detail).toContain('no forge is configured');
  });

  it('is not_published when a provider exists and nothing was pushed', () => {
    expect(projectDelivery({ config: GITHUB }).state).toBe('not_published');
    expect(projectDelivery({ config: GITHUB, record: record() }).state).toBe('not_published');
  });

  it('is published once a branch carries the approved commit', () => {
    const view = projectDelivery({
      config: GITHUB,
      record: record({ remoteBranch: 'agent-flow/AF-2026-001' }),
    });

    expect(view.state).toBe('published');
    expect(view.publishedCommit).toBe(SHA);
  });

  it('is pr_open when a pull request exists and no check was observed', () => {
    const view = projectDelivery({
      config: GITHUB,
      record: record({
        remoteBranch: 'agent-flow/AF-2026-001',
        pullRequest: { number: 42, url: 'https://x.test/42', state: 'open', headSha: SHA },
      }),
    });

    expect(view.state).toBe('pr_open');
  });
});

describe('M7-ACC-22 — checks are observation, and never a local verdict', () => {
  const withChecks = (checks: DeliveryRecord['checks']) =>
    projectDelivery({
      config: GITHUB,
      record: record({
        remoteBranch: 'agent-flow/AF-2026-001',
        pullRequest: { number: 42, url: 'https://x.test/42', state: 'open', headSha: SHA },
        checks,
      }),
    });

  it('is green when every check completed successfully', () => {
    expect(withChecks([check('success'), check('skipped'), check('neutral')]).state).toBe(
      'checks_green',
    );
  });

  it('is red when one failed', () => {
    expect(withChecks([check('success'), check('failure')]).state).toBe('checks_red');
  });

  it('says plainly that a red check is not a local failure', () => {
    expect(withChecks([check('failure')]).detail).toContain('This is delivery, not quality');
  });

  it('is pending while one has not finished', () => {
    expect(withChecks([check('success'), check(undefined, 'in_progress')]).state).toBe(
      'checks_pending',
    );
  });

  /**
   * The rounding that must not happen. A conclusion this product does not recognise is a
   * conclusion it has not read, and calling it green puts a badge over something nobody
   * looked at.
   */
  it('counts an unknown conclusion as pending, never as green', () => {
    expect(withChecks([check('unknown')]).state).toBe('checks_pending');
    expect(withChecks([check('success'), check('unknown')]).checkSummary).toMatchObject({
      green: 1,
      pending: 1,
    });
  });
});

describe('a pull request pointing somewhere else is diverged, whatever its checks say', () => {
  it('refuses to read green checks as delivery of the approved commit', () => {
    const view = projectDelivery({
      config: GITHUB,
      record: record({
        remoteBranch: 'agent-flow/AF-2026-001',
        pullRequest: { number: 42, url: 'https://x.test/42', state: 'open', headSha: OTHER },
        checks: [check('success')],
      }),
    });

    expect(view.state).toBe('remote_diverged');
    expect(view.detail).toContain('this run approved');
  });
});

describe('M7-ACC-24 — a remote failure is reported as its own thing', () => {
  it('reports the failure rather than the publication state behind it', () => {
    const view = projectDelivery({
      config: GITHUB,
      record: record({
        remoteBranch: 'agent-flow/AF-2026-001',
        failure: { code: 'forge_rate_limited', detail: 'the remote is rate limiting this token' },
      }),
    });

    expect(view.state).toBe('delivery_failed');
    expect(view.detail).toContain('rate limiting');
    // And the publication is still visible, because both facts are true.
    expect(view.branch).toBe('agent-flow/AF-2026-001');
  });

  it('separates a diverged ref from an ordinary failure', () => {
    const view = projectDelivery({
      config: GITHUB,
      record: record({
        failure: { code: 'forge_remote_ref_conflict', detail: 'the branch moved' },
      }),
    });

    expect(view.state).toBe('remote_diverged');
  });
});

describe('every state carries a sentence', () => {
  it('never answers with a bare state name', () => {
    const views = [
      projectDelivery({ config: ForgeConfigSchema.parse({}) }),
      projectDelivery({ config: GITHUB }),
      projectDelivery({ config: GITHUB, record: record({ remoteBranch: 'b' }) }),
    ];

    for (const view of views) expect(view.detail.length).toBeGreaterThan(20);
  });
});
