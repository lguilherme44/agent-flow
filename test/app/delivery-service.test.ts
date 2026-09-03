import { describe, it, expect } from 'vitest';
import { DeliveryService, type DeliveryRecordStore } from '../../src/app/delivery-service.js';
import { ForgeConfigSchema, type DeliveryRecord } from '../../src/contracts/index.js';
import type { ForgeProvider } from '../../src/ports/index.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { StateStore } from '../../src/app/state-store.js';

/**
 * M7-ACC-11 … M7-ACC-20 and M7-ACC-26: every remote mutation survives a crash without
 * creating a second object.
 *
 * The crash is simulated the way it actually happens: the remote call returns, and the
 * local write never happens. What the next attempt does with that is the whole milestone.
 */

const REPO = { host: 'github.com', owner: 'lguilherme44', repo: 'agent-flow' };
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const RUN = 'AF-2026-001';

/** A remote that remembers what it was told, so a retry meets the object it created. */
function fakeRemote() {
  const issues: { number: number; body: string }[] = [];
  const pulls: { number: number; head: string; base: string; headSha: string; body: string }[] = [];
  const comments: { id: number; on: number; body: string }[] = [];
  const calls: string[] = [];

  const provider: ForgeProvider = {
    id: 'github',
    repository: async () => {
      calls.push('repository');
      return { ok: true, value: { repository: REPO, defaultBranch: 'master' } };
    },
    findIssueByFingerprint: async (marker) => {
      calls.push('findIssue');
      const match = issues.filter((issue) => issue.body.includes(marker));
      if (match.length > 1) {
        return { ok: false, failure: { code: 'forge_ambiguous_recovery', detail: 'two' } };
      }
      const found = match[0];
      return {
        ok: true,
        value:
          found === undefined
            ? undefined
            : { number: found.number, url: `https://x.test/${String(found.number)}`, state: 'open' },
      };
    },
    getIssue: async (number) => ({
      ok: true,
      value: { number, url: `https://x.test/${String(number)}`, state: 'open' },
    }),
    createIssue: async (draft) => {
      calls.push('createIssue');
      const number = issues.length + 1;
      issues.push({ number, body: draft.body });
      return { ok: true, value: { number, url: `https://x.test/${String(number)}`, state: 'open' } };
    },
    findPullRequest: async ({ head, base }) => {
      calls.push('findPR');
      const found = pulls.find((pr) => pr.head === head && pr.base === base);
      return {
        ok: true,
        value:
          found === undefined
            ? undefined
            : {
                number: found.number,
                url: `https://x.test/pr/${String(found.number)}`,
                state: 'open',
                headSha: found.headSha,
                baseBranch: found.base,
              },
      };
    },
    createPullRequest: async (draft) => {
      calls.push('createPR');
      const number = pulls.length + 100;
      pulls.push({ number, head: draft.head, base: draft.base, headSha: SHA, body: draft.body });
      return {
        ok: true,
        value: { number, url: `https://x.test/pr/${String(number)}`, state: 'open', headSha: SHA },
      };
    },
    updatePullRequest: async ({ number }) => {
      calls.push('updatePR');
      const found = pulls.find((pr) => pr.number === number);
      return {
        ok: true,
        value: {
          number,
          url: `https://x.test/pr/${String(number)}`,
          state: 'open',
          ...(found === undefined ? {} : { headSha: found.headSha }),
        },
      };
    },
    listChecks: async () => {
      calls.push('listChecks');
      return { ok: true, value: [{ id: '1', name: 'test', status: 'completed', conclusion: 'success' }] };
    },
    findComment: async ({ issueOrPr, marker }) => {
      calls.push('findComment');
      const found = comments.find((c) => c.on === issueOrPr && c.body.includes(marker));
      return { ok: true, value: found?.id };
    },
    postComment: async ({ issueOrPr, body }) => {
      calls.push('postComment');
      const id = comments.length + 1;
      comments.push({ id, on: issueOrPr, body });
      return { ok: true, value: id };
    },
  };

  return { provider, issues, pulls, comments, calls };
}

/** A record store that can be told to forget, which is what a crash looks like from here. */
function recordStore() {
  let saved: DeliveryRecord | undefined;
  const store: DeliveryRecordStore = {
    read: async () => saved,
    write: async (record) => {
      saved = record;
    },
  };
  return {
    store,
    forget: () => {
      saved = undefined;
    },
    get current() {
      return saved;
    },
  };
}

const ALL_ON = ForgeConfigSchema.parse({
  provider: 'github',
  publish: { enabled: true },
  issues: { create: true, comment: true },
  pullRequests: { create: true, update: true, postSummary: true },
  checks: { read: true },
});

