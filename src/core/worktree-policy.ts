import { AnyTaskIdSchema, GitRunKeySchema, RunIdSchema } from '../contracts/common.schema.js';

/**
 * Every naming and layout decision of MVP 2, as pure functions (§5, §7, work item
 * M2-01).
 *
 * This module decides *what things are called*. It never finds anything out: no
 * filesystem, no Git, no configuration, no home directory, no clock, no
 * randomness. That is not tidiness — it is the reason the answers can be tested
 * exhaustively against traversal and injection payloads without a repository, and
 * the reason there is exactly one place to read when asking why a ref is named
 * what it is.
 *
 * Two boundaries are drawn deliberately, and both look like something is missing:
 *
 *   - **The digest arrives as an argument.** `repoKey` is defined over
 *     `sha256(canonicalRoot)`, and hashing is I/O-adjacent work belonging to the
 *     layer that already resolved the path. Importing a hash implementation here
 *     would put a Node built-in in the core to save one parameter.
 *   - **Randomness arrives as an argument.** `gitRunKey` carries 64 bits from a
 *     cryptographic source (§5.2). A pure function cannot generate them, and one
 *     that reached for `Math.random` would produce a key that looks unpredictable
 *     and is not.
 *
 * Nothing here computes an isolation mode either. That is captured once, when the
 * run is created, and handed to this layer — never derived by it (I-13).
 */

/** Why a policy question could not be answered. Names the input, not the caller. */
export const WORKTREE_POLICY_REFUSALS = [
  'invalid_canonical_root',
  'invalid_repo_digest',
  'invalid_repo_key',
  'invalid_run_id',
  'invalid_run_entropy',
  'invalid_git_run_key',
  'invalid_task_id',
  'invalid_attempt',
  /**
   * A validated component still produced an unsafe segment.
   *
   * Unreachable while the validators above hold, and kept anyway: it is what turns
   * "the schema makes this impossible" into something the code checks rather than
   * something a reader has to re-derive after the next change to a schema this
   * module does not own.
   */
  'unsafe_component',
] as const;

export type WorktreePolicyRefusalCode = (typeof WORKTREE_POLICY_REFUSALS)[number];

export interface WorktreePolicyRefusal {
  readonly code: WorktreePolicyRefusalCode;
  /** What was wrong, in the words the caller will put in front of a person. */
  readonly reason: string;
}

/**
 * A refusal is a value, never an exception (M2-01, *Failure semantics*).
 *
 * Every input this module rejects is input a plan, a state file or a stale
 * namespace can legally contain, so rejection is an expected outcome. Throwing
 * would push the decision into a `catch` block, where the difference between
 * "this task id cannot be a path" and "this code has a bug" disappears.
 */
export type PolicyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: WorktreePolicyRefusal };

/** The ref prefix every branch this milestone creates lives under (§5.3). */
export const REF_NAMESPACE = 'agent-flow';

/** §5.1. The slug is for humans; only the hash carries identity. */
export const REPO_SLUG_MAX_LENGTH = 24;
export const REPO_KEY_HASH_LENGTH = 12;
const REPO_SLUG_FALLBACK = 'repo';

/**
 * The shape `repoKey` is produced in, re-asserted whenever one arrives as input.
 *
 * A key composed here is safe by construction; a key handed to
 * {@link attemptWorkspace} came from somewhere else, and "somewhere else" is where
 * a path component stops being trustworthy.
 */
const REPO_KEY_PATTERN = new RegExp(
  `^[a-z0-9](?:[a-z0-9-]{0,${String(REPO_SLUG_MAX_LENGTH - 2)}}[a-z0-9])?` +
    `-[0-9a-f]{${String(REPO_KEY_HASH_LENGTH)}}$`,
);

const SHA256_HEX = /^[0-9a-f]{64}$/;
const RUN_ENTROPY_HEX = /^[0-9a-f]{16}$/;

function ok<T>(value: T): PolicyResult<T> {
  return { ok: true, value };
}

function refuse<T>(code: WorktreePolicyRefusalCode, reason: string): PolicyResult<T> {
  return { ok: false, refusal: { code, reason } };
}

// ---------------------------------------------------------------------------
// Repository identity (§5.1)
// ---------------------------------------------------------------------------

/**
 * The last non-empty segment of a path, judged on both separators.
 *
 * Not `node:path.basename`: the core holds no Node built-in, and this is not path
 * *assembly* — it is reading a human-readable name out of a string in order to
 * throw almost all of it away. Both separators are honoured because the value may
 * have been produced on Windows, and getting it wrong costs a nicer directory name
 * and nothing else: identity lives in the hash, and every character the slug keeps
 * has already survived `[^a-z0-9]`.
 */
function basenameOf(canonicalRoot: string): string {
  return canonicalRoot.split(/[/\\]/).filter((segment) => segment.length > 0).at(-1) ?? '';
}

