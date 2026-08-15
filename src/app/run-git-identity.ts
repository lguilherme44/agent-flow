import { createHash } from 'node:crypto';
import type { EffectiveConfig, IsolationMode, RunState } from '../contracts/index.js';
import type { FileSystem } from '../ports/file-system.js';
import type { Host } from '../ports/host.js';
import type { GitWorkspaces } from '../adapters/git/git-workspaces.js';
import {
  MINIMUM_SUPPORTED_GIT_VERSION,
  formatGitVersion,
} from '../adapters/git/git-workspaces.js';
import {
  MAX_SUPPORTED_ATTEMPT,
  attemptWorkspace,
  gitRunKeyBelongsToRun,
  integrationRef,
  makeGitRunKey,
  repoKeyFromCanonicalRoot,
} from '../core/worktree-policy.js';
import { agentFlowPaths } from './paths.js';

/**
 * A run's Git identity, decided once — at creation — and never again (I-13).
 *
 * **This module is the only reader of `git.useWorktrees` that decides anything.**
 * Everything downstream reads `state.isolationMode` instead, and an architecture
 * test pins the allowlist to this file. That is the whole mechanism, and it is
 * worth stating why it needs one:
 *
 * ```text
 * useWorktrees: false        run is created
 * dirty working tree         gates are observational — planning proceeds
 *                            the SDD and the plan describe the DIRTY tree
 * git stash                  the tree is clean now; HEAD never moved
 * useWorktrees: true         the user flips the flag
 * agent-flow start           every individual check passes
 *                            → the work is built against a tree the plan was
 *                              never written against, and nothing reports it
 * ```
 *
 * Every check in that sequence answers correctly. The defect is that *"is this
 * run isolated?"* was asked twice, at two moments, of a source that could change
 * in between. Captured once at creation, the first line decides all of them.
 *
 * Two responsibilities, deliberately separated because they answer different
 * questions at different times:
 *
 *   - {@link resolveRunGitIdentity} — *what mode is this run born in, and what
 *     is its base?* Asked once, by `createRun`, before discovery or planning
 *     observes the repository.
 *   - {@link checkWorktreePreconditions} — *can this run execute, right now, in
 *     the mode it was born in?* Asked at approve, at start and between planning
 *     stages. **It writes nothing**: a refusal reports that the repository is
 *     not ready, it does not reclassify the run (§6.4).
 */

// ---------------------------------------------------------------------------
// Refusal vocabulary (§6.3, §23)
// ---------------------------------------------------------------------------

export const WORKTREE_REFUSAL_CODES = [
  // Structural: no action taken during the run changes these, which is why
  // §6.1 evaluates them at creation where the refusal costs the user nothing.
  'not_a_git_repository',
  'repository_is_bare',
  'repository_has_no_commits',
  'repository_has_submodules',
  'git_version_unsupported',
  'repository_root_unresolvable',
  'worktree_path_too_long',
  // Per-entry: the reason the precondition check still exists after creation.
  'git_identity_missing',
  'agent_flow_state_not_ignored',
  'working_tree_dirty',
  'planning_base_moved',
  'git_run_key_collision',
  'namespace_missing',
  'integration_head_diverged',
  // Reading the repository failed in a way none of the above describes.
  'git_unavailable',
] as const;

export type WorktreeRefusalCode = (typeof WORKTREE_REFUSAL_CODES)[number];

export interface WorktreeRefusal {
  readonly code: WorktreeRefusalCode;
  /** What is wrong, in the words the caller puts in front of a person. */
  readonly detail: string;
}

/**
 * §6.3's shape. A refusal is a value: every code names a repository state a user
 * changes with one command, so rejection is an expected outcome rather than an
 * exception.
 */
export type WorktreePreconditions =
  | { readonly satisfied: true }
  | { readonly satisfied: false; readonly code: WorktreeRefusalCode; readonly detail: string };

