import type { ReviewThreadView, ReviewView } from '../../contracts/index.js';

/**
 * What the reviewers found, in a terminal (M6-09, M6-ACC-21).
 *
 * **Rendered from `core/review/view.ts` — the projection the API returns and the
 * dashboard draws.** A CLI that folded the review log itself would be a second answer to
 * whether a change is approved, and the second one is the one that eventually disagrees.
 *
 * Deliberately terse, for the reason the collaboration and team blocks are: `status` is
 * read before deciding whether a run can move forward, and a list of every finding in the
 * middle of it would bury the gate. So: what is blocking, what is stale, and the count —
 * the whole record is one HTTP call or one `.jsonl` away.
 */

const STATUS_MARK: Record<ReviewThreadView['status'], string> = {
  approved: '✓',
  changes_requested: '✎',
  awaiting_recheck: '⟳',
  in_review: '·',
  blocked: '✗',
};

export function renderReview(review: ReviewView): string | undefined {
  if (!review.reviewed) return undefined;

  const lines: string[] = ['Review:'];

  for (const thread of review.threads) {
    const stale = thread.freshness === 'stale' ? ' — STALE' : '';
    lines.push(
      `  ${STATUS_MARK[thread.status]} ${thread.taskId} ${thread.status.replace(/_/g, ' ')}` +
        ` · ${thread.reviewerName} (independence ${String(thread.independence)})` +
        `${thread.rounds > 1 ? ` · round ${String(thread.rounds)}` : ''}${stale}`,
    );

    // Only what still stops the change. A verified finding is history, and history
    // belongs in the log rather than in the line somebody reads before deciding.
    for (const held of thread.findings.filter((f) => f.status !== 'verified').slice(0, 3)) {
      lines.push(
        `      [${held.finding.severity}] ${held.finding.id} ${held.status} — ` +
          `${held.finding.description.slice(0, 90)}`,
      );
    }
  }

  const failing = review.gates.filter(
    (gate) => gate.required && gate.status !== 'passed' && gate.status !== 'not_applicable',
  );
  if (failing.length > 0) {
    // Loud, and never folded into a count. A required gate that did not run is not a
    // gate that passed, and this is the line that says so.
    lines.push(
      `  ⚠ ${String(failing.length)} required gate(s) unsatisfied: ` +
        failing.map((gate) => `${gate.gateId} ${gate.status.replace('_', ' ')}`).join(', '),
    );
  }

  const totals = review.totals;
  lines.push(
    `  ${String(totals.reviews)} review(s) over ${String(totals.tasksReviewed)} task(s), ` +
      `${String(totals.findings)} finding(s) — ${String(totals.openFindings)} open, ` +
      `${String(totals.verifiedFindings)} verified` +
      (totals.disputes === 0 ? '' : `, ${String(totals.disputes)} disputed`) +
      (totals.staleReviews === 0 ? '' : ` · ${String(totals.staleReviews)} stale`),
  );

  return lines.join('\n');
}