/** §5.1: lowercased, non-alphanumerics collapsed to `-`, trimmed, capped, never empty. */
function slugOf(basename: string): string {
  const trimmed = basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, REPO_SLUG_MAX_LENGTH)
    // Truncation can land mid-separator, so the trim happens on both sides of it.
    .replace(/-+$/, '');

  return trimmed.length === 0 ? REPO_SLUG_FALLBACK : trimmed;
}

/**
 * Identifies a repository *on this machine* — local identity, not distributed
 * identity. Two clones of one upstream are two repositories and get two keys.
 *
 * @param canonicalRoot the realpath of the parent of the repository's common
 *   directory, resolved by the caller. Hashed verbatim, never case-folded (§5.1).
 * @param canonicalRootSha256 `sha256(canonicalRoot)` as 64 lowercase hex
 *   characters. Supplied rather than computed — see the module note.
 */
export function repoKeyFromCanonicalRoot(
  canonicalRoot: string,
  canonicalRootSha256: string,
): PolicyResult<string> {
  if (canonicalRoot.trim().length === 0) {
    return refuse('invalid_canonical_root', 'the repository root is empty');
  }
  if (!SHA256_HEX.test(canonicalRootSha256)) {
    return refuse(
      'invalid_repo_digest',
      'expected a 64-character lowercase hex SHA-256 of the repository root',
    );
  }

  const hash = canonicalRootSha256.slice(0, REPO_KEY_HASH_LENGTH);
  return ok(`${slugOf(basenameOf(canonicalRoot))}-${hash}`);
}

// ---------------------------------------------------------------------------
// Run identity (§5.2)
// ---------------------------------------------------------------------------

/**
 * Composes a run's Git namespace key from its id and 64 bits of entropy.
 *
 * The entropy is validated rather than trusted: 16 lowercase hex characters and
 * nothing else. A caller passing a short, uppercase or non-hex string would
 * otherwise produce a key that fails `GitRunKeySchema` later, at the point where it
 * is already inside a ref name.
 */
export function makeGitRunKey(runId: string, entropyHex16: string): PolicyResult<string> {
  if (!RunIdSchema.safeParse(runId).success) {
    return refuse('invalid_run_id', `expected a run id of the form AF-YYYY-NNN, got "${runId}"`);
  }
  if (!RUN_ENTROPY_HEX.test(entropyHex16)) {
    return refuse('invalid_run_entropy', 'expected 16 lowercase hex characters of entropy');
  }

  const composed = `${runId}-${entropyHex16}`;
  // Both halves are validated above, so this can only fail if the two schemas ever
  // stop agreeing with each other — which is exactly when we want to hear about it.
  if (!GitRunKeySchema.safeParse(composed).success) {
    return refuse('invalid_git_run_key', `composed a key the contract rejects: "${composed}"`);
  }

  return ok(composed);
}

/**
 * §5.2's invariant: a run's Git namespace begins with the run's own id.
 *
 * Checked when a run enters worktree mode. A mismatch means the state file pairs a
 * run with somebody else's namespace, which is a refusal and never a repair.
 */
export function gitRunKeyBelongsToRun(gitRunKey: string, runId: string): boolean {
  if (!GitRunKeySchema.safeParse(gitRunKey).success) return false;
  if (!RunIdSchema.safeParse(runId).success) return false;
  return gitRunKey.startsWith(`${runId}-`);
}

// ---------------------------------------------------------------------------
// Component validation (§22, S-1 and S-2)
// ---------------------------------------------------------------------------

function validGitRunKey(gitRunKey: string): WorktreePolicyRefusal | null {
  return GitRunKeySchema.safeParse(gitRunKey).success
    ? null
    : {
        code: 'invalid_git_run_key',
        reason: 'expected a run namespace of the form AF-YYYY-NNN-<16 lowercase hex>',
      };
}

function validRepoKey(repoKey: string): WorktreePolicyRefusal | null {
  return REPO_KEY_PATTERN.test(repoKey)
    ? null
    : {
        code: 'invalid_repo_key',
        reason: 'expected a repository key of the form <slug>-<12 lowercase hex>',
      };
}

/**
 * Re-validates a task id before it becomes a path or ref component (S-1).
 *
 * `AnyTaskIdSchema` is the plan's own contract — `TASK-000` or `FIX-000`, nothing
 * else — and it is deliberately reused rather than paraphrased. §22 describes the
 * defence as a `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` re-check; the contract that
 * already exists is a strict subset of that, so re-checking against it is the
 * stronger of the two. A second, slightly different regex here would be a second
 * answer to "what is a task id", and one of the two would eventually be the one
 * nobody updated.
 *
 * The re-check happens even though the plan was parsed on the way in, because "the
 * caller validated it" is not a property this module can see.
 */
function validTaskId(taskId: string): WorktreePolicyRefusal | null {
  return AnyTaskIdSchema.safeParse(taskId).success
    ? null
    : { code: 'invalid_task_id', reason: `expected TASK-000 or FIX-000, got "${taskId}"` };
}