/** What a person is told to do about each refusal. */
export function worktreeRefusalAction(code: WorktreeRefusalCode): string {
  switch (code) {
    case 'not_a_git_repository':
      return 'Run `git init`, or turn worktree mode off with `git.useWorktrees: false`.';
    case 'repository_is_bare':
      return 'Worktree mode needs a working tree. Use a normal clone.';
    case 'repository_has_no_commits':
      return 'Make the first commit; there is no base to cut a branch from yet.';
    case 'repository_has_submodules':
      return 'Worktree mode does not populate submodules. Turn it off for this project.';
    case 'git_version_unsupported':
      return `Upgrade Git to ${formatGitVersion(MINIMUM_SUPPORTED_GIT_VERSION)} or newer.`;
    case 'repository_root_unresolvable':
      return 'The repository root could not be resolved. Check for a broken symlink above it.';
    case 'worktree_path_too_long':
      return 'Use a shorter home directory path, or enable long paths on this platform.';
    case 'git_identity_missing':
      return 'This run has no Git namespace. Start a new run.';
    case 'agent_flow_state_not_ignored':
      return 'Add `.agent-flow/runs/`, `.agent-flow/cache/` and `.agent-flow/current-run` to .gitignore.';
    case 'working_tree_dirty':
      return 'Commit or stash your changes, then try again.';
    case 'planning_base_moved':
      return 'Check out the commit this run was planned against, or start a new run.';
    case 'git_run_key_collision':
      return 'This run’s Git namespace already holds refs it did not create. Start a new run.';
    case 'namespace_missing':
      return 'The integration branch this run recorded work on is gone. It cannot be rebuilt from here.';
    case 'integration_head_diverged':
      return 'The integration branch was rewound or replaced under this run. Start a new run.';
    case 'git_unavailable':
      return 'Git could not be run. Check that it is installed and on PATH.';
  }
}

// ---------------------------------------------------------------------------
// Creation (§6.1)
// ---------------------------------------------------------------------------

/**
 * The identity fields, ready to be handed to `StateStore.createRun`.
 *
 * All three, or `isolationMode` and `planningBase` without a key only when the
 * run is sequential — a `worktree` run without a namespace is not
 * representable, which {@link composeRunIdentity} enforces rather than trusts.
 */
export interface RunIdentityFields {
  readonly isolationMode: IsolationMode;
  readonly planningBase?: string;
  readonly gitRunKey?: string;
}

/**
 * What creation decided, before the run has an id to name its namespace with.
 *
 * The entropy is generated here — at the moment the decision is made — and
 * composed into a `gitRunKey` once `StateStore` allocates the run id. Splitting
 * it that way keeps randomness in the application layer, where §5.2 puts it,
 * and keeps `StateStore` free of both Git and a random source.
 */
export interface ResolvedRunIdentity {
  readonly isolationMode: IsolationMode;
  readonly planningBase?: string;
  readonly entropyHex: string;
}

export type RunIdentityOutcome =
  | { readonly ok: true; readonly value: ResolvedRunIdentity }
  | { readonly ok: false; readonly refusal: WorktreeRefusal };

/**
 * What reading the repository needs — and **deliberately not the configuration**.
 *
 * The precondition check cannot consult `git.useWorktrees` because it is never
 * handed it. That is the difference between a rule and a structure: a test that
 * asserted "no precondition reads the config" would be a text search, and this
 * is the compiler. It matters because a precondition that asked the
 * configuration a second time would reintroduce the §6.2 sequence that capturing
 * the mode at creation exists to remove.
 */
export interface RepositoryDeps {
  readonly workspaces: GitWorkspaces;
  readonly fs: FileSystem;
  readonly host: Host;
  readonly projectDir: string;
}

/** Creation additionally needs the configuration — once, to decide the mode. */
export interface RunGitIdentityDeps extends RepositoryDeps {
  readonly config: EffectiveConfig;
}

/** 64 bits, as §5.2 requires — eight bytes, sixteen hex characters. */
const RUN_ENTROPY_BYTES = 8;

/**
 * Decides the mode a new run is born in, and captures its base (§6.1).
 *
 * ```text
 * config.global.git.useWorktrees ? 'worktree' : 'none'
 * ```
 *
 * `config.global` is already the merged result — defaults, then the global file,
 * then the project overlay — so this *is* the effective value including a
 * per-project override. Reading only the global layer would silently ignore a
 * project's `useWorktrees: true`, which no other setting in this tool does; the
 * property that matters is **when** the value is read, not which layer supplies
 * it.
 *
 * **A run being born sequential is asked nothing that could refuse it.**
 * `planningBase` is still read, because §6.2's observational gates compare
 * against it and `planning_base_observation` needs something to observe — but a
 * directory that is not a repository simply yields no base, which is the honest
 * value and is what §25 promises keeps working.
 *
 * A run being born `worktree` is preflighted against the structural checks
 * (§6.3, 1–6) here, at creation, because none of them is something a user action
 * during the run will change — so refusing now saves them a discovery pass, a
 * planning pass and a plan review before the same answer arrives.
 */
