import {
  TaskAttemptResultSchema,
  type TaskAttemptResult,
} from '../contracts/index.js';
import type { GitIdentity } from '../adapters/git/git-command.js';
import type { GitWorkspaces } from '../adapters/git/git-workspaces.js';
import type { Clock, FileSystem, Host } from '../ports/index.js';
import { runPaths } from './paths.js';

/**
 * The evidence one attempt leaves behind, and the marker bound to it (§11, §12).
 *
 * This module owns four things and deliberately nothing else: capturing the
 * validated tree, minting the receipt, writing the immutable attempt artifact,
 * and publishing the marker ref. It does not know which task is ready, whether a
 * wave is finished, when a retry is allowed, how integration proceeds or what
 * recovery does with any of it. The shape to watch for in review is a function
 * here that takes a plan, a scheduler decision or an integration branch.
 *
 * **The ordering below is the whole security property, not an implementation
 * detail** (§11.2):
 *
 * ```text
 * agent process exits                    ← nothing below can start earlier
 *         ↓
 * validation commands run                (the executor, before it calls in here)
 *         ↓
 * judgeValidation(...) === satisfied
 *         ↓
 * git add -A                             stage everything in the worktree
 * git write-tree                       → validatedTree
 * receiptNonce = 128 random bits         ← the nonce first exists HERE
 *         ↓
 * write attempt-<n>.json atomically      ← THE authority
 *         ↓
 * commit-tree <tree> -p <base>           built from the persisted artifact
 * update-ref <attemptRef> <marker>
 * ```
 *
 * The nonce is generated after the agent's process is gone, so there is no moment
 * at which a running agent could read, guess or copy it. The tree is captured
 * after validation ran, so what is recorded is the tree the commands actually
 * ran against. And every input to `commit-tree` is read back out of the persisted
 * artifact rather than held in memory, which is what makes re-running it after a
 * crash produce the *same* commit id (§12.2) — the property recovery's windows 3
 * and 4 rest on, and the reason `update-ref` needs no bookkeeping to be
 * idempotent.
 *
 * What the receipt does **not** buy is stated in §11.3 and in `docs/security.md`:
 * an agent that escapes its worktree and writes into `.agent-flow/runs/` can
 * fabricate both halves. Containment remains the runner's job.
 */

/**
 * Author and committer of every marker, fixed (§12.2).
 *
 * Not the user's `user.name`/`user.email`, because a marker is a machine-made
 * snapshot and attributing it to a person is a statement that is not true. It is
 * passed as `-c user.name=…` on the invocation; **Agent Flow never writes to
 * `git config`** (I-7). The environment's `GIT_AUTHOR_*` and `GIT_COMMITTER_*`
 * outrank those flags and are therefore removed at the Git boundary — see
 * `GIT_HOSTILE_ENVIRONMENT`.
 */
export const MARKER_IDENTITY: GitIdentity = { name: 'Agent Flow', email: 'agent-flow@local' };

/** 128 bits, as §10.2 requires — sixteen bytes, thirty-two hex characters. */
const RECEIPT_NONCE_BYTES = 16;

/**
 * Why evidence could not be produced.
 *
 * Deliberately not the run-level refusal vocabulary of Appendix A: those codes
 * stop a run and are reported to a person as a repository state they can act on.
 * These are failures of this module's own sequence, and the caller decides what
 * they mean for the task.
 */
export const ATTEMPT_EVIDENCE_FAILURES = [
  /** `git add -A` or `git write-tree` did not produce a tree. */
  'validated_tree_uncapturable',
  /** An `attempt-<n>.json` is already there. Never overwritten (§11.3). */
  'attempt_artifact_exists',
  /** The filesystem refused the write — no space, no permission, no directory. */
  'attempt_artifact_unwritable',
  /** Written, and then did not read back as a valid artifact. */
  'attempt_artifact_unreadable',
  /** `commit-tree` or `update-ref` failed. */
  'attempt_marker_unpublishable',
] as const;

export type AttemptEvidenceFailureCode = (typeof ATTEMPT_EVIDENCE_FAILURES)[number];

