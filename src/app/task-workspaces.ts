import { CommitOidSchema, type EffectiveConfig, type RunState } from '../contracts/index.js';
import type { ProcessRunner } from '../ports/process-runner.js';
import type { Clock } from '../ports/clock.js';
import { runCommands } from './verification-commands.js';
import { attemptRef, attemptWorkspace } from '../core/worktree-policy.js';
import { deriveRepoKey, type RepositoryDeps } from './run-git-identity.js';

/**
 * An attempt gets a prepared, verified-clean worktree, or it does not run (§8).
 *
 * The sequence is fixed and every step earns its place:
 *
 * ```text
 * git worktree add --lock --reason … -b <attempt ref> <workspace> <base>
 *         ↓
 * assert clean                                    phase: "checkout"
 *         ↓
 * project.commands.install                        only when configured
 *         ↓
 * assert clean                                    phase: "setup"
 *         ↓
 * invoke the agent
 * ```
 *
 * **The agent is not invoked on a failed preparation, and that is the point.** An
 * agent that starts in a dirty workspace produces a validated tree containing
 * changes nobody attributed to the task, and those changes then enter the marker
 * and the integration branch with a receipt saying they were validated. A dirty
 * setup is the shortest route from "a tool rewrote a lockfile" to "a commit
 * nobody can explain".
 *
 * **Nothing here makes a tree clean.** No stash, no reset, no synthetic commit,
 * no `clean -fd`. Either the tree is clean or the attempt is refused (§8.2).
 *
 * `project.commands.install` is reused rather than adding a `git.worktreeSetup`
 * key (§30.1): a second configuration key for "how do I make this project
 * buildable" would be a second answer to a question the project config already
 * answers, and the two would drift.
 */

/**
 * What the executor is handed. Deliberately small.
 *
 * `path` is an absolute directory on this machine and **is never persisted** —
 * not to `state.json`, not to `events.jsonl`, not to any HTTP contract (§7.2,
 * §21.3). The attempt artifact records the workspace-*relative* path instead,
 * which is why `isolation` carries one; the absolute root is a fact the process
 * resolves and forgets.
 */
export interface TaskWorkspace {
  /** Absolute path the agent and the validation commands run in. */
  readonly path: string;
  /** Which attempt this is. Matches the persisted attempt counter. */
  readonly attempt: number;
  /** Present only in worktree mode. */
  readonly isolation?: {
    /** 40-hex commit the workspace was cut from. */
    readonly base: string;
    /** `agent-flow/<gitRunKey>/<taskId>/attempt-<n>`. */
    readonly branch: string;
    /** `<repoKey>/<gitRunKey>/<taskId>/attempt-<n>` — never absolute. */
    readonly relativePath: string;
  };
}

/** §8.3's shape: the phase is a field, never a sentence in a message. */
export interface WorkspacePreparationFailure {
  readonly code: 'task_workspace_preparation_failed';
  /** Which assertion refused. `checkout` never reaches the install. */
  readonly phase: 'checkout' | 'setup';
  /** Repository-relative, bounded. Never an absolute path (§21.3). */
  readonly changes: readonly string[];
  /**
   * What went wrong, for a person — and **path-free by construction**.
   *
   * This string is persisted to `events.jsonl` and reaches an HTTP response, so
   * §7.2 and §21.3 apply to it as much as to `changes`. That rules out the
   * obvious implementation: forwarding Git's stderr or the install command's
   * output, both of which routinely name the absolute worktree they ran in.
   *
   * So every sentence here is assembled from facts that cannot contain a path —
   * the phase, a stable Git error code, an exit status, a count. The output
   * itself is not lost: §8.4's `doctor` probe is the channel built to show what
   * an install changes, and the refused worktree is retained (§7.4) for anyone
   * who wants to look at the real thing.
   */
  readonly detail: string;
  /** When the preparation refused. */
  readonly at: string;
}

export type WorkspaceOutcome =
  | { readonly ok: true; readonly workspace: TaskWorkspace }
  | { readonly ok: false; readonly failure: WorkspacePreparationFailure };