export async function resolveRunGitIdentity(
  deps: RunGitIdentityDeps,
): Promise<RunIdentityOutcome> {
  const wantsWorktrees = deps.config.global.git.useWorktrees;

  if (!wantsWorktrees) {
    return {
      ok: true,
      value: {
        isolationMode: 'none',
        ...(await observePlanningBase(deps)),
        entropyHex: deps.host.randomHex(RUN_ENTROPY_BYTES),
      },
    };
  }

  const structural = await checkStructuralPreconditions(deps);
  if (structural !== null) return { ok: false, refusal: structural };

  // Checked by `checkStructuralPreconditions`, which refuses an unborn HEAD —
  // so this resolves, and a base is required rather than optional here.
  const head = await deps.workspaces.resolveHead(deps.projectDir);
  if (!head.ok || head.value === null) {
    return {
      ok: false,
      refusal: {
        code: 'repository_has_no_commits',
        detail: 'HEAD does not name a commit, so there is no base to cut the run from',
      },
    };
  }

  return {
    ok: true,
    value: {
      isolationMode: 'worktree',
      planningBase: head.value,
      entropyHex: deps.host.randomHex(RUN_ENTROPY_BYTES),
    },
  };
}

/**
 * Evaluates deterministic repository preflight checks before a run is created.
 *
 * Checks structural conditions (1–6), repository commits, state paths ignored (8),
 * and clean working tree (9) when worktrees are requested.
 *
 * If this returns satisfied: false, StateStore.createRun MUST NOT be called.
 */
export async function checkPlanningPreflight(
  deps: RunGitIdentityDeps,
): Promise<WorktreePreconditions> {
  const wantsWorktrees = deps.config.global.git.useWorktrees;
  if (!wantsWorktrees) return SATISFIED;

  const structural = await checkStructuralPreconditions(deps);
  if (structural !== null) return refuse(structural.code, structural.detail);

  const head = await deps.workspaces.resolveHead(deps.projectDir);
  if (!head.ok) return unreadable(head.failure.message);
  if (head.value === null) {
    return refuse(
      'repository_has_no_commits',
      'HEAD does not name a commit, so there is no base to cut the run from',
    );
  }

  const ignored = await checkStatePathsIgnored(deps);
  if (ignored.kind === 'unreadable') return unreadable(ignored.detail);
  if (ignored.kind === 'not_ignored') {
    return refuse(
      'agent_flow_state_not_ignored',
      `${ignored.path} is not ignored by this repository, so Agent Flow's own state would dirty the tree`,
    );
  }

  const status = await deps.workspaces.status({ cwd: deps.projectDir });
  if (!status.ok) return unreadable(status.failure.message);
  if (!status.value.clean) {
    const changed = status.value.entries.slice(0, 5).map((entry) => entry.path);
    return refuse(
      'working_tree_dirty',
      `the working tree has uncommitted changes: ${changed.join(', ')}${
        status.value.entries.length > changed.length ? ' …' : ''
      }`,
    );
  }

  return SATISFIED;
}

/**
 * Best-effort base for a sequential run.
 *
 * Every failure is absence, never a refusal. A project that is not a repository
 * has always been able to run this tool, and §25.1 promises that is unchanged.
 */
async function observePlanningBase(
  deps: RepositoryDeps,
): Promise<{ planningBase?: string }> {
  const head = await deps.workspaces.resolveHead(deps.projectDir);
  if (!head.ok || head.value === null) return {};
  return { planningBase: head.value };
}

/**
 * Composes the persisted fields once the run id exists.
 *
 * The `gitRunKey` is `runId + '-' + 16 hex` (§5.2), built by the pure policy
 * function in `core/worktree-policy.ts` rather than by string concatenation
 * here — so the shape has exactly one definition, and the schema that validates
 * it later cannot disagree with the code that produced it.
 *
 * A `worktree` run that cannot be given a namespace is refused rather than
 * persisted without one: §6.3 check 7 exists to catch that state, and a writer
 * that can create it makes the check a repair rather than an assertion.
 */
export function composeRunIdentity(
  runId: string,
  resolved: ResolvedRunIdentity,
): RunIdentityFields {
  const key = makeGitRunKey(runId, resolved.entropyHex);

  if (!key.ok) {
    if (resolved.isolationMode === 'worktree') {
      throw new Error(
        `cannot create an isolated run without a Git namespace: ${key.refusal.reason}`,
      );
    }
    return {
      isolationMode: resolved.isolationMode,
      ...(resolved.planningBase === undefined ? {} : { planningBase: resolved.planningBase }),
    };
  }

  return {
    isolationMode: resolved.isolationMode,
    ...(resolved.planningBase === undefined ? {} : { planningBase: resolved.planningBase }),
    gitRunKey: key.value,
  };
}

// ---------------------------------------------------------------------------
// Execution preconditions (§6.3)
// ---------------------------------------------------------------------------

const SATISFIED: WorktreePreconditions = { satisfied: true };

function refuse(code: WorktreeRefusalCode, detail: string): WorktreePreconditions {
  return { satisfied: false, code, detail };
}

