import type {
  BlackboardEntry,
  EntryId,
  EntryStatus,
  ProjectedEntry,
  WorkflowRole,
} from '../../contracts/index.js';

/**
 * What the run currently knows, once every later entry has had its say (M4-05).
 *
 * **The log is append-only and this is the only thing that reads it as a state** (I-30).
 * There is no update, no delete and no edit anywhere in the product: a change is a new
 * entry naming the one it replaces, and what that *means* is decided here rather than by
 * whoever wrote last.
 *
 * The rule that makes §42 real, and the one worth reading twice:
 *
 *   - superseded by its **own author** → a correction. The old entry drops out of context
 *     and the new one stands.
 *   - superseded by **somebody else** → a disagreement. **Both stay live, both reach the
 *     next agent**, and both are marked `contested`.
 *
 * The alternative was a permission lattice — who may overrule whom — which the charter
 * warns against for good reason: an ACL nobody can maintain is an ACL that gets a blanket
 * exemption within a month. This needs no permissions at all. An executor that discovers
 * the architect's contract is wrong can say so; what it cannot do is make the architect's
 * entry disappear, and the next agent is shown the argument rather than a winner.
 *
 * Pure, and deterministic: the log's order is the answer's order.
 */

export function projectBlackboard(entries: readonly BlackboardEntry[]): ProjectedEntry[] {
  const authorOf = new Map<EntryId, string>(entries.map((entry) => [entry.id, entry.author]));

  /** id → the entry that superseded it, and whether the two authors agreed. */
  const supersededBy = new Map<EntryId, { readonly by: EntryId; readonly sameAuthor: boolean }>();

  for (const entry of entries) {
    if (entry.supersedes === undefined) continue;
    const previousAuthor = authorOf.get(entry.supersedes);
    // A supersession of something not in the log is dropped at harvest, so this is
    // unreachable through the store. Skipped rather than assumed, because the read model
    // also parses files that were edited by hand.
    if (previousAuthor === undefined) continue;

    supersededBy.set(entry.supersedes, {
      by: entry.id,
      sameAuthor: previousAuthor === entry.author,
    });
  }

  // The superseding side of a contested pair is contested too. Marking only the older one
  // would show a reader one entry labelled "disputed" and its replacement labelled
  // "active", which reads as a settled argument rather than an open one.
  const contested = new Set<EntryId>();
  for (const [id, supersession] of supersededBy) {
    if (supersession.sameAuthor) continue;
    contested.add(id);
    contested.add(supersession.by);
  }

  return entries.map((entry) => {
    const supersession = supersededBy.get(entry.id);
    const status: EntryStatus = contested.has(entry.id)
      ? 'contested'
      : supersession === undefined
        ? 'active'
        : 'superseded';

    return {
      entry,
      status,
      ...(supersession === undefined ? {} : { supersededBy: supersession.by }),
    };
  });
}

/**
 * The entries this agent should be shown, and nothing else (M4-06).
 *
 * `superseded` is excluded and `contested` is not — which is the whole point of there
 * being three statuses instead of two. A correction has a right answer and showing the old
 * one wastes budget; a disagreement has no right answer yet, and hiding half of it would
 * hand the next agent a decision somebody else is still arguing about.
 *
 * Relevance is structural, exactly as it is for threads: an entry reaches an agent because
 * it names that agent's role, or because it concerns this task or one of its files. No
 * model call, no score, no nondeterminism.
 */
export function entriesFor(
  projected: readonly ProjectedEntry[],
  audience: {
    readonly role: WorkflowRole;
    readonly taskId?: string;
    readonly files?: readonly string[];
  },
): ProjectedEntry[] {
  const files = new Set(audience.files ?? []);

  return projected.filter(({ entry, status }) => {
    if (status === 'superseded') return false;

    // Addressed to everyone. The honest default for a discovery whose audience the
    // author could not know.
    if (entry.affects.length === 0) return true;
    if (entry.affects.includes(audience.role)) return true;

    return entry.references.some((reference) => {
      if (reference.kind === 'task') return reference.id === audience.taskId;
      if (reference.kind === 'file') return files.has(reference.id);
      return false;
    });
  });
}