export interface AttemptEvidenceFailure {
  readonly code: AttemptEvidenceFailureCode;
  /**
   * What went wrong, for a person — and **path-free by construction** (§7.2,
   * §21.3).
   *
   * Assembled from a stable Git error code and the module's own vocabulary, never
   * from Git's stderr: a failed `write-tree` names the absolute worktree it ran
   * in, and this sentence reaches a note on a task result.
   */
  readonly detail: string;
}

/**
 * Everything an attempt is, except the one field only this module may add.
 *
 * `acceptance` is optional on the draft even though the artifact always carries it. The
 * schema defaults it to `[]` and this module parses before writing, so an omitted map
 * becomes an empty one — which is the honest record for a milestone that does not yet
 * compute acceptance evidence (C-15 is AR-05a's). Requiring it here would force the
 * caller to fabricate a map now, and a fabricated `[]` and a computed `[]` are
 * indistinguishable on disk.
 */
export type AttemptDraft = Omit<TaskAttemptResult, 'receipt' | 'acceptance'> &
  Partial<Pick<TaskAttemptResult, 'acceptance'>>;

/** The marker, once it exists in the repository. */
export interface AttemptMarker {
  /** The commit `commit-tree` produced. */
  readonly oid: string;
  /** Full ref name, as `update-ref` was given it. */
  readonly ref: string;
  /** `receipt.validatedTree`, repeated so a caller need not reach back in. */
  readonly tree: string;
}

export interface AttemptEvidence {
  /** Exactly what was persisted — read back from disk, not what was assembled. */
  readonly attempt: TaskAttemptResult;
  /** Present if and only if the judgement was `satisfied`. */
  readonly marker?: AttemptMarker;
}

export type AttemptEvidenceOutcome =
  | { readonly ok: true; readonly value: AttemptEvidence }
  | { readonly ok: false; readonly failure: AttemptEvidenceFailure };

export interface AttemptEvidenceDeps {
  readonly workspaces: GitWorkspaces;
  readonly fs: FileSystem;
  /** Stamps `receipt.issuedAt`, which is also both of the marker's dates. */
  readonly clock: Clock;
  /** For `randomHex` alone: the nonce must come from a cryptographic source. */
  readonly host: Host;
  /** Where the run's artifacts live. Outside every worktree, by construction. */
  readonly projectDir: string;
}

export interface RecordAttemptRequest {
  readonly draft: AttemptDraft;
  /**
   * Absolute path of the attempt's worktree. Used for `add -A` and `write-tree`
   * and for nothing else — it is never persisted, and the artifact records
   * `draft.workspace`, which is workspace-relative (§7.2).
   */
  readonly workspacePath: string;
  /**
   * The run's Git namespace, for the `Agent-Flow-Run-Key` trailer.
   *
   * Not carried in the artifact, because `branch` already contains it and §7.2
   * has no room for a second copy of one fact. It is read from run state, which
   * is frozen at creation (I-13), so it cannot drift between the write and a
   * later reconstruction of the same marker.
   */
  readonly gitRunKey: string;
}

/**
 * Runs the §11.2 sequence for one attempt.
 *
 * An unsatisfied or unreached attempt gets an artifact and stops there: **no
 * nonce is generated, no tree is captured and no marker is created**. That is not
 * an optimisation — a receipt is a claim that validation passed over a specific
 * tree, and there is no such tree to point at.
 */
