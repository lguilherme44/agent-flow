import { CommitOidSchema } from '../../contracts/index.js';
import { refuseDestination, runBranchFor } from '../../core/forge/remote-ref.js';
import type { GitCommand } from './git-command.js';

/**
 * Publishing one exact commit to one exact remote ref (M7 §7, §8, §11, §12).
 *
 * **Not a `ForgeProvider`, and the separation is the milestone's first rule.** Creating a
 * pull request needs the commit to exist remotely; that is a Git operation and it does not
 * become an API operation because an API operation depends on it. A provider that could
 * run Git would be a provider that could rewrite history to make its own call succeed.
 *
 * **Not a `GitClient` either.** `GitClient` answers local questions and touches no network.
 * This is the one place in the product that does, and it does exactly one thing.
 *
 * Everything it publishes is an object id the run already approved. Never a branch name
 * resolved at push time, never `HEAD`, never a ref an agent named.
 */

export type PublishOutcome =
  | { readonly kind: 'published'; readonly branch: string; readonly commit: string }
  /** The remote already has this exact commit on this branch. Publishing again is a no-op. */
  | { readonly kind: 'unchanged'; readonly branch: string; readonly commit: string }
  | { readonly kind: 'refused'; readonly reason: string; readonly detail: string };

export interface PublishRequest {
  readonly runId: string;
  /** The approved commit, forty hex characters. Compared, never derived here. */
  readonly commit: string;
  readonly remote: string;
  readonly cwd: string;
}

export class RemoteGitPublisher {
  constructor(private readonly git: GitCommand) {}

  /**
   * Puts `commit` on this run's branch, or explains why it will not.
   *
   * The order matters: everything checkable without the network is checked first, so a
   * misconfigured destination costs no round trip and leaks nothing to a remote that was
   * never meant to be contacted.
   */
  async publish(request: PublishRequest): Promise<PublishOutcome> {
    const commit = CommitOidSchema.safeParse(request.commit);
    if (!commit.success) {
      return {
        kind: 'refused',
        reason: 'invalid_commit',
        detail:
          'publication takes a full object id, so that what is published is provably the ' +
          'commit the run approved rather than whatever a name resolves to',
      };
    }

    const branch = runBranchFor(request.runId);
    const refused = refuseDestination(branch, request.runId);
    if (refused !== undefined) {
      return { kind: 'refused', reason: 'destination_refused', detail: refused };
    }

    if (!/^[A-Za-z0-9._-]+$/.test(request.remote)) {
      return {
        kind: 'refused',
        reason: 'invalid_remote',
        detail: `"${request.remote}" is not a remote name; a URL here would bypass the operator's Git auth`,
      };
    }

    // **What the remote has now**, before anything is written. A branch that already
    // carries this commit needs no push; one that carries a different commit is a
    // divergence this tool refuses rather than resolves.
    const existing = await this.remoteHead(request, branch);
    if (existing.kind === 'error') return existing.outcome;

    if (existing.oid === commit.data) {
      return { kind: 'unchanged', branch, commit: commit.data };
    }

    if (existing.oid !== undefined) {
      const contains = await this.git.run({
        subcommand: 'merge-base',
        args: ['--is-ancestor', existing.oid, commit.data],
        cwd: request.cwd,
      });

      // **A fast-forward, or nothing.** `--is-ancestor` exits 0 when the remote's commit is
      // reachable from ours, which is exactly the condition a non-force push requires. When
      // it is not, the remote has work this run never saw, and overwriting it is somebody's
      // decision to make deliberately — with their own hands.
      const fastForward = contains.ok && contains.value.exitCode === 0;
      if (!fastForward) {
        return {
          kind: 'refused',
          reason: 'remote_diverged',
          detail:
            `"${branch}" on "${request.remote}" is at ${existing.oid.slice(0, 8)}, which is not ` +
            `an ancestor of ${commit.data.slice(0, 8)}. Something changed the branch outside ` +
            'this run; resolve it by hand rather than forcing over it',
        };
      }
    }

    const pushed = await this.git.run({
      subcommand: 'push',
      // Separated arguments, and a refspec built from two validated halves. A string a
      // caller assembled would be a string a caller could get wrong.
      args: ['--porcelain', request.remote, `${commit.data}:refs/heads/${branch}`],
      cwd: request.cwd,
    });

    if (!pushed.ok) {
      return { kind: 'refused', reason: pushed.failure.code, detail: pushed.failure.message };
    }
    if (pushed.value.exitCode !== 0) {
      return {
        kind: 'refused',
        reason: 'push_rejected',
        detail: firstLine(pushed.value.stderr) || `git push exited ${String(pushed.value.exitCode)}`,
      };
    }

    // **Verified against the remote rather than against the exit code** (§8). A push that
    // reports success and a branch that holds something else is precisely the difference
    // M7 exists to make visible, and it is one more round trip.
    const after = await this.remoteHead(request, branch);
    if (after.kind === 'error') return after.outcome;

    if (after.oid !== commit.data) {
      return {
        kind: 'refused',
        reason: 'publication_unverified',
        detail:
          `"${branch}" reports ${after.oid?.slice(0, 8) ?? 'nothing'} after publishing ` +
          `${commit.data.slice(0, 8)}; the remote does not hold the approved commit`,
      };
    }

    return { kind: 'published', branch, commit: commit.data };
  }

  /** What the remote says this branch points at, or `undefined` when it has no such branch. */
  private async remoteHead(
    request: PublishRequest,
    branch: string,
  ): Promise<
    { kind: 'ok'; oid: string | undefined } | { kind: 'error'; outcome: PublishOutcome }
  > {
    const listed = await this.git.run({
      subcommand: 'ls-remote',
      args: ['--heads', '--', request.remote, `refs/heads/${branch}`],
      cwd: request.cwd,
    });

    if (!listed.ok) {
      return {
        kind: 'error',
        outcome: { kind: 'refused', reason: listed.failure.code, detail: listed.failure.message },
      };
    }
    if (listed.value.exitCode !== 0) {
      return {
        kind: 'error',
        outcome: {
          kind: 'refused',
          reason: 'remote_unreachable',
          detail:
            firstLine(listed.value.stderr) ||
            `git ls-remote exited ${String(listed.value.exitCode)}`,
        },
      };
    }

    const line = listed.value.stdout.split('\n').find((row) => row.trim().length > 0);
    const oid = line?.split(/\s+/)[0];
    return { kind: 'ok', oid: oid !== undefined && /^[0-9a-f]{40}$/.test(oid) ? oid : undefined };
  }
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
}
