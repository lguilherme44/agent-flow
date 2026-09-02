import { describe, it, expect } from 'vitest';
import { GitHubForgeProvider } from '../../src/adapters/forge/github-forge.js';

/**
 * The HTTP boundary (M7 §28, §29, §30, §56).
 *
 * No network: the adapter takes its `fetch`, which is the seam the utility model already
 * established. What is being tested is the *normalisation* — that a status code becomes a
 * domain failure rather than a number, that an unknown enum becomes `unknown` rather than
 * a guess, and that nothing unbounded gets through.
 */

const REPO = { host: 'github.com', owner: 'lguilherme44', repo: 'agent-flow' };
const SHA = 'a'.repeat(40);

function provider(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];

  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;

  return {
    calls,
    forge: new GitHubForgeProvider({
      repository: REPO,
      token: 'ghp_secret_value',
      apiBaseUrl: 'https://api.github.com',
      fetch: fetchStub,
      requestTimeoutMs: 5_000,
      maxResponseBytes: 100_000,
      maxRecoveryScan: 300,
    }),
  };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

describe('the repository', () => {
  it('reads the default branch from the remote rather than assuming one', async () => {
    const { forge } = provider(() => json({ default_branch: 'trunk' }));

    const result = await forge.repository();

    expect(result.ok && result.value.defaultBranch).toBe('trunk');
  });

  it('fails closed when the response has no default branch', async () => {
    const { forge } = provider(() => json({}));

    const result = await forge.repository();

    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.code).toBe('forge_invalid_response');
  });
});

describe('M7-ACC-28 — a malformed response fails closed', () => {
  it('refuses a body that is not JSON', async () => {
    const { forge } = provider(() => new Response('<html>502</html>', { status: 200 }));

    const result = await forge.repository();

    expect(!result.ok && result.failure.code).toBe('forge_invalid_response');
  });

  it('refuses an issue with no number', async () => {
    const { forge } = provider(() => json({ html_url: 'https://github.com/o/r/issues/1' }));

    const result = await forge.getIssue(1);

    expect(!result.ok && result.failure.code).toBe('forge_invalid_response');
  });

  it('refuses a body larger than the ceiling', async () => {
    const { forge } = provider(() => json({ default_branch: 'x'.repeat(200_000) }));

    const result = await forge.repository();

    expect(!result.ok && result.failure.code).toBe('forge_invalid_response');
  });
});

describe('a status code becomes a domain failure, never a number', () => {
  it.each([
    [401, 'forge_auth_required'],
    [403, 'forge_permission_denied'],
    [404, 'forge_permission_denied'],
    [409, 'forge_conflict'],
    [422, 'forge_conflict'],
    [500, 'forge_unavailable'],
    [503, 'forge_unavailable'],
  ])('reads %i as %s', async (status, code) => {
    const { forge } = provider(() => new Response('{}', { status }));

    const result = await forge.repository();

    expect(!result.ok && result.failure.code).toBe(code);
  });

  /**
   * A private repository a token cannot see answers 404, so "not found" and "not
   * permitted" are the same response — and reading it as "does not exist" would send an
   * operator to create a repository that is already there.
   */
  it('does not read 404 as "the repository does not exist"', async () => {
    const { forge } = provider(() => new Response('{}', { status: 404 }));

    const result = await forge.repository();

    expect(!result.ok && result.failure.detail).toContain('not visible to this token');
  });
});

describe('M7-ACC-27 — rate limiting is a bounded failure, not a loop', () => {
  it('reads 429 as rate limited, with how long to wait', async () => {
    const { forge } = provider(
      () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }),
    );

    const result = await forge.repository();

    expect(!result.ok && result.failure.code).toBe('forge_rate_limited');
    expect(!result.ok && result.failure.retryAfterMs).toBe(30_000);
  });

  /** GitHub reports a secondary rate limit as 403, which is also "you may not do this". */
  it('separates a rate-limited 403 from a permission-denied one by the remaining header', async () => {
    const limited = provider(
      () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    );
    const denied = provider(
      () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '4999' } }),
    );

    const a = await limited.forge.repository();
    const b = await denied.forge.repository();

    expect(!a.ok && a.failure.code).toBe('forge_rate_limited');
    expect(!b.ok && b.failure.code).toBe('forge_permission_denied');
  });

  it('makes exactly one request per call, so a failure cannot spin', async () => {
    const { forge, calls } = provider(() => new Response('{}', { status: 429 }));

    await forge.repository();

    expect(calls).toHaveLength(1);
  });
});

