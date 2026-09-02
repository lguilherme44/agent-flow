import nodePath from 'node:path';
import type { z } from 'zod';
import {
  AgentOutboxSchema,
  CollaborationAudienceSchema,
  type CollaborationAudience,
  AgentMessageSchema,
  BlackboardEntrySchema,
  type AgentId,
  type AgentMessage,
  type BlackboardEntry,
  type CollaborationConfig,
  type CollaborationRejection,
  type ProposedEntry,
  type ProposedMessage,
} from '../contracts/index.js';
import { isAtOrUnderRoot } from '../core/path-containment.js';
import { redactAndTruncate } from '../core/evidence-redaction.js';
import { admitEntry, admitMessage, admitOutboxSize } from '../core/collaboration/budgets.js';
import { allocateMessageIds, nextEntryId, nextThreadId } from '../core/collaboration/ids.js';
import type { AgentRoster } from '../core/collaboration/roster.js';
import type { FileSystem } from '../ports/index.js';
import { agentOutboxPath } from './paths.js';

/**
 * Reading what an agent left behind, and deciding what of it becomes the run's record.
 *
 * **This is where "models propose, Agent Flow decides" is implemented for speech.** An
 * implementation agent runs as a child process in a sandboxed worktree and Agent Flow
 * cannot intercept what it does — so the same ordering that makes a validation receipt
 * trustworthy makes a message trustworthy:
 *
 * ```text
 * the agent's process exits          ← nothing below can start earlier
 *         ↓
 * the outbox is read
 *         ↓
 * the outbox is removed              ← before any tree is captured (I-32)
 *         ↓
 * schema · redaction · budgets · re-keying
 *         ↓
 * appended to the log
 *         ↓
 * validation commands run            (unchanged)
 *         ↓
 * git add -A · git write-tree        (the tree never contained the outbox)
 * ```
 *
 * Five things an agent cannot do, each closed by construction rather than by a check:
 *
 * - **Forge a sender** (I-28). `ProposedMessageSchema` has no `from`, so a forged one is
 *   discarded by the parse. What this module adds is *noticing* — a defence that leaves
 *   no trace is a defence nobody can audit.
 * - **File against another task.** `taskId` is assigned from the dispatch.
 * - **Choose its own id.** Ids are allocated from the log.
 * - **Reach outside the workspace.** The outbox path is resolved and checked for
 *   containment, so a symlink pointing at `~/.ssh` is refused rather than read.
 * - **Exhaust the machine.** The size is checked against the file on disk *before* it is
 *   read: a schema cannot defend against a file it has already been handed.
 *
 * Pure decisions live in `core/collaboration/`; this module is the I/O around them.
 */

export interface HarvestRejection {
  readonly reason: CollaborationRejection;
  /** What was refused, for the event. Never the body — a rejection is not a channel. */
  readonly subject: string;
  readonly detail: string;
  /**
   * Which fields were wrong, in the schema's own vocabulary.
   *
   * **Absent from the first version, and the live evidence is why it exists.** Two agents
   * on two providers wrote an outbox in one run; all of it was refused as malformed, and
   * the event said only that. Nothing recorded *where* the shape went wrong, so the one
   * signal that the protocol is not landing carried nothing to act on — and the file is
   * deleted before the next process could look.
   *
   * Structure only: field paths come from our schema and codes from the validator, so
   * this stays a closed vocabulary. The "a rejection is not a channel" rule above is
   * about the *body*, and it still holds — no agent-authored text passes through here.
   */
  readonly diagnosis?: string;
}

export interface HarvestOutcome {
  readonly messages: readonly AgentMessage[];
  readonly entries: readonly BlackboardEntry[];
  readonly rejections: readonly HarvestRejection[];
  /** False when the agent left nothing. The ordinary case, and not a problem. */
  readonly found: boolean;
  /**
   * True when the whole file was refused before any item was considered — unparseable,
   * over budget, or somewhere the agent should not have been able to point it.
   */
  readonly refused: boolean;
  /**
   * True when the file tried to name its own sender.
   *
   * Recorded rather than acted on. The parse already discarded it, so this changes
   * nothing about what was written; what it changes is whether anybody can find out that
   * an agent attempted it.
   */
  readonly senderClaimed: boolean;
  /**
   * True when the outbox was removed from the workspace.
   *
   * **False is a real problem and is never silent** (I-32): a file left behind is a file
   * `git add -A` will stage into the validated tree, which puts agent-authored content
   * inside a marker's tree. It does not fail the task — the work is done, validated and
   * mergeable, and discarding it over a stray JSON file would be disproportionate — but
   * the caller records it and the diff will show it.
   */
  readonly removed: boolean;
}

