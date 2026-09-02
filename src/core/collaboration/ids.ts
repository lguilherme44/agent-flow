import {
  ENTRY_ID_PREFIX,
  type BlackboardEntryKind,
  type EntryId,
  type MessageId,
  type ThreadId,
} from '../../contracts/index.js';

/**
 * The next id in a sequence, derived from what is already on disk (M4-02).
 *
 * **Derived rather than counted**, which is the same decision `StateStore.nextRunId`
 * makes and for the same reason: a counter file is one more thing that can disagree with
 * reality. A log with `MSG-0001` and `MSG-0002` in it has already said what the next id
 * is, and asking it costs one pass over a file the caller has just read anyway.
 *
 * The functions here are pure and take the existing ids. Reading the log is the store's
 * job; allocating from it is a rule, and a rule with no I/O is one that can be tested
 * exhaustively.
 *
 * **The maximum, not the count.** A log of three messages whose ids are `MSG-0001`,
 * `MSG-0002` and `MSG-0007` — which a partially-written line or a skipped malformed entry
 * can produce — must not allocate `MSG-0004`, because that id may already be cited by a
 * message that survived. Counting would reuse it; taking the maximum cannot.
 */

/** How many digits each sequence pads to. Fixed, so ids sort lexicographically. */
const MESSAGE_DIGITS = 4;
const THREAD_DIGITS = 4;
const ENTRY_DIGITS = 3;

function nextNumber(existing: readonly string[], pattern: RegExp): number {
  let highest = 0;
  for (const id of existing) {
    const match = pattern.exec(id);
    if (match?.[1] === undefined) continue;
    const value = Number.parseInt(match[1], 10);
    if (Number.isFinite(value) && value > highest) highest = value;
  }
  return highest + 1;
}

function pad(value: number, digits: number): string {
  return String(value).padStart(digits, '0');
}

export function nextThreadId(existing: readonly string[]): ThreadId {
  return `THR-${pad(nextNumber(existing, /^THR-(\d+)$/), THREAD_DIGITS)}`;
}

/**
 * The next id for one entry kind.
 *
 * Per kind, because the prefix *is* the kind: `DEC-004` says what it is where a reader
 * meets it, and a shared sequence would make every citation need a lookup before it meant
 * anything. So the existing ids are filtered to the kind's own prefix first.
 */
export function nextEntryId(kind: BlackboardEntryKind, existing: readonly string[]): EntryId {
  const prefix = ENTRY_ID_PREFIX[kind];
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  return `${prefix}-${pad(nextNumber(existing, pattern), ENTRY_DIGITS)}`;
}

/**
 * Allocates a run of ids in one pass, so a harvest of five messages does not have to
 * re-scan the log five times.
 *
 * **There is no single-message variant, deliberately.** One existed, was exported, was
 * tested, and had no caller — the harvest allocates a batch because a batch is what an
 * outbox is — and the architecture rule that forbids a core function nothing calls caught
 * it before it shipped. `allocateMessageIds(existing, 1)` is the one-message case.
 *
 * Returns them in order. The caller pairs them with its proposals positionally, which is
 * what keeps a harvest deterministic: the same outbox always produces the same ids
 * against the same log.
 */
export function allocateMessageIds(existing: readonly string[], count: number): MessageId[] {
  const start = nextNumber(existing, /^MSG-(\d+)$/);
  return Array.from({ length: count }, (_, offset) => `MSG-${pad(start + offset, MESSAGE_DIGITS)}`);
}