export async function recordAttempt(
  deps: AttemptEvidenceDeps,
  request: RecordAttemptRequest,
): Promise<AttemptEvidenceOutcome> {
  const { draft } = request;

  if (draft.validationJudgement !== 'satisfied') {
    const written = await writeAttemptArtifact(deps, draft);
    return written.ok ? { ok: true, value: { attempt: written.value } } : written;
  }

  // §11.2, in order. `stageAll` and `writeTree` are two calls rather than one
  // convenience method because they have different failure modes, and hiding the
  // mutation inside the read would make only one of them reportable.
  const staged = await deps.workspaces.stageAll({ cwd: request.workspacePath });
  if (!staged.ok) {
    return failure(
      'validated_tree_uncapturable',
      `the attempt's changes could not be staged (${staged.failure.code})`,
    );
  }

  const tree = await deps.workspaces.writeTree({ cwd: request.workspacePath });
  if (!tree.ok) {
    return failure(
      'validated_tree_uncapturable',
      `the validated tree could not be written (${tree.failure.code})`,
    );
  }

  // The nonce first exists here: after the agent exited, after validation ran,
  // after the tree was captured. Generating it any earlier — even one line up,
  // "to keep the happy path tidy" — is the whole threat model undone, because a
  // value that exists while the agent is alive is a value the agent may have.
  const written = await writeAttemptArtifact(deps, {
    ...draft,
    receipt: {
      nonce: deps.host.randomHex(RECEIPT_NONCE_BYTES),
      validatedTree: tree.value,
      issuedAt: deps.clock.now(),
    },
  });
  if (!written.ok) return written;

  // Built from what is on disk, never from what is in this scope. The two agree
  // today; the point is that the *reconstruction* after a crash has only the disk
  // to work from, and a marker whose inputs came from memory would be a marker
  // that could not be recreated.
  const marker = await publishMarker(deps, written.value, request.gitRunKey);
  if (!marker.ok) return marker;

  return { ok: true, value: { attempt: written.value, marker: marker.value } };
}

/**
 * `commit-tree` then `update-ref`, from a persisted artifact (§12.1).
 *
 * Exported because it is the operation whose determinism is the guarantee: given
 * the same artifact and the same namespace, this produces the same commit id,
 * Git stores it once, and running it again is free. A test proves that against
 * real Git, and recovery (M2-07) re-runs exactly this for windows 3 and 4.
 *
 * **Never `git commit`, never `git branch`, never `--allow-empty`** (§12.1). The
 * first reads a checked-out index and runs hooks; the second has working-tree
 * implications where a single reference transaction is wanted; the third answers
 * a question `commit-tree` does not ask — a marker whose tree equals its base is
 * a legitimate commit and a real outcome.
 */
export async function publishMarker(
  deps: AttemptEvidenceDeps,
  attempt: TaskAttemptResult,
  gitRunKey: string,
): Promise<
  | { readonly ok: true; readonly value: AttemptMarker }
  | { readonly ok: false; readonly failure: AttemptEvidenceFailure }
> {
  const receipt = attempt.receipt;
  if (receipt === undefined) {
    // Unreachable while the schema's `.refine` holds — a satisfied artifact
    // without a receipt does not parse — and checked anyway, because the
    // alternative is composing a marker message with `undefined` in it.
    return failure(
      'attempt_marker_unpublishable',
      'the persisted attempt carries no receipt, so there is no validated tree to mark',
    );
  }

  // Both dates from the artifact, and deliberately not from "now". This is what
  // closes the "crashed after commit-tree, before update-ref" window at no cost:
  // the second run produces the same object id, so the ref update is idempotent
  // without anything having recorded that the first run got that far (§17.4).
  const marker = await deps.workspaces.commitTree({
    cwd: deps.projectDir,
    tree: receipt.validatedTree,
    // One parent, and it is the attempt's base — never the commits the coding
    // agent made inside the worktree (§12.5). The marker is a logical squash of
    // the validated tree onto that base, so what reaches the integration branch
    // is the state that was actually validated rather than a sequence of
    // intermediate states no test ever saw.
    parents: [attempt.base],
    message: markerMessage(attempt, gitRunKey),
    identity: MARKER_IDENTITY,
    dates: { author: receipt.issuedAt, committer: receipt.issuedAt },
  });
  if (!marker.ok) {
    return failure(
      'attempt_marker_unpublishable',
      `the marker commit could not be created (${marker.failure.code})`,
    );
  }

  const ref = `refs/heads/${attempt.branch}`;
  // No compare-and-swap: the branch was created with the worktree (§7.3) and the
  // coding agent may have moved it, so there is no prior value this code knows.
  // That costs nothing — the authority is the artifact, and recovery re-checks
  // the tree binding and the nonce before believing any ref (§17.1).
  const published = await deps.workspaces.updateRef({
    cwd: deps.projectDir,
    ref,
    newOid: marker.value,
  });
  if (!published.ok) {
    return failure(
      'attempt_marker_unpublishable',
      `the attempt branch could not be pointed at the marker (${published.failure.code})`,
    );
  }

  return { ok: true, value: { oid: marker.value, ref, tree: receipt.validatedTree } };
}