export interface HarvestRequest {
  readonly runId: string;
  readonly taskId: string;
  /** Who is speaking — the agent this attempt was dispatched to. The only source of `from`. */
  readonly agentId: AgentId;
  /** Absolute path of the worktree, or of the project directory in sequential mode. */
  readonly workspaceDir: string;
  readonly roster: AgentRoster;
  readonly config: CollaborationConfig;
  /** Every message already in the run. Ids are allocated from these, and threads resolved. */
  readonly existingMessages: readonly AgentMessage[];
  readonly existingEntries: readonly BlackboardEntry[];
  readonly now: string;
  /** The machine's home directory, for redaction's second root (AD-35). */
  readonly homeDir?: string;
}

const NOTHING: HarvestOutcome = {
  messages: [],
  entries: [],
  rejections: [],
  found: false,
  refused: false,
  senderClaimed: false,
  removed: true,
};

export async function harvestOutbox(
  fs: FileSystem,
  request: HarvestRequest,
): Promise<HarvestOutcome> {
  const path = agentOutboxPath(request.workspaceDir);
  if (!(await fs.exists(path))) return NOTHING;

  // **Containment before content.** `exists` and `stat` both follow a symlink and report
  // an ordinary file, so an agent could point the outbox at anything the process can read
  // — a key, a credential file, another project's state. Resolving both ends and asking
  // `core/path-containment.ts` is the same defence the workspace registry uses, and using
  // the same one is the point: a second copy is a second chance to get it wrong.
  const contained = await withinWorkspace(fs, request.workspaceDir, path);
  if (!contained) {
    const removed = await remove(fs, path);
    return {
      ...NOTHING,
      found: true,
      refused: true,
      removed,
      rejections: [
        {
          reason: 'schema_invalid',
          subject: 'outbox',
          detail: 'the outbox resolved outside the workspace and was not read',
        },
      ],
    };
  }

  const stat = await fs.stat(path);
  const overSize = admitOutboxSize(request.config, stat?.size ?? 0);
  if (overSize !== undefined) {
    const removed = await remove(fs, path);
    return {
      ...NOTHING,
      found: true,
      refused: true,
      removed,
      rejections: [{ reason: overSize.rejection, subject: 'outbox', detail: overSize.action }],
    };
  }

  let raw: unknown;
  let senderClaimed = false;
  try {
    const text = await fs.readFile(path);
    raw = JSON.parse(text);
    senderClaimed = claimsASender(raw);
  } catch {
    const removed = await remove(fs, path);
    return {
      ...NOTHING,
      found: true,
      refused: true,
      removed,
      rejections: [
        {
          reason: 'schema_invalid',
          subject: 'outbox',
          // Deliberately says nothing about the content. A rejection that quoted the file
          // would make an unparseable outbox a channel for arbitrary text into the log.
          detail: 'the outbox was not valid JSON and none of it was read',
        },
      ],
    };
  }

  // Removed **before** anything is decided about the content, so no branch below can
  // return without the workspace being clean (I-32). Ordering rather than a `finally`,
  // because a `finally` that throws would mask the outcome it was meant to protect.
  const removed = await remove(fs, path);

  const parsed = AgentOutboxSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ...NOTHING,
      found: true,
      refused: true,
      removed,
      senderClaimed,
      rejections: [
        {
          reason: 'schema_invalid',
          subject: 'outbox',
          detail: 'the outbox did not match the expected shape and none of it was read',
          diagnosis: shapeDiagnosis(parsed.error),
        },
      ],
    };
  }

  const rejections: HarvestRejection[] = [];
  const messages = admitMessages(request, parsed.data.messages, rejections);
  const entries = admitEntries(request, parsed.data.entries, rejections);

  return { messages, entries, rejections, found: true, refused: false, senderClaimed, removed };
}

/**
 * Where the shape went wrong, in a vocabulary the agent does not control.
 *
 * Field names come from `AgentOutboxSchema` and codes from the validator, so nothing an
 * agent wrote can reach the log through here. A path segment is still sanitised: the
 * schema strips unknown keys today, but a later `.strict()` would start putting input
 * keys in the path, and this must not become the hole that opens.
 *
 * Capped at four issues. A file that is wrong in twenty places is wrong in one way, and
 * the first few say which.
 */
function shapeDiagnosis(error: z.ZodError): string {
  const seen = new Set<string>();
  for (const issue of error.issues) {
    if (seen.size >= 4) break;
    seen.add(`${issuePath(issue.path)}: ${issue.code}`);
  }
  return [...seen].join('; ');
}

function issuePath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return '(root)';
  return path
    .map((segment) => {
      if (typeof segment === 'number') return String(segment);
      const text = String(segment);
      return /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(text) ? text : '?';
    })
    .join('.');
}