describe('M7-ACC-21 — checks normalise, and an unknown value is never a pass', () => {
  it('reads a completed successful run', async () => {
    const { forge } = provider(() =>
      json({
        check_runs: [
          { id: 1, name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://x.test/1' },
        ],
      }),
    );

    const result = await forge.listChecks(SHA);

    expect(result.ok && result.value).toEqual([
      { id: '1', name: 'test', status: 'completed', conclusion: 'success', url: 'https://x.test/1' },
    ]);
  });

  it('reads a status GitHub might add tomorrow as unknown, not as completed', async () => {
    const { forge } = provider(() =>
      json({ check_runs: [{ id: 2, name: 'x', status: 'waiting_for_a_thing' }] }),
    );

    const result = await forge.listChecks(SHA);

    expect(result.ok && result.value[0]?.status).toBe('unknown');
  });

  it('reads an unrecognised conclusion as unknown, not as success', async () => {
    const { forge } = provider(() =>
      json({ check_runs: [{ id: 3, name: 'x', status: 'completed', conclusion: 'flaky' }] }),
    );

    const result = await forge.listChecks(SHA);

    expect(result.ok && result.value[0]?.conclusion).toBe('unknown');
  });

  it('asks by commit, because a pull request whose head moved has different checks', async () => {
    const { forge, calls } = provider(() => json({ check_runs: [] }));

    await forge.listChecks(SHA);

    expect(calls[0]?.url).toContain(`/commits/${SHA}/check-runs`);
  });
});

describe('M7-ACC-13 — recovery adopts one object and refuses two', () => {
  const marker = '<!-- agent-flow:run=AF-2026-001;kind=issue;fingerprint=abc -->';

  it('adopts the single issue carrying this run’s mark', async () => {
    const { forge } = provider(() =>
      json([
        { number: 7, html_url: 'https://github.com/o/r/issues/7', state: 'open', body: `x ${marker}` },
        { number: 8, html_url: 'https://github.com/o/r/issues/8', state: 'open', body: 'unrelated' },
      ]),
    );

    const result = await forge.findIssueByFingerprint(marker);

    expect(result.ok && result.value?.number).toBe(7);
  });

  it('answers nothing when no object carries it', async () => {
    const { forge } = provider(() => json([{ number: 8, html_url: 'https://x.test/8', body: 'no' }]));

    const result = await forge.findIssueByFingerprint(marker);

    expect(result.ok && result.value).toBeUndefined();
  });

  it('refuses when two carry it, rather than picking one', async () => {
    const { forge } = provider(() =>
      json([
        { number: 7, html_url: 'https://x.test/7', body: marker },
        { number: 9, html_url: 'https://x.test/9', body: marker },
      ]),
    );

    const result = await forge.findIssueByFingerprint(marker);

    expect(!result.ok && result.failure.code).toBe('forge_ambiguous_recovery');
  });

  /**
   * Listed rather than searched. GitHub's search index is eventually consistent, so an
   * Issue created seconds before a crash may not appear in a search — and "not found" then
   * means "create another one", which is the duplicate the fingerprint exists to prevent.
   */
  it('lists the repository rather than searching it', async () => {
    const { forge, calls } = provider(() => json([]));

    await forge.findIssueByFingerprint(marker);

    expect(calls[0]?.url).toContain('/issues?');
    expect(calls[0]?.url).not.toContain('/search');
  });
});

describe('pagination is bounded, and a bound reached is ambiguous rather than empty', () => {
  it('walks pages while they are full', async () => {
    const page = (n: number) =>
      Array.from({ length: 100 }, (_, i) => ({ number: n * 100 + i, html_url: 'https://x.test/1', body: '' }));
    let seen = 0;

    const { forge } = provider((url) => {
      seen += 1;
      // `&page=1`, with the ampersand: `per_page=100` contains the substring `page=1`,
      // so a looser match made every page look full and the scan ran to its bound.
      return json(url.includes('&page=1') ? page(1) : []);
    });

    await forge.findIssueByFingerprint('nothing');

    expect(seen).toBe(2);
  });

  it('refuses rather than concluding "no match" from a partial scan', async () => {
    // Every page full, forever: the scan reaches its bound without ever seeing an end.
    const full = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      html_url: 'https://x.test/1',
      body: '',
    }));
    const { forge } = provider(() => json(full));

    const result = await forge.findIssueByFingerprint('nothing');

    expect(!result.ok && result.failure.code).toBe('forge_ambiguous_recovery');
  });
});

describe('M7-ACC-06 and §29 — the token goes to one host and never comes back out', () => {
  it('sends it only in the Authorization header of the pinned host', async () => {
    const { forge, calls } = provider(() => json({ default_branch: 'main' }));

    await forge.repository();

    expect(calls[0]?.url.startsWith('https://api.github.com/')).toBe(true);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer ghp_secret_value');
  });

  it('refuses to follow a redirect, which would re-send the header to another host', async () => {
    const { calls } = provider(() => json({}));
    void calls;
    const { forge, calls: seen } = provider(() => json({ default_branch: 'main' }));

    await forge.repository();

    expect(seen[0]?.init.redirect).toBe('error');
  });

  it('keeps the token out of a failure detail', async () => {
    const { forge } = provider(() => {
      throw new Error('connect ECONNREFUSED https://x:ghp_secret_value@api.github.com');
    });

    const result = await forge.repository();

    expect(!result.ok && result.failure.detail).not.toContain('ghp_secret_value');
  });
});

describe('what it sends', () => {
  it('qualifies a pull-request head with the owner, so a fork’s branch cannot match', async () => {
    const { forge, calls } = provider(() => json([]));

    await forge.findPullRequest({ head: 'agent-flow/AF-2026-001', base: 'main' });

    expect(calls[0]?.url).toContain(`head=${encodeURIComponent('lguilherme44:agent-flow/AF-2026-001')}`);
  });

  it('posts an issue with its labels and nothing else', async () => {
    const { forge, calls } = provider(() => json({ number: 1, html_url: 'https://x.test/1', state: 'open' }));

    await forge.createIssue({ title: 't', body: 'b', labels: ['dogfood'] });

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      title: 't',
      body: 'b',
      labels: ['dogfood'],
    });
  });

  it('omits labels entirely when the allowlist is empty', async () => {
    const { forge, calls } = provider(() => json({ number: 1, html_url: 'https://x.test/1', state: 'open' }));

    await forge.createIssue({ title: 't', body: 'b', labels: [] });

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ title: 't', body: 'b' });
  });
});
