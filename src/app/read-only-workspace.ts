import type { FileSystem } from '../ports/file-system.js';
import type { Host } from '../ports/host.js';
import type { GitWorkspaces, StatusEntry } from '../adapters/git/git-workspaces.js';
import type { WorkspaceLocation } from '../core/worktree-policy.js';

/**
 * A checkout a read-only stage may ruin (§6.1b).
 *
 * **`permissions: read-only` is a routing decision, not a containment guarantee**, and
 * §6.1 established that by measurement: `agy --sandbox` blocks the *terminal* and nothing
 * blocks the model reaching its edit tool, which was observed writing `.atl/` and 56 KB
 * into the repository under judgement. Claude Code and Codex are asked to behave through
 * a flag too. So the honest containment is not a better flag — it is a directory whose
 * contents nobody needs.
 *
 * **A twin of the tree the stage was going to read, not a checkout of HEAD.** That
 * distinction is the whole design. `git.useWorktrees` defaults to `false`, so the default
 * installation plans against a working tree that may hold uncommitted work — §6.2's stated
 * deviation allows exactly that — and a stage shown HEAD instead would describe a
 * repository that does not exist. So the tree is cut at the source's HEAD and then the
 * source's dirty paths are mirrored into it: modified and untracked files copied, deleted
 * ones deleted, a rename's old path removed. What the stage reads is what it read before.
 *
 * **Ignored files are deliberately absent.** `git status --untracked-files=all` does not
 * report them, so `node_modules` and `dist` do not cross — which is what keeps the copy
 * proportional to the change rather than to the repository. No read-only stage runs a
 * command; the two stages that do run commands run them elsewhere, before the read-only
 * agent is asked what the output means.
 *
 * **Cut per invocation and destroyed in a `finally`.** Measured on this repository at
 * 1107 tracked files: 1.5 s to add and 0.8 s to remove, on Windows. A cache keyed on a
 * fingerprint would save a few seconds per run and would, on the day the fingerprint is
 * wrong, show a stage the previous phase's code — which is a defect nobody would find by
 * reading the output. Slow and obviously correct beats fast and subtly wrong.
 */

/** One tree, and the promise to take it away. */
export interface ReadOnlyTree {
  /** Where the stage runs. Absolute. */
  readonly cwd: string;
  /** Removed through Git, never with `rm -rf` (§20.2). Safe to call twice. */
  release(): Promise<void>;
}

export const READ_ONLY_REFUSALS = [
  /** `resolveHead` failed, or the source has no commit — an unborn HEAD cannot be cut. */
  'no_head',
  /** `git worktree add` refused. The reason is Git's and is reported with it. */
  'no_worktree',
  /** The source's own dirt could not be read, so the twin cannot be shown to be faithful. */
  'no_status',
] as const;

export type ReadOnlyRefusal = (typeof READ_ONLY_REFUSALS)[number];

export type ReadOnlyOutcome =
  | { readonly ok: true; readonly tree: ReadOnlyTree }
  /**
   * The stage runs where it would have run, and the caller says so out loud.
   *
   * A read-only stage that *cannot run* is worse than one that runs uncontained: the
   * containment is a hardening of a path that has always worked, and refusing the run
   * because a scratch checkout could not be cut would turn a defence into an outage. The
   * caller records the degradation instead (R-16), so "this ran in your repository" is a
   * fact on the run rather than a silent fallback.
   */
  | { readonly ok: false; readonly reason: ReadOnlyRefusal; readonly detail: string };

export interface ReadOnlyWorkspaceDeps {
  readonly fs: FileSystem;
  readonly workspaces: GitWorkspaces;
  readonly host: Host;
}

/**
 * Names one tree, uniquely, for as long as this process runs.
 *
 * Parallel tasks each run their own `code-review`, so the pid alone is not enough — two
 * of them would name the same directory and the second `worktree add` would refuse. The
 * counter is process-local because the directory is: nothing outside this process ever
 * looks for it.
 */
let sequence = 0;

function locationFor(label: string, pid: number): WorkspaceLocation {
  sequence += 1;
  // A single flat segment under the owned root, for the reason `doctor`'s probe gives:
  // `git worktree remove` deletes the worktree directory and not its parent, so a nested
  // layout would leave an empty directory behind on every stage.
  const segment = `read-only-${slug(label)}-pid-${String(pid)}-${String(sequence)}`;
  return { segments: [segment], relativePath: segment };
}