/** At most this many paths reach an event, so the audit trail stays readable. */
const MAX_REPORTED_CHANGES = 10;

export interface TaskWorkspacesDeps extends RepositoryDeps {
  readonly processRunner: ProcessRunner;
  readonly config: EffectiveConfig;
  /** Stamps the refusal, so the caller needs no clock to report one. */
  readonly clock: Clock;
}

export interface PrepareRequest {
  readonly state: RunState;
  readonly taskId: string;
  readonly attempt: number;
  /**
   * The wave base: the commit every task of this wave is cut from (§9.1).
   *
   * Optional because the caller reads it from run state, where it is optional
   * too — and because a worktree-mode run without one is a broken invariant this
   * module should refuse with a sentence, not paper over with an empty argument.
   */
  readonly base: string | undefined;
}

export class TaskWorkspaces {
  constructor(private readonly deps: TaskWorkspacesDeps) {}

  /**
   * The workspace for one attempt.
   *
   * **Sequential and legacy runs get the project directory and no Git call at
   * all.** That is not an optimisation: §25 promises those runs behave exactly as
   * they always have, and a project that is not a repository must keep working.
   */
  async prepare(request: PrepareRequest): Promise<WorkspaceOutcome> {
    if (request.state.isolationMode !== 'worktree') {
      return {
        ok: true,
        workspace: { path: this.deps.projectDir, attempt: request.attempt },
      };
    }

    return this.prepareIsolated(request);
  }

  private async prepareIsolated(request: PrepareRequest): Promise<WorkspaceOutcome> {
    const gitRunKey = request.state.gitRunKey;
    if (gitRunKey === undefined) {
      return this.refuse('checkout', [], 'this run has no Git namespace to name a workspace with');
    }

    // The wave base reaches `git worktree add` as an argv element, so it is
    // re-validated here for the same reason `taskId` and `gitRunKey` are (S-1,
    // S-2): "the caller passed a commit" is not a property this code can see,
    // and a commit-ish that is anything other than 40 hex characters is either a
    // broken invariant upstream or something that should never reach Git.
    const parsedBase = CommitOidSchema.safeParse(request.base);
    if (!parsedBase.success) {
      return this.refuse('checkout', [], 'the wave base is not a Git commit id');
    }
    const base = parsedBase.data;

    // Derived here, the same way §5.1 specifies, rather than persisted anywhere:
    // a `repoKey` on disk would be a second copy of a fact the repository
    // already answers, and the two could disagree after a move.
    const repoKey = await deriveRepoKey(this.deps);
    if (repoKey === null) {
      return this.refuse('checkout', [], 'the repository root could not be resolved');
    }

    // Re-validated before composition even though the policy module validates
    // too — "the caller checked it" is not a property this code can see, and the
    // operation on the other side creates a directory (S-1, S-3).
    const location = attemptWorkspace(repoKey, gitRunKey, request.taskId, request.attempt);
    if (!location.ok) {
      return this.refuse('checkout', [], location.refusal.reason);
    }

    const branch = attemptRef(gitRunKey, request.taskId, request.attempt);
    if (!branch.ok) {
      return this.refuse('checkout', [], branch.refusal.reason);
    }

    // Branch and worktree in one command, at the wave base (§7.3). Two commands
    // would leave a window where the branch exists and nothing is checked out,
    // which after a crash is indistinguishable from a pruned worktree.
    const added = await this.deps.workspaces.addWorktree({
      cwd: this.deps.projectDir,
      location: location.value,
      branch: branch.value,
      base,
      reason: `agent-flow ${gitRunKey} ${request.taskId} attempt-${String(request.attempt)}`,
    });
    if (!added.ok) {
      // The `code` and not the `message`: Git's own text for a failed
      // `worktree add` names the absolute path it tried to create, and this
      // string is persisted.
      return this.refuse(
        'checkout',
        [],
        `the workspace could not be created (${added.failure.code})`,
      );
    }

    const workspace: TaskWorkspace = {
      path: added.value,
      attempt: request.attempt,
      isolation: {
        base,
        branch: branch.value,
        relativePath: location.value.relativePath,
      },
    };

    // §8.1, first assertion. A checkout can be born dirty — `core.autocrlf` and
    // `.gitattributes` filters both do it — and catching that here, separately
    // from the post-setup assertion, is why the two phases exist.
    const checkout = await this.assertClean(workspace.path, 'checkout');
    if (checkout !== null) return { ok: false, failure: checkout };

    const install = this.deps.config.project?.commands?.install;
    if (install === undefined || install.trim().length === 0) {
      return { ok: true, workspace };
    }

    const ran = await this.runInstall(install, workspace.path);
    if (ran !== null) return { ok: false, failure: ran };

    // §8.1, second assertion. Ignored files do not count — `node_modules/` is
    // exactly what setup is supposed to produce (§8.2).
    const setup = await this.assertClean(workspace.path, 'setup');
    if (setup !== null) return { ok: false, failure: setup };

    return { ok: true, workspace };
  }