/**
 * §12.4's message, verbatim in shape.
 *
 * **The trailers are for humans and for `git log`. They are never the
 * authority.** Recovery reads the artifact first and uses them only to confirm
 * it (§17.1) — a marker whose trailers are perfect and whose tree does not match
 * the receipt is refused. They are here because a person running `git log` on the
 * integration branch deserves to know what each commit is, and because a commit
 * that explains itself is one nobody has to guess about.
 *
 * Object ids are written in full. An abbreviation is unique only in the
 * repository that produced it and only until that repository grows a second
 * object sharing the prefix (§33).
 */
export function markerMessage(attempt: TaskAttemptResult, gitRunKey: string): string {
  const receipt = attempt.receipt;
  const attemptNumber = String(attempt.attempt);

  const trailers = [
    ['Agent-Flow-Run', attempt.run],
    ['Agent-Flow-Run-Key', gitRunKey],
    ['Agent-Flow-Task', attempt.task],
    ['Agent-Flow-Attempt', attemptNumber],
    ['Agent-Flow-Base', attempt.base],
    ['Agent-Flow-Tree', receipt?.validatedTree ?? ''],
    ['Agent-Flow-Receipt', receipt?.nonce ?? ''],
    ['Agent-Flow-Validation', attempt.validationJudgement],
    ['Agent-Flow-Validation-Expectation', attempt.validation.expectation],
    // Comma-separated, no spaces: this is read by machines that already have the
    // artifact, and a list a shell would re-split is a list somebody eventually
    // re-splits wrongly.
    ['Agent-Flow-Validation-Ids', attempt.validation.ids.join(',')],
  ] as const;

  return [
    `agent-flow: ${attempt.task} attempt ${attemptNumber}`,
    '',
    `Validated tree for ${attempt.task}, attempt ${attemptNumber}, of run ${attempt.run}.`,
    '',
    'Created by Agent Flow from the tree that its validation commands ran against.',
    "This is a snapshot of that tree onto its base, not the coding agent's commit history.",
    '',
    ...trailers.map(([name, value]) => `${name}: ${value}`),
  ].join('\n');
}

/**
 * Writes `attempt-<n>.json` once, and refuses to write it twice (§11.3).
 *
 * **A second write is a refusal, not an overwrite, and not an "idempotent" write
 * of identical content.** Recovery decides what happened to an attempt by reading
 * this file, so the first evidence has to be the only evidence: a path that
 * rewrote it — even with bytes that look the same — is a path that can replace a
 * receipt, and the whole binding of artifact → nonce + tree → marker rests on it
 * not existing.
 *
 * `writeFileAtomic` rather than `createExclusive`, and the difference is which
 * failure each prevents. `createExclusive` settles a race between two processes
 * in the kernel; there is no such race here, because every writer holds the run
 * execution lease (§18.2). What can happen is a crash mid-write, and a
 * half-written artifact read back later would be evidence of something that did
 * not happen — which is exactly what temp-file-and-rename prevents.
 */
async function writeAttemptArtifact(
  deps: AttemptEvidenceDeps,
  // The schema's *input* shape, not its output: this function's first act is to parse,
  // so it must accept what a caller can honestly build — a draft whose defaulted members
  // are absent — and the parsed value is what everything below it reads.
  attempt: AttemptDraft & { readonly receipt?: TaskAttemptResult['receipt'] },
): Promise<
  | { readonly ok: true; readonly value: TaskAttemptResult }
  | { readonly ok: false; readonly failure: AttemptEvidenceFailure }