/**
 * Can this run execute, right now, in the mode it was born in?
 *
 * **Evaluated only when `state.isolationMode === 'worktree'`.** A sequential run
 * has no preconditions to satisfy — it executes the way this tool has always
 * executed — and a legacy run (§25.2) is sequential by shape, its
 * `isolationMode` absent rather than `'none'`. Neither of them asks Git
 * anything, including in a directory that is not a repository.
 *
 * Checked cheapest and most conclusive first, in the order §6.3 fixes. Nothing
 * here writes to run state (§6.4): the repository's readiness is a moment, and
 * the run's intent is a fact.
 */
export async function checkWorktreePreconditions(
  deps: RepositoryDeps,
  state: RunState,
): Promise<WorktreePreconditions> {
  if (state.isolationMode !== 'worktree') return SATISFIED;

  const structural = await checkStructuralPreconditions(deps);
  if (structural !== null) return refuse(structural.code, structural.detail);

  // 7 — the run must own its namespace, and the invariant is that the key
  // begins with the run's own id (§5.2). A mismatch means the state file pairs
  // this run with somebody else's namespace: a refusal, never a repair.
  if (state.gitRunKey === undefined) {
    return refuse('git_identity_missing', 'this run has no Git namespace recorded');
  }
  if (!gitRunKeyBelongsToRun(state.gitRunKey, state.runId)) {
    return refuse(
      'git_identity_missing',
      `the recorded Git namespace "${state.gitRunKey}" does not belong to ${state.runId}`,
    );
  }

  // 8 — without this the run refuses *itself*. `init` gitignores these three;
  // if any is tracked, the run's own state files dirty the tree and check 9
  // below reports files Agent Flow just wrote.
  const ignored = await checkStatePathsIgnored(deps);
  if (ignored.kind === 'unreadable') return unreadable(ignored.detail);
  if (ignored.kind === 'not_ignored') {
    return refuse(
      'agent_flow_state_not_ignored',
      `${ignored.path} is not ignored by this repository, so Agent Flow's own state would dirty the tree`,
    );
  }

  // 9 — dirty tree. Not forcible, and deliberately: a --force here would be a
  // flag whose only function is to produce an unexplainable tree.
  const status = await deps.workspaces.status({ cwd: deps.projectDir });
  if (!status.ok) return unreadable(status.failure.message);
  if (!status.value.clean) {
    const changed = status.value.entries.slice(0, 5).map((entry) => entry.path);
    return refuse(
      'working_tree_dirty',
      `the working tree has uncommitted changes: ${changed.join(', ')}${
        status.value.entries.length > changed.length ? ' …' : ''
      }`,
    );
  }

  // 10 — HEAD must still be the commit this run was planned against. Applies on
  // every entry, including a resume: a user who moved HEAD changed the ground
  // the work would be built on.
  const head = await deps.workspaces.resolveHead(deps.projectDir);
  if (!head.ok) return unreadable(head.failure.message);
  if (state.planningBase !== undefined && head.value !== state.planningBase) {
    return refuse(
      'planning_base_moved',
      `this run was planned against ${state.planningBase.slice(0, 8)} and HEAD is now ${
        head.value === null ? 'unborn' : head.value.slice(0, 8)
      }`,
    );
  }

  // 11 — the namespace must be this run's own. `integrationHead` is the
  // discriminator (§5.3): absent means the namespace has never been
  // initialised, so anything already inside it belongs to somebody else. Cases
  // A and B are not refusals and nothing here creates a ref — initialisation
  // is M2-06's, not this milestone's.
  return checkNamespace(deps, state);
}

/**
 * Checks 1–6, which are facts about the machine rather than about the run.
 *
 * Shared by creation and execution on purpose: §6.1 refuses early because the
 * answer cannot change during the run, and §6.3 asks again because a run can be
 * resumed on another machine, with another Git, at another path length.
 */