  /**
   * The cleanliness authority, asked the same way both times (§8.2).
   *
   * **A status that cannot be read fails closed.** "I could not measure it" is
   * not "it is clean": treating an unreadable repository as clean would invoke an
   * agent in a workspace nobody verified, which is precisely what this gate
   * exists to prevent.
   */
  private async assertClean(
    path: string,
    phase: 'checkout' | 'setup',
  ): Promise<WorkspacePreparationFailure | null> {
    const status = await this.deps.workspaces.status({ cwd: path });
    if (!status.ok) {
      return this.failure(
        phase,
        [],
        `the workspace could not be inspected (${status.failure.code})`,
      );
    }
    if (status.value.clean) return null;

    const changes = status.value.entries.slice(0, MAX_REPORTED_CHANGES).map((entry) => entry.path);
    return this.failure(
      phase,
      changes,
      phase === 'checkout'
        ? 'the fresh checkout was not clean'
        : 'the install command changed files that are tracked or not ignored',
    );
  }

  /**
   * `project.commands.install`, in the workspace.
   *
   * A command a human wrote in a configuration file, run through the same
   * `ProcessRunner` and the same timeout policy as the validation commands
   * (S-11, V-01 unchanged). Nothing model-authored reaches a shell here — the
   * plan cannot supply this string.
   */
  private async runInstall(
    command: string,
    cwd: string,
  ): Promise<WorkspacePreparationFailure | null> {
    // Through `runCommands`, which is the one module allowed to name a shell
    // (V-01). Reusing it also means the install inherits the same timeout policy
    // and the same output handling the validation commands already have, rather
    // than growing a second answer to both.
    const outcome = await runCommands({
      processRunner: this.deps.processRunner,
      commands: [command],
      cwd,
    });

    if (outcome.passed) return null;

    // The exit status, never the output. `npm` writes the absolute path of the
    // directory it ran in on almost every failure, and this sentence is
    // persisted — see the note on `detail`. `doctor` is where the output goes
    // (§8.4), and the refused worktree keeps the real thing (§7.4).
    const exitCode = outcome.results.find((result) => result.exitCode !== 0)?.exitCode;
    return this.failure(
      'setup',
      [],
      exitCode === undefined || exitCode === null
        ? 'the install command did not complete'
        : `the install command exited ${String(exitCode)}`,
    );
  }

  private failure(
    phase: 'checkout' | 'setup',
    changes: readonly string[],
    detail: string,
  ): WorkspacePreparationFailure {
    return {
      code: 'task_workspace_preparation_failed',
      phase,
      changes,
      detail,
      at: this.deps.clock.now(),
    };
  }

  private refuse(
    phase: 'checkout' | 'setup',
    changes: readonly string[],
    detail: string,
  ): WorkspaceOutcome {
    return { ok: false, failure: this.failure(phase, changes, detail) };
  }
}
