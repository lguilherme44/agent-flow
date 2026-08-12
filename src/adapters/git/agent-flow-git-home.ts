import { isAbsolute, join } from 'node:path';
import type { FileSystem } from '../../ports/file-system.js';

/**
 * The two machine-wide directories MVP 2 owns, under the user's home (§7.1).
 *
 * ```text
 * ~/.agent-flow/
 * ├── no-hooks/     owned, empty — every internal Git command points
 * │                 core.hooksPath here (§12.3, I-7)
 * └── worktrees/    <repoKey>/<gitRunKey>/… — the root every worktree path
 *                   must resolve under (§7.1, S-3)
 * ```
 *
 * These are *outside* the user's repository on purpose, and both halves of that
 * matter. `.git/agent-flow/` was probed and rejected because Claude Code refuses
 * to write inside `.git`; a directory inside the working tree was rejected
 * because a worktree there is content the outer `git status` reports, which is
 * the surface this milestone exists to keep clean (§5.1).
 *
 * Resolved here — in an adapter — and never in `src/core`. The core decides what
 * a workspace is *called* (`worktree-policy.ts` returns path segments and a
 * POSIX-joined relative path); this module is the only place those segments meet
 * an operating system.
 */
export interface AgentFlowGitHome {
  /** `<home>/.agent-flow`. */
  readonly root: string;
  /** `<home>/.agent-flow/no-hooks` — owned, empty, never written to. */
  readonly noHooks: string;
  /** `<home>/.agent-flow/worktrees` — the containment root for every worktree. */
  readonly worktrees: string;
}

/** Pure path arithmetic. Creates nothing and asks the filesystem nothing. */
export function agentFlowGitHome(homeDir: string): AgentFlowGitHome {
  const root = join(homeDir, '.agent-flow');
  return { root, noHooks: join(root, 'no-hooks'), worktrees: join(root, 'worktrees') };
}

/**
 * Creates both directories and returns them with every symlink resolved.
 *
 * **Canonical, not merely absolute, and that is the whole reason this is async.**
 * `git worktree list` reports the paths Git recorded, which are canonical; a
 * containment check against an uncanonicalised root would compare two spellings
 * of the same directory and conclude they are different places. Homes behind a
 * symlink are ordinary — `/home/x` → `/data/home/x` on Linux, `/tmp` →
 * `/private/tmp` on macOS, which is exactly what the integration tests run under.
 *
 * `mkdirp` is idempotent, so this is safe to call on every command, and it runs
 * before `realPath` because a path that does not exist cannot be resolved.
 *
 * The no-hooks directory is created rather than merely named even though Git
 * tolerates `core.hooksPath` pointing at nothing (probed: `status` under a
 * non-existent hooks path exits 0). Naming a directory that does not exist would
 * make the isolation depend on it *staying* non-existent, and the first person to
 * run `mkdir ~/.agent-flow/no-hooks` and drop a script in it would have found a
 * way to run code inside every internal Git operation. An owned empty directory
 * is a thing we can assert about; an absent one is not.
 */
export async function provisionGitHome(
  fs: FileSystem,
  homeDir: string,
): Promise<AgentFlowGitHome> {
  if (!isAbsolute(homeDir)) {
    throw new Error(
      `the home directory must be absolute to host Agent Flow's Git state, got "${homeDir}"`,
    );
  }

  const declared = agentFlowGitHome(homeDir);
  await fs.mkdirp(declared.noHooks);
  await fs.mkdirp(declared.worktrees);

  const [noHooks, worktrees] = await Promise.all([
    fs.realPath(declared.noHooks),
    fs.realPath(declared.worktrees),
  ]);

  return {
    root: declared.root,
    // `mkdirp` just succeeded, so `realPath` returning null means the directory
    // vanished between two awaits. Falling back to the declared path keeps the
    // command working; it does not pretend the fallback was resolved.
    noHooks: noHooks ?? declared.noHooks,
    worktrees: worktrees ?? declared.worktrees,
  };
}