async function checkStructuralPreconditions(
  deps: RepositoryDeps,
): Promise<WorktreeRefusal | null> {
  const isRepo = await deps.workspaces.isWorkTree(deps.projectDir);
  if (!isRepo.ok) {
    return { code: 'git_unavailable', detail: isRepo.failure.message };
  }
  if (!isRepo.value) {
    // A bare repository is not a work tree either, so the two are told apart
    // before this reports the less specific answer.
    const bare = await deps.workspaces.isBareRepository(deps.projectDir);
    if (bare.ok && bare.value) {
      return { code: 'repository_is_bare', detail: 'a bare repository has no working tree' };
    }
    return {
      code: 'not_a_git_repository',
      detail: `${deps.projectDir} is not inside a Git working tree`,
    };
  }

  const head = await deps.workspaces.resolveHead(deps.projectDir);
  if (!head.ok) return { code: 'git_unavailable', detail: head.failure.message };
  if (head.value === null) {
    return {
      code: 'repository_has_no_commits',
      detail: 'HEAD is unborn, so there is no commit to cut the run from',
    };
  }

  const submodules = await hasSubmodules(deps);
  if (submodules === null) {
    return { code: 'git_unavailable', detail: 'git submodule status could not be read' };
  }
  if (submodules) {
    return {
      code: 'repository_has_submodules',
      detail: 'git worktree add does not populate submodules, so the worktree would be incomplete',
    };
  }

  const version = await deps.workspaces.requireSupportedVersion(deps.projectDir);
  if (!version.ok) {
    // Named separately from the generic read failure: "your Git is too old" has
    // a fix, and "git could not be run" has a different one.
    return {
      code: version.failure.code === 'git_version_unsupported' ? 'git_version_unsupported' : 'git_unavailable',
      detail: version.failure.message,
    };
  }

  return checkWorktreeRoot(deps);
}

/**
 * Checks 6 and the `repository_root_unresolvable` case of §23, together —
 * because both need the same derivation and neither is meaningful without it.
 *
 * `repoKey` is derived exactly as §5.1 specifies: the realpath of the parent of
 * the common directory, hashed verbatim, with a human-readable slug in front.
 * The hash is computed here rather than in `core/worktree-policy.ts`, which
 * takes the digest as an argument so that it can stay free of Node built-ins.
 */
async function checkWorktreeRoot(deps: RepositoryDeps): Promise<WorktreeRefusal | null> {
  const repoKey = await deriveRepoKey(deps);
  if (repoKey === null) {
    return {
      code: 'repository_root_unresolvable',
      detail: 'the repository root could not be resolved, so its identity would not be stable',
    };
  }

  const deepest = await deps.workspaces.deepestTrackedPathLength(deps.projectDir, (path) =>
    deps.host.measurePathLength(path),
  );
  if (!deepest.ok) {
    return { code: 'git_unavailable', detail: deepest.failure.message };
  }

  const projected = projectWorstCaseWorktreePath({
    homeDir: deps.host.homeDir,
    repoKey,
    deepestTrackedPathLength: deepest.value,
    measure: (value) => deps.host.measurePathLength(value),
  });
  if (projected === null) {
    return {
      code: 'repository_root_unresolvable',
      detail: 'a worst-case workspace path could not be composed from this repository key',
    };
  }

  if (projected > deps.host.maxPathLength) {
    return {
      code: 'worktree_path_too_long',
      detail:
        `the deepest file a worktree would hold projects to ${String(projected)} characters, ` +
        `over this platform's limit of ${String(deps.host.maxPathLength)}`,
    };
  }

  return null;
}

/**
 * §23's projection, as a length: **root + repoKey + gitRunKey + taskId +
 * attempt-<n> + the repository's own deepest tracked path**.
 *
 * Every term is the worst case the contracts admit rather than a typical one,
 * because the check exists to refuse *before* a checkout discovers the same
 * thing halfway through:
 *
 *   - the run key is a fixed 28 characters by construction (§5.2);
 *   - the task id is the widest `AnyTaskIdSchema` allows;
 *   - the attempt is `MAX_SUPPORTED_ATTEMPT`, taken from the module that
 *     *validates* attempts rather than assumed. `retry.maxAttempts` has no
 *     ceiling in the configuration schema, so `attempt-1000` is legal and a
 *     three-digit assumption would under-project — in the direction that permits
 *     a path the filesystem then refuses;
 *   - the last term is the actual repository, measured with `ls-files`, and is
 *     the one term nothing can bound in advance. It is why §23 names it.
 *
 * **Measured in the platform's unit**, through `Host.measurePathLength`: on
 * POSIX `PATH_MAX` bounds a byte string, so a repository of accented or CJK
 * filenames is longer than its JavaScript length; on Windows `MAX_PATH` bounds
 * UTF-16 units, where the two agree.
 *
 * Returned as a number rather than a string because nothing needs the path — and
 * a function that produced one would be a function somebody could be tempted to
 * create a directory from.
 */
export function projectWorstCaseWorktreePath(inputs: {
  readonly homeDir: string;
  readonly repoKey: string;
  readonly deepestTrackedPathLength: number;
  readonly measure: (value: string) => number;
}): number | null {
  const worstCase = attemptWorkspace(
    inputs.repoKey,
    // `AF-YYYY-NNN-<16 hex>`: the widest a `gitRunKey` can be (§5.2).
    'AF-2026-001-0000000000000000',
    // The widest task id the plan contracts admit.
    'TASK-000',
    MAX_SUPPORTED_ATTEMPT,
  );
  if (!worstCase.ok) return null;

  // Composed from measured segments plus a separator count rather than by
  // building the string, so this cannot drift from what `GitWorkspaces` would
  // join — and so no absolute path is ever materialised here.
  const root = `${inputs.homeDir}/.agent-flow/worktrees`;
  const separators = worstCase.value.segments.length + 1;
  const segments = worstCase.value.segments.reduce(
    (total, part) => total + inputs.measure(part),
    0,
  );

  return inputs.measure(root) + separators + segments + inputs.deepestTrackedPathLength;
}

