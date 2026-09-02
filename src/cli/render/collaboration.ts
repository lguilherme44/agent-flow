import type { Handoff, MessageThread, ProjectedEntry } from '../../contracts/index.js';

/**
 * What the agents said, in a terminal (M4-07).
 *
 * **Rendered from the same projections the dashboard reads and the prompt was built
 * from.** A CLI that folded the log itself would be a third derivation of a thread's
 * status, and the third one is the one that eventually disagrees.
 *
 * Deliberately terse. `status` is read before deciding whether a run can move forward,
 * and a conversation transcript in the middle of it would bury the gate. So: what is
 * still open, what is contested, and nothing else — the whole exchange is one HTTP call
 * or one `.jsonl` away for anybody who wants it.
 */

export interface CollaborationSummary {
  readonly enabled: boolean;
  readonly threads: readonly MessageThread[];
  readonly handoffs: readonly Handoff[];
  readonly entries: readonly ProjectedEntry[];
}

/**
 * The section, or nothing at all.
 *
 * Nothing when the feature is off *and* nothing was ever said — which is every run on
 * every project that has not opted in, and printing a heading there would add a line to
 * `status` for a feature nobody turned on.
 *
 * A run with the feature since switched off but a log from when it was on still renders:
 * what happened, happened.
 */
export function renderCollaboration(summary: CollaborationSummary): string | undefined {
  const open = summary.threads.filter((thread) => thread.status !== 'resolved');
  const contested = summary.entries.filter((projected) => projected.status === 'contested');
  const live = summary.entries.filter((projected) => projected.status !== 'superseded');
  const pending = summary.handoffs.filter((handoff) => handoff.status === 'requested');

  if (summary.threads.length === 0 && summary.entries.length === 0) return undefined;

  const lines: string[] = ['Collaboration:'];

  lines.push(
    `  ${String(summary.threads.length)} thread(s), ${String(open.length)} unresolved · ` +
      `${String(live.length)} live blackboard entry(ies)`,
  );

  for (const thread of open.slice(0, 5)) {
    const who = thread.participants.join(', ');
    lines.push(`  · [${thread.status}] ${thread.subject} — ${who}`);
  }
  if (open.length > 5) lines.push(`  · … and ${String(open.length - 5)} more`);

  for (const handoff of pending) {
    // Shown separately from the thread it lives in, because an unanswered handoff is a
    // task waiting on a person's attention rather than a conversation in progress.
    lines.push(`  ⇄ ${handoff.taskId}: ${handoff.from} → ${handoff.to}, unanswered`);
  }

  if (contested.length > 0) {
    // Loud, and never folded into the count above. Two agents disagreeing about a
    // decision is exactly the thing a person has to settle, and it is the one piece of
    // collaboration state that has no mechanical resolution.
    lines.push(
      `  ⚠ ${String(contested.length)} contested entry(ies) — two agents disagree, and nothing decides it for you:`,
    );
    for (const projected of contested) {
      lines.push(`    ${projected.entry.id} (${projected.entry.subject}) by ${projected.entry.author}`);
    }
  }

  return lines.join('\n');
}
