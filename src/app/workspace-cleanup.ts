import { agentFlowPaths } from './paths.js';
import { reclaimNamespace, type ReclaimOutcome } from './namespace-reclaim.js';
import type { RunExecutionLock } from './run-execution-lock.js';
import type { StateStore } from './state-store.js';
import type { GitWorkspaces } from '../adapters/git/git-workspaces.js';
import type { FileSystem } from '../ports/file-system.js';
import type { Host } from '../ports/host.js';

/**
 * `clean`, as a use case rather than as a command (§20, M2-09).
 *
 * `namespace-reclaim.ts` already owned the dangerous half — what may be deleted, and in
 * which order. What lived in the CLI was the half above it: which runs are even
 * candidates, whether somebody is executing one right now, and the §20.1 rule that the
 * state directory goes last and only when the Git half succeeded.
 *
 * That was fine while a terminal was the only caller. It stops being fine the moment a
 * screen has to show what *would* be removed before removing it (7.7): a second
 * implementation of "which runs are old enough" is a second answer to the only question
 * a person is being asked to approve, and the copy that drifts is the one that deletes.
 *
 * **Nothing here renders**, and nothing here decides what a *reclaim* may touch — that
 * stays where it was, behind rules about derived paths and Git-confirmed ownership.
 */

/**
 * How many runs survive a cleanup nobody parameterised.
 *
 * Here rather than in the CLI's argument parsing, because the route needs the same number
 * and a default spelled twice is a default that drifts — the page would then preview a
 * cleanup the terminal would not perform.
 */
export const DEFAULT_RUNS_KEPT = 5;

export interface CleanupOptions {
  /** Keep the newest N runs. */
  readonly keep: number;
  /** Remove the active run too. Never a default: it holds in-flight work. */
  readonly force?: boolean;
  /** Also drop the cached repository map. */
  readonly cache?: boolean;
  /** §20.3: also reclaim the worktrees retention keeps by default. */
  readonly worktrees?: boolean;
  /** §20.3, §20.4: also delete an integration branch that is merged nowhere. */
  readonly branches?: boolean;
  /** Report what would happen and change nothing. */
  readonly dryRun?: boolean;
}

/**
 * What happened to one run, or what would.
 *
 * `locked` and `namespace_failed` are refusals with different repairs — one is "somebody
 * is working on this", the other is "Git would not let go of something" — and collapsing
 * them into a single failure was how the terminal came to print one sentence for both.
 */
export type RunCleanup =
  | { readonly runId: string; readonly outcome: 'locked' }
  | { readonly runId: string; readonly outcome: 'namespace_failed'; readonly reclaim: ReclaimOutcome }
  | { readonly runId: string; readonly outcome: 'removed'; readonly reclaim: ReclaimOutcome };

export interface CleanupReport {
  /** True when nothing was written: every outcome below is what *would* happen. */
  readonly dryRun: boolean;
  readonly keep: number;
  /** Every run on disk, so "nothing to remove" can say what it kept. */
  readonly totalRuns: number;
  readonly runs: readonly RunCleanup[];
  /**
   * The active run, kept because `force` was not set.
   *
   * Named rather than silently skipped: a cleanup that quietly leaves out the run you are
   * working on and a cleanup that cannot see it look identical from the outside.
   */
  readonly protectedRun?: string;
  /** Whether the cached repository map was removed, or would be. */
  readonly cacheRemoved: boolean;
  /** Any run refused — the caller's non-zero exit, and the page's warning. */
  readonly refused: boolean;
}

export interface CleanupDeps {
  readonly fs: FileSystem;
  readonly host: Host;
  readonly workspaces: GitWorkspaces;
  readonly store: StateStore;
  readonly lock: RunExecutionLock;
  readonly projectDir: string;
}

/**
 * Decides what may go, and — unless this is a dry run — makes it go.
 *
 * One function for both, deliberately. A dry run that took a different path through the
 * code would be a preview of a different operation, which is the one thing a preview may
 * never be: the page shows this report and then asks a person to approve *it*.
 */
export async function cleanWorkspace(
  deps: CleanupDeps,
  options: CleanupOptions,
): Promise<CleanupReport> {
  const paths = agentFlowPaths(deps.projectDir);
  const runIds = await deps.store.listRunIds();
  const current = await deps.store.currentRunId();

  // listRunIds is newest first, so everything past `keep` is old.
  const candidates = runIds.slice(options.keep);
  const removable = candidates.filter((id) => id !== current || options.force === true);
  const protectedRun = candidates.find((id) => id === current && options.force !== true);

  const runs: RunCleanup[] = [];
  let refused = false;

  for (const runId of removable) {
    // §20.2: a run whose execution lock is held is refused. Inspected rather than
    // acquired — taking the lease to decide whether to delete a run would make `clean` an
    // operation that competes with the scheduler, and the honest answer here is "somebody
    // is working on this one".
    if ((await deps.lock.describe(runId)) !== undefined) {
      runs.push({ runId, outcome: 'locked' });
      refused = true;
      continue;
    }

    const reclaim = await reclaimNamespace(
      {
        workspaces: deps.workspaces,
        fs: deps.fs,
        host: deps.host,
        projectDir: deps.projectDir,
        store: deps.store,
      },
      runId,
      {
        ...(options.dryRun === true ? { dryRun: true } : {}),
        ...(options.worktrees === true ? { worktrees: true } : {}),
        ...(options.branches === true ? { branches: true } : {}),
      },
    );

    if (!reclaim.stateRemovable) {
      // §20.1: step 5 must not run. The state is what explains the worktrees and refs
      // still on disk, so it stays until they are gone.
      runs.push({ runId, outcome: 'namespace_failed', reclaim });
      refused = true;
      continue;
    }

    if (options.dryRun !== true) await deps.fs.remove(`${paths.runsDir}/${runId}`);
    runs.push({ runId, outcome: 'removed', reclaim });
  }

  const cacheRemoved =
    options.cache === true && (await deps.fs.exists(paths.architectureCache));
  if (cacheRemoved && options.dryRun !== true) await deps.fs.remove(paths.architectureCache);

  return {
    dryRun: options.dryRun === true,
    keep: options.keep,
    totalRuns: runIds.length,
    runs,
    ...(protectedRun === undefined ? {} : { protectedRun }),
    cacheRemoved,
    refused,
  };
}