function validAttempt(attempt: number): WorktreePolicyRefusal | null {
  return Number.isSafeInteger(attempt) && attempt >= 1
    ? null
    : {
        code: 'invalid_attempt',
        reason: `expected an attempt number of 1 or more, got ${String(attempt)}`,
      };
}

/**
 * The last gate before components become a ref or a path.
 *
 * Written as an allowlist, which is the whole point: a denylist of separators,
 * dot-dot, `@{`, spaces and leading dashes is a list somebody has to keep
 * complete, and the entry nobody thought of is the one that gets used. The pattern
 * is §22's own `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, plus the two sequences Git
 * refuses inside a ref component.
 *
 * Every component reaching here has already passed a schema, so it never fires in
 * practice. It exists because those schemas belong to other modules: the day one of
 * them widens, the failure should be a refusal here rather than a segment called
 * dot-dot arriving in a directory name.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REF_HOSTILE_SEGMENT = /\.\.|\.lock$|\.$/;

function validSegments(segments: readonly string[]): WorktreePolicyRefusal | null {
  for (const segment of segments) {
    if (!SAFE_SEGMENT.test(segment) || REF_HOSTILE_SEGMENT.test(segment)) {
      return {
        code: 'unsafe_component',
        reason: `"${segment}" cannot be used as a ref or path component`,
      };
    }
  }
  return null;
}

function firstRefusal(
  ...checks: readonly (WorktreePolicyRefusal | null)[]
): WorktreePolicyRefusal | null {
  return checks.find((check) => check !== null) ?? null;
}

// ---------------------------------------------------------------------------
// Ref names (§5.3)
// ---------------------------------------------------------------------------

function composeRef(segments: readonly string[]): PolicyResult<string> {
  const unsafe = validSegments(segments);
  if (unsafe !== null) return { ok: false, refusal: unsafe };

  return ok(segments.join('/'));
}

/** `agent-flow/<gitRunKey>/integration` — the run's integration branch. */
export function integrationRef(gitRunKey: string): PolicyResult<string> {
  const refusal = validGitRunKey(gitRunKey);
  if (refusal !== null) return { ok: false, refusal };

  return composeRef([REF_NAMESPACE, gitRunKey, 'integration']);
}

/** `agent-flow/<gitRunKey>/<taskId>/attempt-<n>` — one attempt's branch. */
export function attemptRef(
  gitRunKey: string,
  taskId: string,
  attempt: number,
): PolicyResult<string> {
  const refusal = firstRefusal(
    validGitRunKey(gitRunKey),
    validTaskId(taskId),
    validAttempt(attempt),
  );
  if (refusal !== null) return { ok: false, refusal };

  return composeRef([REF_NAMESPACE, gitRunKey, taskId, `attempt-${String(attempt)}`]);
}

// ---------------------------------------------------------------------------
// Workspace locations (§7.1, §7.2)
// ---------------------------------------------------------------------------

/**
 * Where a workspace sits *relative to the worktree root*, and nothing more.
 *
 * There is no absolute path in this module and no function that returns one. The
 * root is a machine fact — the user's home directory, resolved by the `Host` port —
 * and an API here that appeared to produce an OS path would invite callers to treat
 * a policy answer as a filesystem answer.
 *
 * Two representations of one decision, because two callers need different things:
 * `segments` is what an adapter joins with `node:path`, which is the only way to
 * get a correct path on both platforms; `relativePath` is the POSIX-joined string
 * an attempt artifact records (§7.2), stable across the machines a run may later be
 * inspected from.
 */
export interface WorkspaceLocation {
  readonly segments: readonly string[];
  readonly relativePath: string;
}

function composeWorkspace(segments: readonly string[]): PolicyResult<WorkspaceLocation> {
  const unsafe = validSegments(segments);
  if (unsafe !== null) return { ok: false, refusal: unsafe };

  return ok({ segments, relativePath: segments.join('/') });
}

/** `<repoKey>/<gitRunKey>/integration`. */
export function integrationWorkspace(
  repoKey: string,
  gitRunKey: string,
): PolicyResult<WorkspaceLocation> {
  const refusal = firstRefusal(validRepoKey(repoKey), validGitRunKey(gitRunKey));
  if (refusal !== null) return { ok: false, refusal };

  return composeWorkspace([repoKey, gitRunKey, 'integration']);
}

/** `<repoKey>/<gitRunKey>/<taskId>/attempt-<n>`. */
export function attemptWorkspace(
  repoKey: string,
  gitRunKey: string,
  taskId: string,
  attempt: number,
): PolicyResult<WorkspaceLocation> {
  const refusal = firstRefusal(
    validRepoKey(repoKey),
    validGitRunKey(gitRunKey),
    validTaskId(taskId),
    validAttempt(attempt),
  );
  if (refusal !== null) return { ok: false, refusal };

  return composeWorkspace([repoKey, gitRunKey, taskId, `attempt-${String(attempt)}`]);
}