async function world(config = ALL_ON, publishOutcome?: 'refused' | 'diverged') {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('a feature');
  const remote = fakeRemote();
  const records = recordStore();

  const service = new DeliveryService({
    store,
    config,
    repository: REPO,
    provider: remote.provider,
    publisher: {
      publish: async ({ commit }) =>
        publishOutcome === 'refused'
          ? { kind: 'refused', reason: 'push_rejected', detail: 'protected branch' }
          : publishOutcome === 'diverged'
            ? { kind: 'refused', reason: 'remote_diverged', detail: 'the branch moved' }
            : { kind: 'published', branch: `agent-flow/${run.runId}`, commit },
    },
    records: records.store,
    clock,
    projectDir: '/repo',
    remote: 'origin',
  });

  return { service, store, remote, records, runId: run.runId };
}

const events = async (store: StateStore, runId: string, type: string) =>
  (await store.readEvents(runId)).filter((event) => event.type === type);

describe('M7-ACC-12 — a created object carries this run’s fingerprint', () => {
  it('puts a marker in the issue body', async () => {
    const w = await world();

    await w.service.issue(w.runId, { title: 't', body: 'b' });

    expect(w.remote.issues[0]?.body).toContain(`agent-flow:run=${w.runId};kind=issue`);
  });

  it('puts a different marker in the pull request body', async () => {
    const w = await world();

    await w.service.pullRequest(w.runId, SHA, { title: 't', body: 'b', base: 'master' });

    expect(w.remote.pulls[0]?.body).toContain('kind=pull_request');
  });
});

describe('M7-ACC-13 — an issue is never created twice', () => {
  it('adopts from local evidence on an ordinary retry', async () => {
    const w = await world();

    const first = await w.service.issue(w.runId, { title: 't', body: 'b' });
    const second = await w.service.issue(w.runId, { title: 't', body: 'b' });

    expect(first).toMatchObject({ ok: true, value: 1 });
    expect(second).toMatchObject({ ok: true, value: 1, adopted: true });
    expect(w.remote.issues).toHaveLength(1);
  });

  /**
   * The crash this exists for: the remote created the Issue and the process died before
   * writing that down. Local evidence is gone; the remote's copy of our mark is not.
   */
  it('adopts from the remote when the local record was lost', async () => {
    const w = await world();

    await w.service.issue(w.runId, { title: 't', body: 'b' });
    w.records.forget();
    const afterCrash = await w.service.issue(w.runId, { title: 't', body: 'b' });

    expect(afterCrash).toMatchObject({ ok: true, value: 1, adopted: true });
    expect(w.remote.issues).toHaveLength(1);
  });

  it('records the intent before the call, so a crash is visible in the log', async () => {
    const w = await world();

    await w.service.issue(w.runId, { title: 't', body: 'b' });

    expect(await events(w.store, w.runId, 'forge_issue_create_requested')).toHaveLength(1);
    expect(await events(w.store, w.runId, 'forge_issue_created')).toHaveLength(1);
  });

  it('refuses rather than picking when two objects carry the mark', async () => {
    const w = await world();

    await w.service.issue(w.runId, { title: 't', body: 'b' });
    // A second object with the same mark: the state nothing should resolve by choosing.
    w.remote.issues.push({ number: 99, body: w.remote.issues[0]?.body ?? '' });
    w.records.forget();

    const result = await w.service.issue(w.runId, { title: 't', body: 'b' });

    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.failure.code).toBe('forge_ambiguous_recovery');
    expect(w.remote.issues).toHaveLength(2);
  });
});

describe('M7-ACC-16 and M7-ACC-20 — a pull request is reused, never duplicated', () => {
  it('reuses the open pull request for this head and base', async () => {
    const w = await world();

    await w.service.pullRequest(w.runId, SHA, { title: 't', body: 'b', base: 'master' });
    w.records.forget();
    const second = await w.service.pullRequest(w.runId, SHA, { title: 't', body: 'b2', base: 'master' });

    expect(second).toMatchObject({ ok: true, adopted: true });
    expect(w.remote.pulls).toHaveLength(1);
    expect(w.remote.calls.filter((call) => call === 'createPR')).toHaveLength(1);
  });

  it('updates it rather than opening another when the body changed', async () => {
    const w = await world();

    await w.service.pullRequest(w.runId, SHA, { title: 't', body: 'b', base: 'master' });
    await w.service.pullRequest(w.runId, SHA, { title: 't2', body: 'b2', base: 'master' });

    expect(w.remote.calls.filter((call) => call === 'updatePR')).toHaveLength(1);
  });
});