> {
  const parsed = TaskAttemptResultSchema.safeParse(attempt);
  if (!parsed.success) {
    // The `.refine` of §10.2 lives here as a runtime gate too: a half-forged
    // shape — a receipt with an unsatisfied judgement, or the reverse — never
    // reaches the disk.
    return failure(
      'attempt_artifact_unreadable',
      `the attempt evidence does not satisfy its contract (${parsed.error.issues.length} problem(s))`,
    );
  }

  const path = attemptPath(deps, parsed.data);

  if (await deps.fs.exists(path)) {
    return failure(
      'attempt_artifact_exists',
      `attempt ${String(parsed.data.attempt)} of ${parsed.data.task} already has evidence, ` +
        'and evidence is never rewritten',
    );
  }

  // Caught rather than allowed to propagate, and that is not defensive habit.
  // A throw from here would leave the §11.2 sequence with no return value at
  // all: it would unwind past the caller's judgement, out of the wave's
  // dispatch, and the run would fail on a stack trace instead of on a task that
  // says what happened to it. A full disk is an ordinary Tuesday, and the honest
  // report is "the evidence could not be written", which is what this is.
  try {
    await deps.fs.mkdirp(path.slice(0, path.lastIndexOf('/')));
    await deps.fs.writeFileAtomic(path, `${JSON.stringify(parsed.data, null, 2)}\n`);
  } catch {
    // The message is dropped on purpose: a filesystem error names the path it
    // failed on, and that path is the one thing §7.2 keeps out of a note.
    return failure(
      'attempt_artifact_unwritable',
      `the evidence for attempt ${String(parsed.data.attempt)} of ${parsed.data.task} ` +
        'could not be written',
    );
  }

  // Read back rather than returned from memory. Everything downstream — the
  // marker's tree, its parent, its dates, its trailers — is then a function of
  // what a later process would find on disk, which is the property §12.2 needs
  // and the one an in-memory hand-off would quietly not have.
  const persisted = await readAttempt(deps, parsed.data.run, parsed.data.task, parsed.data.attempt);
  if (persisted === null) {
    return failure(
      'attempt_artifact_unreadable',
      `the evidence written for attempt ${String(parsed.data.attempt)} of ${parsed.data.task} ` +
        'did not read back as a valid artifact',
    );
  }

  return { ok: true, value: persisted };
}

/**
 * The persisted attempt, or `null` when there is none that parses.
 *
 * `null` covers both "no file" and "a file this contract rejects", and the two
 * are collapsed on purpose: neither is evidence. An artifact that does not parse
 * is not a weaker form of evidence to be repaired — it is a file nothing wrote
 * correctly, and treating it as partial truth is how a forged half gets believed.
 */
export async function readAttempt(
  deps: Pick<AttemptEvidenceDeps, 'fs' | 'projectDir'>,
  run: string,
  task: string,
  attempt: number,
): Promise<TaskAttemptResult | null> {
  const path = runPaths(deps.projectDir, run).taskAttempt(task, attempt);
  if (!(await deps.fs.exists(path))) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(await deps.fs.readFile(path));
  } catch {
    return null;
  }

  const parsed = TaskAttemptResultSchema.safeParse(raw);
  if (!parsed.success) return null;

  // The artifact has to be the one this path names. `run`, `task` and `attempt`
  // are recorded *inside* the file as well as encoded in its location, and the
  // schema can only check that each is well-formed — not that the two agree.
  //
  // Every caller treats what comes back as evidence about the attempt it asked
  // for: the Integrator composes the expected marker trailers from these three
  // fields, and recovery re-derives the attempt ref from them. An artifact
  // describing a different attempt would therefore be checked against the wrong
  // marker, and a mismatch there reads as corruption rather than as a file in
  // the wrong place. Refusing here says which of the two it is, and costs a
  // comparison.
  const self = parsed.data;
  if (self.run !== run || self.task !== task || self.attempt !== attempt) return null;

  return self;
}

function attemptPath(deps: Pick<AttemptEvidenceDeps, 'projectDir'>, attempt: TaskAttemptResult): string {
  return runPaths(deps.projectDir, attempt.run).taskAttempt(attempt.task, attempt.attempt);
}

function failure(
  code: AttemptEvidenceFailureCode,
  detail: string,
): { readonly ok: false; readonly failure: AttemptEvidenceFailure } {
  return { ok: false, failure: { code, detail } };
}