export async function deriveRepoKey(deps: RepositoryDeps): Promise<string | null> {
  const commonDir = await deps.workspaces.commonDir(deps.projectDir);
  if (!commonDir.ok) return null;

  // `dirname` of the common directory: `<root>/.git` → `<root>`.
  const parent = commonDir.value.replace(/[\\/][^\\/]*$/, '');
  const canonical = await deps.fs.realPath(parent.length === 0 ? commonDir.value : parent);
  if (canonical === null) return null;

  const digest = createHash('sha256').update(canonical).digest('hex');
  const key = repoKeyFromCanonicalRoot(canonical, digest);
  return key.ok ? key.value : null;
}

/** `.gitmodules` **and** a non-empty `git submodule status`, as §23 requires. */
async function hasSubmodules(deps: RepositoryDeps): Promise<boolean | null> {
  if (!(await deps.fs.exists(`${deps.projectDir}/.gitmodules`))) return false;

  const status = await deps.workspaces.hasSubmodules(deps.projectDir);
  return status.ok ? status.value : null;
}

/**
 * The three paths `init` gitignores, checked one at a time (§6.3 check 8).
 *
 * Three answers, kept apart. Collapsing the third into the second is the bug
 * this shape exists to prevent: *"the repository says this is not ignored"* and
 * *"Git could not tell me"* are different facts, and only the first has
 * `.gitignore` as its fix. Telling somebody to edit a file when the real problem
 * is that Git would not run teaches them the message is unreliable.
 */
type StatePathVerdict =
  | { readonly kind: 'all_ignored' }
  | { readonly kind: 'not_ignored'; readonly path: string }
  | { readonly kind: 'unreadable'; readonly detail: string };

async function checkStatePathsIgnored(deps: RepositoryDeps): Promise<StatePathVerdict> {
  const paths = agentFlowPaths(deps.projectDir);
  const relative = [
    `${relativeName(paths.runsDir, deps.projectDir)}/`,
    `${relativeName(paths.cacheDir, deps.projectDir)}/`,
    relativeName(paths.currentRun, deps.projectDir),
  ];

  for (const path of relative) {
    const ignored = await deps.workspaces.isIgnored({ cwd: deps.projectDir, path });
    if (!ignored.ok) return { kind: 'unreadable', detail: ignored.failure.message };
    if (!ignored.value) return { kind: 'not_ignored', path };
  }

  return { kind: 'all_ignored' };
}

function relativeName(absolute: string, projectDir: string): string {
  return absolute.startsWith(`${projectDir}/`) ? absolute.slice(projectDir.length + 1) : absolute;
}

/**
 * §6.3 check 11: reads the namespace and hands the facts to {@link decideNamespace}.
 *
 * **This evaluates; it does not initialise.** §6.3 is explicit that "cases A and
 * B are not refusals", and the *actions* those cases name — create the branch,
 * create the integration worktree, persist `integrationHead` — belong to §14.1,
 * which M2-06 owns. So an empty namespace and an adoptable one both return
 * satisfied here, and nothing in this milestone writes a ref.
 *
 * The `integration_head_diverged` half of case D needs an ancestry query and so
 * cannot live in the pure function; the pure function says "resume" and this
 * confirms the recorded head is actually part of the branch.
 */