describe('M7-ACC-15 and M7-ACC-17 — a pull request points at the approved commit or nothing happens', () => {
  it('refuses when the open pull request points somewhere else', async () => {
    const w = await world();

    await w.service.pullRequest(w.runId, SHA, { title: 't', body: 'b', base: 'master' });
    // The branch moved outside this run.
    const pr = w.remote.pulls[0];
    if (pr !== undefined) pr.headSha = OTHER;

    const result = await w.service.pullRequest(w.runId, SHA, { title: 't', body: 'b', base: 'master' });

    expect(!result.ok && result.failure.code).toBe('forge_remote_ref_conflict');
    expect(w.remote.calls.filter((call) => call === 'updatePR')).toHaveLength(0);
  });
});

describe('M7-ACC-26 — a summary comment is posted once per logical update', () => {
  it('adopts its own comment on a retry', async () => {
    const w = await world();

    const first = await w.service.comment(w.runId, { on: 1, body: 'summary', topic: 'quality' });
    const second = await w.service.comment(w.runId, { on: 1, body: 'summary', topic: 'quality' });

    expect(first).toMatchObject({ ok: true, value: 1 });
    expect(second).toMatchObject({ ok: true, value: 1, adopted: true });
    expect(w.remote.comments).toHaveLength(1);
  });

  it('posts a second comment for a genuinely different update', async () => {
    const w = await world();

    await w.service.comment(w.runId, { on: 1, body: 'a', topic: 'quality' });
    await w.service.comment(w.runId, { on: 1, body: 'b', topic: 'checks' });

    expect(w.remote.comments).toHaveLength(2);
  });
});

describe('M7-ACC-02 — a write that is configured off sends nothing, and says so', () => {
  it.each([
    ['publish', (s: DeliveryService, r: string) => s.publish(r, SHA)],
    ['issue', (s: DeliveryService, r: string) => s.issue(r, { title: 't', body: 'b' })],
    [
      'pull request',
      (s: DeliveryService, r: string) => s.pullRequest(r, SHA, { title: 't', body: 'b', base: 'master' }),
    ],
    ['sync', (s: DeliveryService, r: string) => s.sync(r)],
  ])('refuses %s when the provider is none', async (_name, call) => {
    const w = await world(ForgeConfigSchema.parse({}));

    const result = await call(w.service, w.runId);

    expect(!result.ok && result.failure.code).toBe('forge_not_configured');
    expect(w.remote.calls).toEqual([]);
  });

  it('refuses one write while another is on, and names the flag', async () => {
    const w = await world(
      ForgeConfigSchema.parse({ provider: 'github', publish: { enabled: true } }),
    );

    const result = await w.service.issue(w.runId, { title: 't', body: 'b' });

    expect(!result.ok && result.failure.detail).toContain('forge.issues.create is off');
  });
});

describe('M7-ACC-05 — a repository mismatch refuses every mutation', () => {
  it('refuses before reaching the remote', async () => {
    const w = await world(
      ForgeConfigSchema.parse({
        provider: 'github',
        issues: { create: true },
        repository: { host: 'github.com', owner: 'someone-else', repo: 'agent-flow' },
      }),
    );

    const result = await w.service.issue(w.runId, { title: 't', body: 'b' });

    expect(!result.ok && result.failure.code).toBe('forge_repository_mismatch');
    expect(w.remote.calls).toEqual([]);
  });
});

describe('M7-ACC-24 — a delivery failure is recorded, and the run is not touched', () => {
  it('records the failure on the delivery record', async () => {
    const w = await world(ALL_ON, 'refused');

    const result = await w.service.publish(w.runId, SHA);

    expect(result.ok).toBe(false);
    expect(w.records.current?.failure?.detail).toContain('protected branch');
    expect(await events(w.store, w.runId, 'forge_operation_failed')).toHaveLength(1);
  });

  it('leaves the run’s own status alone', async () => {
    const w = await world(ALL_ON, 'refused');
    const before = (await w.store.loadRun(w.runId)).status;

    await w.service.publish(w.runId, SHA);

    expect((await w.store.loadRun(w.runId)).status).toBe(before);
  });

  it('reads a diverged remote as its own failure code', async () => {
    const w = await world(ALL_ON, 'diverged');

    const result = await w.service.publish(w.runId, SHA);

    expect(!result.ok && result.failure.code).toBe('forge_remote_ref_conflict');
  });
});

describe('checks are observed, and observation is all they are', () => {
  it('reads them for the published commit', async () => {
    const w = await world();

    await w.service.publish(w.runId, SHA);
    const result = await w.service.sync(w.runId);

    expect(result).toMatchObject({ ok: true, value: 1 });
    expect(w.records.current?.checks).toHaveLength(1);
    expect(w.records.current?.syncedAt).toBeDefined();
  });

  it('refuses to sync a run that published nothing', async () => {
    const w = await world();

    expect(await w.service.sync(w.runId)).toMatchObject({ ok: false });
  });
});