/** Stage names are ours and already tame; this is the guard, not the expectation. */
function slug(label: string): string {
  const cleaned = label.toLowerCase().replaceAll(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'stage' : cleaned.slice(0, 40);
}

/**
 * Opens a disposable twin of `source`.
 *
 * `source` is the directory the stage would otherwise have run in — the project directory
 * for a planning stage, an attempt worktree for a code review, the integration tree for
 * the final review. Cutting the twin from *that* tree rather than always from the project
 * is what keeps a review reading the code it is reviewing.
 */
export async function openReadOnlyTree(
  deps: ReadOnlyWorkspaceDeps,
  options: { readonly source: string; readonly label: string },
): Promise<ReadOnlyOutcome> {
  const { fs, workspaces, host } = deps;

  const head = await workspaces.resolveHead(options.source);
  if (!head.ok) return { ok: false, reason: 'no_head', detail: head.failure.message };
  if (head.value === null) {
    return { ok: false, reason: 'no_head', detail: 'HEAD names no commit yet' };
  }

  // Read before the checkout, not after: `worktree add` takes a second on a large
  // repository, and a snapshot taken after it describes a tree that has had a second to
  // move. The window is not closed by this — nothing can close it while the operator has
  // an editor open — but it is the narrower of the two orders.
  const status = await workspaces.status({ cwd: options.source });
  if (!status.ok) return { ok: false, reason: 'no_status', detail: status.failure.message };

  const location = locationFor(options.label, host.pid);
  const added = await workspaces.addWorktree({
    cwd: options.source,
    location,
    base: head.value,
    reason: `agent-flow read-only stage ${options.label}`,
  });
  if (!added.ok) return { ok: false, reason: 'no_worktree', detail: added.failure.message };

  const tree: ReadOnlyTree = {
    cwd: added.value,
    release: async () => {
      // Unlocked first because it was created locked, and forced because the stage's whole
      // purpose here is to be allowed to dirty this tree — Git refuses to reclaim a
      // worktree holding a modified tracked file or an untracked non-ignored one, which is
      // the state a contained stage *is expected* to leave behind. Nothing here is
      // evidence: what the agent produced is its answer, which the stage has already
      // persisted, and a failed attempt's worktree is retained precisely because it is
      // evidence (§7.4). This one holds a copy of code that exists elsewhere.
      await workspaces.unlockWorktree({ cwd: options.source, location });
      await workspaces.removeWorktree({ cwd: options.source, location, force: true });

      // **And then the ignored files, which `git worktree remove` does not take.**
      //
      // Measured on this repository: three `doctor-install-probe-pid-*` directories in
      // the owned root, each holding nothing but `node_modules`, from probes that had
      // already removed their worktree successfully. `--force` discards *tracked*
      // modifications and untracked non-ignored files; anything `.gitignore` covers is
      // left where it is, and the directory with it. A read-only stage that writes into
      // `dist/` would leak one of those per invocation.
      //
      // Not a violation of §20.2's "never `rm -rf` a worktree". Git has already
      // unregistered this one — the removal above is what did it — so what is left is a
      // stray directory at a path *this process composed*, under Agent Flow's own root,
      // which is the one place a filesystem delete is the correct tool.
      if (await fs.exists(added.value)) await fs.remove(added.value);
    },
  };

  try {
    await mirror({ fs, from: options.source, to: added.value, entries: status.value.entries });
  } catch (error) {
    // A twin that is not faithful is worse than no twin: the stage would describe a tree
    // nobody has. So the checkout is taken away and the caller falls back, having been
    // told which of the two things failed.
    await tree.release();
    return {
      ok: false,
      reason: 'no_status',
      detail: error instanceof Error ? error.message : 'the working tree could not be mirrored',
    };
  }

  return { ok: true, tree };
}

/**
 * Makes the twin hold what the source holds.
 *
 * Only the paths `git status` named, which is why this is proportional to the change and
 * not to the repository. Three cases, and the third is the one a naive copy gets wrong:
 * a file the source has *deleted* is still present in a checkout of HEAD, and leaving it
 * there would show the stage a file the author removed.
 */
async function mirror(input: {
  readonly fs: FileSystem;
  readonly from: string;
  readonly to: string;
  readonly entries: readonly StatusEntry[];
}): Promise<void> {
  for (const entry of input.entries) {
    // A rename's source is gone from the working tree, whichever side recorded it.
    if (entry.originalPath !== undefined) {
      await input.fs.remove(`${input.to}/${entry.originalPath}`);
    }

    const deleted = entry.index === 'D' || entry.worktree === 'D';
    if (deleted) {
      await input.fs.remove(`${input.to}/${entry.path}`);
      continue;
    }

    const source = `${input.from}/${entry.path}`;
    // A directory can appear in `status` as an untracked entry when it holds nothing Git
    // will name individually; there is nothing to copy and nothing to fail over.
    const stat = await input.fs.stat(source);
    if (stat === null || stat.isDirectory) continue;

    const destination = `${input.to}/${entry.path}`;
    const parent = destination.slice(0, destination.lastIndexOf('/'));
    if (parent !== '') await input.fs.mkdirp(parent);
    // Byte-for-byte, through the port's own copy: a read-and-write through `readFile`
    // would decode as UTF-8 and hand the stage a corrupted PNG or lockfile.
    await input.fs.copyFile(source, destination);
  }
}