async function checkNamespace(
  deps: RepositoryDeps,
  state: RunState,
): Promise<WorktreePreconditions> {
  const key = state.gitRunKey;
  if (key === undefined) return refuse('git_identity_missing', 'this run has no Git namespace');

  const integration = integrationRef(key);
  if (!integration.ok) {
    return refuse('git_identity_missing', integration.refusal.reason);
  }
  const integrationRefName = `refs/heads/${integration.value}`;

  // A prefix, never a glob: `refs/heads/agent-flow/<key>/*` matches one path
  // component and would silently omit every attempt ref, reporting an empty
  // namespace that is not empty (M2-02 finding).
  const refs = await deps.workspaces.refsUnder({
    cwd: deps.projectDir,
    prefix: `refs/heads/agent-flow/${key}`,
  });
  if (!refs.ok) return unreadable(refs.failure.message);

  const decision = decideNamespace({
    integrationHead: state.integrationHead,
    planningBase: state.planningBase,
    integrationBranch: refs.value.find((ref) => ref.ref === integrationRefName)?.oid,
    otherRefs: refs.value.filter((ref) => ref.ref !== integrationRefName).map((ref) => ref.ref),
  });

  if (decision.kind === 'refuse') return refuse(decision.code, decision.detail);
  if (decision.kind !== 'resume') return SATISFIED;

  // Case D, the half that needs the repository. `integrationHead` being *behind*
  // the branch is not a failure — that is §17.3 window 7, a merge that landed
  // before the state write, and recovery reconciles it forward. Not being an
  // ancestor at all is: the branch was rewound, reset or replaced under a
  // running run, and the state's claim and the repository cannot both be true.
  const recorded = state.integrationHead;
  if (recorded === undefined) return SATISFIED;

  const ancestor = await deps.workspaces.isAncestor({
    cwd: deps.projectDir,
    ancestor: recorded,
    descendant: integrationRefName,
  });
  if (!ancestor.ok) return unreadable(ancestor.failure.message);

  return ancestor.value
    ? SATISFIED
    : refuse(
        'integration_head_diverged',
        `the integration branch no longer contains ${recorded.slice(0, 8)}, which this run recorded as integrated`,
      );
}

function unreadable(detail: string): WorktreePreconditions {
  return refuse('git_unavailable', detail);
}

// ---------------------------------------------------------------------------
// Sequential observation (§6.2)
// ---------------------------------------------------------------------------

/**
 * What the same two checks say about a run that is **not** isolated.
 *
 * §6.2's stated deviation: enforcing the gates unconditionally would refuse
 * every existing user who plans a feature on a dirty working tree, which
 * sequential mode has always allowed and which is the normal way people work.
 * So for a sequential run the checks still run and their result is recorded —
 * the information exists without the refusal.
 */
export interface PlanningBaseObservation {
  /** True when the working tree had no uncommitted changes at this moment. */
  readonly clean: boolean;
  /** True when HEAD is still the commit the run was created against. */
  readonly matches: boolean;
  readonly planningBase: string;
  /** Absent when HEAD does not resolve at all. */
  readonly head?: string;
  /** At most a handful, so an event stays readable. Repository-relative. */
  readonly changed: readonly string[];
}

/**
 * Observes, and returns `null` when there is nothing to observe.
 *
 * `null` covers the two cases that must stay silent: a run with no
 * `planningBase` — a project that is not a repository, which §25 promises keeps
 * working — and a repository Git cannot answer questions about. Neither is worth
 * an event, and neither may become an error.
 *
 * **Legacy runs are not observed at all.** §25.2 is explicit that a run
 * predating these fields has no preconditions evaluated and no gates enforced;
 * it has no `planningBase` to compare against either, so the `null` above is the
 * same answer arrived at twice.
 */
export async function observePlanningBaseDrift(
  deps: RepositoryDeps,
  state: RunState,
): Promise<PlanningBaseObservation | null> {
  if (state.isolationMode !== 'none') return null;
  if (state.planningBase === undefined) return null;

  const status = await deps.workspaces.status({ cwd: deps.projectDir });
  if (!status.ok) return null;

  const head = await deps.workspaces.resolveHead(deps.projectDir);
  if (!head.ok) return null;

  return {
    clean: status.value.clean,
    matches: head.value === state.planningBase,
    planningBase: state.planningBase,
    ...(head.value === null ? {} : { head: head.value }),
    changed: status.value.entries.slice(0, 5).map((entry) => entry.path),
  };
}

/**
 * The four moments §6.2 names, as one vocabulary.
 *
 * Written down so the event's `moment` field is a closed set rather than
 * whatever string a call site passed, and so that adding a fifth moment is a
 * deliberate edit in one place.
 */
export const PLANNING_BASE_MOMENTS = [
  'planning start',
  'architecture-impact',
  'sdd',
  'planning',
  'approve',
  'implementation start',
] as const;

export type PlanningBaseMoment = (typeof PLANNING_BASE_MOMENTS)[number];

// ---------------------------------------------------------------------------
// The §5.3 initialisation algorithm, as a pure decision
// ---------------------------------------------------------------------------

/**
 * What the repository holds under a run's namespace, reduced to the facts §5.3
 * decides on.
 *
 * A shape rather than a `GitWorkspaces` because the decision is pure: given
 * these four values the answer is fixed, which is what makes A, B, C and both
 * failures of D testable without a repository (§26.2).
 */
export interface NamespaceShape {
  /** The run's recorded integration head, absent until the namespace is initialised. */
  readonly integrationHead: string | undefined;
  /** The commit this run was planned against. */
  readonly planningBase: string | undefined;
  /** The integration branch's current commit, absent when the branch does not exist. */
  readonly integrationBranch: string | undefined;
  /** Refs under the namespace that are **not** the integration branch. */
  readonly otherRefs: readonly string[];
}