/* ─── Messages ─────────────────────────────────────────────────────────────── */

function admitMessages(
  request: HarvestRequest,
  proposed: readonly ProposedMessage[],
  rejections: HarvestRejection[],
): AgentMessage[] {
  const known = new Set(request.existingMessages.map((message) => message.id));
  const threadOf = new Map(request.existingMessages.map((m) => [m.id, m.threadId]));
  const depths = countBy(request.existingMessages, (message) => message.threadId);

  let forTask = request.existingMessages.filter((m) => m.taskId === request.taskId).length;
  const ids = allocateMessageIds([...known], proposed.length);
  const threadIds = [...new Set(request.existingMessages.map((m) => m.threadId))];

  const admitted: AgentMessage[] = [];

  for (const [index, candidate] of proposed.entries()) {
    const recipient = resolveRecipient(request, candidate);
    if (recipient !== undefined) {
      rejections.push(recipient);
      continue;
    }

    // A reply to a message that does not exist opens its own thread rather than being
    // refused. The agent said something; losing it over a citation would be the wrong
    // trade, and a dangling `inReplyTo` is a mistake about provenance, not about content.
    const inherited = candidate.inReplyTo === undefined ? undefined : threadOf.get(candidate.inReplyTo);
    const danglingReply = candidate.inReplyTo !== undefined && inherited === undefined;
    const threadId = inherited ?? nextThreadId(threadIds);

    const refusal = admitMessage({
      config: request.config,
      alreadyForTask: forTask,
      ...(inherited === undefined ? {} : { threadDepth: depths.get(inherited) ?? 0 }),
    });
    if (refusal !== undefined) {
      rejections.push({
        reason: refusal.rejection,
        subject: candidate.subject,
        detail: refusal.action,
      });
      continue;
    }

    const { text, truncated } = redactAndTruncate(candidate.body, request.config.maxMessageBytes, {
      workspaceRoot: request.workspaceDir,
      ...(request.homeDir === undefined ? {} : { home: request.homeDir }),
    });

    const message = AgentMessageSchema.parse({
      id: ids[index],
      runId: request.runId,
      threadId,
      // The one assignment that makes I-28 true. Never `candidate.from` — there is no
      // such field, and if there ever is, an architecture test fails.
      from: request.agentId,
      to: candidate.to,
      type: candidate.type,
      taskId: request.taskId,
      ...(danglingReply || candidate.inReplyTo === undefined
        ? {}
        : { inReplyTo: candidate.inReplyTo }),
      subject: candidate.subject,
      body: text,
      references: candidate.references,
      truncated,
      createdAt: request.now,
    });

    admitted.push(message);
    forTask += 1;
    if (inherited === undefined) threadIds.push(threadId);
    depths.set(threadId, (depths.get(threadId) ?? 0) + 1);
  }

  return admitted;
}

/**
 * Whether the message can be delivered at all.
 *
 * An undeliverable message that looks sent is worse than one that visibly failed: the
 * sender waits for an answer nobody was asked for. So an unknown recipient is a refusal
 * with the attempted id named, rather than a message addressed to nobody.
 */
function resolveRecipient(
  request: HarvestRequest,
  candidate: ProposedMessage,
): HarvestRejection | undefined {
  if (candidate.to.kind !== 'agent') return undefined;
  if (request.roster.has(candidate.to.id)) return undefined;

  return {
    reason: 'unknown_recipient',
    subject: candidate.subject,
    detail: `no agent called "${candidate.to.id}" is configured on this run`,
  };
}

/* ─── Blackboard ───────────────────────────────────────────────────────────── */

/**
 * The audience values this product understands, and a count of the ones it did not.
 *
 * A count rather than the values themselves: a rejection is not a channel, and the same
 * rule that keeps a malformed message body out of the log keeps a malformed audience out
 * of it.
 */
function admitAudience(values: readonly unknown[]): {
  readonly kept: CollaborationAudience[];
  readonly dropped: number;
} {
  const kept: CollaborationAudience[] = [];
  let dropped = 0;

  for (const value of values) {
    const parsed = CollaborationAudienceSchema.safeParse(value);
    if (parsed.success) kept.push(parsed.data);
    else dropped += 1;
  }

  return { kept, dropped };
}


