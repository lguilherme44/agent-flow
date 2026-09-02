import { describe, it, expect } from 'vitest';
import { RemoteGitPublisher } from '../../src/adapters/git/remote-publisher.js';
import type { GitCommand } from '../../src/adapters/git/git-command.js';

/**
 * M7-ACC-07, M7-ACC-09 and M7-ACC-10: publication is exact, verified, and never forced.
 *
 * A fake `GitCommand` rather than a real repository, because what is being tested is the
 * *decision* — which argv is built, what is checked before it, and what is checked after.
 * That the argv then does what Git says it does is Git's contract, and the allowlist's.
 */

const OID = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const RUN = 'AF-2026-001';

type Call = { subcommand: string; args: readonly string[] };

function fakeGit(
  answers: (call: Call) => { exitCode: number; stdout?: string; stderr?: string },
): { git: GitCommand; calls: Call[] } {
  const calls: Call[] = [];
  const git = {
    run: async (invocation: { subcommand: string; args?: readonly string[] }) => {
      const call = { subcommand: invocation.subcommand, args: invocation.args ?? [] };
      calls.push(call);
      const answer = answers(call);
      return {
        ok: true as const,
        value: {
          exitCode: answer.exitCode,
          stdout: answer.stdout ?? '',
          stderr: answer.stderr ?? '',
          truncated: false,
          durationMs: 1,
        },
      };
    },
  } as unknown as GitCommand;

  return { git, calls };
}

const request = { runId: RUN, commit: OID, remote: 'origin', cwd: '/repo' };

/** A remote with no such branch, then holding the pushed commit. */
function freshRemote() {
  let pushed = false;
  return fakeGit((call) => {
    if (call.subcommand === 'ls-remote') {
      return { exitCode: 0, stdout: pushed ? `${OID}\trefs/heads/agent-flow/${RUN}\n` : '' };
    }
    if (call.subcommand === 'push') {
      pushed = true;
      return { exitCode: 0 };
    }
    return { exitCode: 0 };
  });
}

describe('M7-ACC-07 — what is published is an exact object id', () => {
  it('pushes the commit, not a name', async () => {
    const { git, calls } = freshRemote();

    const outcome = await new RemoteGitPublisher(git).publish(request);

    expect(outcome).toEqual({ kind: 'published', branch: `agent-flow/${RUN}`, commit: OID });
    const push = calls.find((call) => call.subcommand === 'push');
    expect(push?.args).toEqual([
      '--porcelain',
      'origin',
      `${OID}:refs/heads/agent-flow/${RUN}`,
    ]);
  });

  it('refuses a branch name where a commit belongs', async () => {
    const { git, calls } = freshRemote();

    const outcome = await new RemoteGitPublisher(git).publish({ ...request, commit: 'HEAD' });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'invalid_commit' });
    expect(calls).toEqual([]);
  });

  it('refuses an abbreviated id, which could name two commits next year', async () => {
    const { git } = freshRemote();

    expect(await new RemoteGitPublisher(git).publish({ ...request, commit: OID.slice(0, 8) }))
      .toMatchObject({ kind: 'refused', reason: 'invalid_commit' });
  });
});

describe('M7-ACC-09 — the destination is this run’s branch and nothing else', () => {
  it('never asks the caller which branch', async () => {
    const { git, calls } = freshRemote();

    await new RemoteGitPublisher(git).publish(request);

    expect(calls.every((call) => call.args.every((arg) => !arg.includes('main')))).toBe(true);
  });

  it('refuses a URL in place of a remote name, which would bypass the operator’s Git auth', async () => {
    const { git, calls } = freshRemote();

    const outcome = await new RemoteGitPublisher(git).publish({
      ...request,
      remote: 'https://x:token@github.com/o/r.git',
    });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'invalid_remote' });
    expect(calls).toEqual([]);
  });
});

describe('M7-ACC-10 — a diverged remote refuses, and nothing is forced', () => {
  it('refuses when the remote holds a commit that is not an ancestor', async () => {
    const { git, calls } = fakeGit((call) => {
      if (call.subcommand === 'ls-remote') {
        return { exitCode: 0, stdout: `${OTHER}\trefs/heads/agent-flow/${RUN}\n` };
      }
      // `merge-base --is-ancestor` says no.
      if (call.subcommand === 'merge-base') return { exitCode: 1 };
      return { exitCode: 0 };
    });

    const outcome = await new RemoteGitPublisher(git).publish(request);

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'remote_diverged' });
    expect(calls.some((call) => call.subcommand === 'push')).toBe(false);
  });

  it('publishes when the remote is an ancestor, which is a fast-forward', async () => {
    let pushed = false;
    const { git } = fakeGit((call) => {
      if (call.subcommand === 'ls-remote') {
        return {
          exitCode: 0,
          stdout: `${pushed ? OID : OTHER}\trefs/heads/agent-flow/${RUN}\n`,
        };
      }
      if (call.subcommand === 'merge-base') return { exitCode: 0 };
      if (call.subcommand === 'push') {
        pushed = true;
        return { exitCode: 0 };
      }
      return { exitCode: 0 };
    });

    expect(await new RemoteGitPublisher(git).publish(request)).toMatchObject({
      kind: 'published',
    });
  });

  it('does nothing at all when the remote already holds this commit', async () => {
    const { git, calls } = fakeGit((call) =>
      call.subcommand === 'ls-remote'
        ? { exitCode: 0, stdout: `${OID}\trefs/heads/agent-flow/${RUN}\n` }
        : { exitCode: 0 },
    );

    expect(await new RemoteGitPublisher(git).publish(request)).toMatchObject({
      kind: 'unchanged',
    });
    expect(calls.some((call) => call.subcommand === 'push')).toBe(false);
  });
});

describe('the push is verified against the remote, not against its exit code', () => {
  it('refuses when the branch does not hold the approved commit afterwards', async () => {
    // The failure this catches: a push that reports success while the branch ends up
    // somewhere else — a hook that rewrote it, a race, a proxy. `exitCode 0` is a claim.
    const { git } = fakeGit((call) => {
      if (call.subcommand === 'ls-remote') {
        return { exitCode: 0, stdout: `${OTHER}\trefs/heads/agent-flow/${RUN}\n` };
      }
      if (call.subcommand === 'merge-base') return { exitCode: 0 };
      return { exitCode: 0 };
    });

    expect(await new RemoteGitPublisher(git).publish(request)).toMatchObject({
      kind: 'refused',
      reason: 'publication_unverified',
    });
  });

  it('reports what the remote said when the push is rejected', async () => {
    const { git } = fakeGit((call) =>
      call.subcommand === 'push'
        ? { exitCode: 1, stderr: '! [remote rejected] protected branch hook declined\n' }
        : { exitCode: 0 },
    );

    expect(await new RemoteGitPublisher(git).publish(request)).toMatchObject({
      kind: 'refused',
      reason: 'push_rejected',
      detail: expect.stringContaining('protected branch'),
    });
  });
});