export type NamespaceDecision =
  /** Case A — the namespace is empty and initialisation may proceed. */
  | { readonly kind: 'initialise' }
  /** Case B — this run's own branch, created moments before a crash. */
  | { readonly kind: 'adopt' }
  /** Case D — a resume onto a namespace that is still this run's. */
  | { readonly kind: 'resume' }
  | { readonly kind: 'refuse'; readonly code: WorktreeRefusalCode; readonly detail: string };

/**
 * §5.3's four states, three of which look alike on disk.
 *
 * The discriminator is `integrationHead` and **not** `events.jsonl` — a decision
 * input read from the audit trail would make the audit trail a second source of
 * truth, which I-1 forbids. It is not `isolationMode` either, which is present
 * from the run's first moment and says nothing about whether a ref exists.
 *
 * The window this exists to survive: **creating the branch and writing the state
 * are two operations, and a crash fits between them.** A field meaning "I
 * created the namespace" would be absent in exactly the case where the namespace
 * exists, so a resume would find the run's own integration branch and refuse it
 * as a collision with itself. Case B is what makes that a recoverable state
 * rather than a permanent refusal.
 *
 * Pure on purpose. Everything above it does I/O; this does not, so every branch
 * is reachable in a unit test and the one that matters — B not being C — cannot
 * be left to an integration test that happens to construct the right repository.
 */
export function decideNamespace(shape: NamespaceShape): NamespaceDecision {
  if (shape.integrationHead === undefined) {
    // A — nothing under the namespace at all.
    if (shape.integrationBranch === undefined && shape.otherRefs.length === 0) {
      return { kind: 'initialise' };
    }

    // C — an attempt ref is work this run did not record, whatever else is true.
    if (shape.otherRefs.length > 0) {
      return {
        kind: 'refuse',
        code: 'git_run_key_collision',
        detail:
          `the namespace holds ${String(shape.otherRefs.length)} ref(s) this run did not create: ` +
          shape.otherRefs.slice(0, 3).join(', '),
      };
    }

    // B — the integration branch alone, at exactly `planningBase`. Every
    // distinguishing fact matches what initialisation would have produced, and
    // nothing matches what a *different* run would have left: a different run
    // that got anywhere would have moved the branch or created an attempt ref.
    if (shape.integrationBranch === shape.planningBase && shape.planningBase !== undefined) {
      return { kind: 'adopt' };
    }

    // C — the branch exists at a commit nobody planned against. That is work,
    // or wreckage, and either way it is not this run's initialisation.
    return {
      kind: 'refuse',
      code: 'git_run_key_collision',
      detail:
        'the namespace holds an integration branch at a commit this run was not planned against',
    };
  }

  // D — a resume. The branch must exist, and the recorded head must be part of
  // it. Neither failure is repairable.
  if (shape.integrationBranch === undefined) {
    return {
      kind: 'refuse',
      code: 'namespace_missing',
      detail:
        'this run recorded integrated work and its integration branch is gone from the repository',
    };
  }

  return { kind: 'resume' };
}

// ---------------------------------------------------------------------------
// Reporting (§6.2, §21.4)
// ---------------------------------------------------------------------------

/**
 * How a run's frozen mode compares to the configuration in front of the user.
 *
 * §21.4 requires both `status` and `run --dry-run` to say this in words. The
 * surprise it names — *my configuration says one thing and this run does
 * another* — is a fact when the tool explains it and a bug report when it does
 * not.
 */
export interface IsolationReport {
  /** Absent on a legacy run, which predates the question entirely (§25.2). */
  readonly runMode: IsolationMode | undefined;
  readonly configuredWorktrees: boolean;
  readonly agrees: boolean;
  /** One line, or none when there is nothing surprising to say. */
  readonly note: string | undefined;
}

export function describeIsolation(state: RunState, config: EffectiveConfig): IsolationReport {
  const configured = config.global.git.useWorktrees;
  const runMode = state.isolationMode;

  if (runMode === undefined) {
    return {
      runMode: undefined,
      configuredWorktrees: configured,
      agrees: !configured,
      note: configured
        ? 'this run predates workspace isolation — start a new run to use it'
        : undefined,
    };
  }

  const agrees = (runMode === 'worktree') === configured;

  return {
    runMode,
    configuredWorktrees: configured,
    agrees,
    note: agrees
      ? undefined
      : `this run was created in ${runMode} mode; your configuration now says useWorktrees: ${String(
          configured,
        )} — it does not apply to this run`,
  };
}