function admitEntries(
  request: HarvestRequest,
  proposed: readonly ProposedEntry[],
  rejections: HarvestRejection[],
): BlackboardEntry[] {
  const ids = request.existingEntries.map((entry) => entry.id);
  const known = new Set(ids);
  let inRun = request.existingEntries.length;

  const admitted: BlackboardEntry[] = [];

  for (const candidate of proposed) {
    // A supersession of nothing is refused rather than downgraded to a plain entry.
    // Unlike a dangling reply, this one changes meaning: an entry that believes it
    // replaced something, filed beside the thing it did not replace, is a contradiction
    // the projection would have to resolve by guessing.
    if (candidate.supersedes !== undefined && !known.has(candidate.supersedes)) {
      rejections.push({
        reason: 'unknown_supersedes',
        subject: candidate.subject,
        detail: `no entry called "${candidate.supersedes}" exists in this run`,
      });
      continue;
    }

    const refusal = admitEntry({ config: request.config, alreadyInRun: inRun });
    if (refusal !== undefined) {
      rejections.push({
        reason: refusal.rejection,
        subject: candidate.subject,
        detail: refusal.action,
      });
      continue;
    }

    // **The audience, narrowed here rather than by the outbox schema** (M7 §3).
    //
    // A strict union in `ProposedEntrySchema` would fail the whole file over one
    // unrecognised value, which is exactly what the live M6 run did — twice in one task,
    // discarding two well-formed entries and everything beside them. So the schema keeps
    // the values `unknown` and this narrows them, keeping what it understands.
    const audience = admitAudience(candidate.affects);
    if (audience.dropped > 0) {
      rejections.push({
        reason: 'schema_invalid',
        subject: candidate.subject,
        detail:
          `${String(audience.dropped)} audience value(s) were not a role, a member or ` +
          '"everyone", and were dropped',
      });
    }

    // **An audience that was named and not understood is refused, never widened.** An
    // empty `affects` means "everyone" and is an honest default for a discovery nobody
    // knew the audience of; arriving at empty by discarding every value the author wrote
    // would deliver to everyone precisely the entry that tried to be specific.
    if (candidate.affects.length > 0 && audience.kept.length === 0) {
      rejections.push({
        reason: 'schema_invalid',
        subject: candidate.subject,
        detail: 'no audience value could be understood, and an entry is not widened to everyone',
      });
      continue;
    }

    const redaction = {
      workspaceRoot: request.workspaceDir,
      ...(request.homeDir === undefined ? {} : { home: request.homeDir }),
    };
    const statement = redactAndTruncate(candidate.statement, request.config.maxMessageBytes, redaction);
    const rationale =
      candidate.rationale === undefined
        ? undefined
        : redactAndTruncate(candidate.rationale, request.config.maxMessageBytes, redaction);

    const id = nextEntryId(candidate.kind, ids);
    const entry = BlackboardEntrySchema.parse({
      id,
      runId: request.runId,
      kind: candidate.kind,
      subject: candidate.subject,
      // Assigned, exactly as a message's sender is. An entry attributed to an agent that
      // did not write it is a decision with a fabricated author.
      author: request.agentId,
      statement: statement.text,
      ...(rationale === undefined ? {} : { rationale: rationale.text }),
      affects: audience.kept,
      references: candidate.references,
      ...(candidate.supersedes === undefined ? {} : { supersedes: candidate.supersedes }),
      truncated: statement.truncated || (rationale?.truncated ?? false),
      createdAt: request.now,
    });

    admitted.push(entry);
    ids.push(id);
    known.add(id);
    inRun += 1;
  }

  return admitted;
}

/* ─── Filesystem ───────────────────────────────────────────────────────────── */

async function withinWorkspace(
  fs: FileSystem,
  workspaceDir: string,
  path: string,
): Promise<boolean> {
  const root = await fs.realPath(workspaceDir);
  const resolved = await fs.realPath(path);
  if (root === null || resolved === null) return false;

  // At-or-under would admit the workspace directory itself; the outbox is a file inside
  // it, so equality means the caller was handed something that is not the outbox.
  return resolved !== root && isAtOrUnderRoot(root, resolved, nodePath);
}

/**
 * Removes the outbox, and says whether it worked.
 *
 * Never throws. A removal that fails is a fact the caller has to record — the file will
 * be staged into the validated tree — and turning it into an exception here would abort
 * an attempt whose work is otherwise complete and valid.
 */
async function remove(fs: FileSystem, path: string): Promise<boolean> {
  try {
    await fs.remove(path);
    return !(await fs.exists(path));
  } catch {
    return false;
  }
}

/**
 * Whether the file tried to name its own sender.
 *
 * Checked on the *raw* object, before the schema strips it. The strip is the defence; this
 * is the audit trail of the defence firing, and without it an agent could attempt
 * impersonation on every attempt of every run and leave no trace at all.
 */
function claimsASender(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const messages = (raw as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return false;

  return messages.some(
    (message) => typeof message === 'object' && message !== null && 'from' in message,
  );
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}
