import type { DeliveryView } from '../../core/forge/delivery.js';

/**
 * Where this run went, in a terminal (M7 §42).
 *
 * **Local status and delivery status are separate, and this block never mentions the
 * former.** A run is completed or it is not, and a pull request is open or it is not;
 * printing them together in one line is how "checks pending" starts reading as "the run
 * is not finished".
 *
 * Rendered from the same projection the API returns and the dashboard draws.
 */
export function renderDelivery(view: DeliveryView): string {
  if (view.state === 'disabled') return `Delivery:\n  ${view.detail}`;

  const lines: string[] = ['Delivery:', `  ${STATE_MARK[view.state]} ${view.state.replace(/_/g, ' ')}`];

  if (view.repository !== undefined) lines.push(`  repository  ${view.repository}`);
  if (view.branch !== undefined && view.publishedCommit !== undefined) {
    lines.push(`  published   ${view.publishedCommit.slice(0, 8)} → ${view.branch}`);
  }
  if (view.issue !== undefined) lines.push(`  issue       #${String(view.issue.number)}  ${view.issue.url}`);
  if (view.pullRequest !== undefined) {
    lines.push(
      `  pull req    #${String(view.pullRequest.number)}  ${view.pullRequest.state}  ${view.pullRequest.url}`,
    );
  }

  if (view.checkSummary.total > 0) {
    const { total, green, red, pending } = view.checkSummary;
    lines.push(
      `  checks      ${String(green)}/${String(total)} passed` +
        (red > 0 ? `, ${String(red)} failed` : '') +
        (pending > 0 ? `, ${String(pending)} pending` : ''),
    );
  }

  if (view.syncedAt !== undefined) lines.push(`  last sync   ${view.syncedAt}`);

  // The sentence last, because it is what a person acts on and the fields above are what
  // they check afterwards.
  lines.push(`  ${view.detail}`);

  return lines.join('\n');
}

const STATE_MARK: Record<DeliveryView['state'], string> = {
  disabled: '·',
  not_published: '·',
  published: '↑',
  pr_open: '◇',
  checks_pending: '⟳',
  checks_green: '✓',
  // Not `✗`: a failing remote check is not a failing run, and the mark a reader already
  // associates with "this run failed" would say otherwise before the words got a chance.
  checks_red: '!',
  remote_diverged: '⚠',
  delivery_failed: '⚠',
};
