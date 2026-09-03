import type {
  DeliveryRecord,
  ForgeCheck,
  ForgeConfig,
  ForgeFailure,
} from '../../contracts/index.js';

/**
 * What delivery has reached, folded from facts (M7 §40).
 *
 * **Projected, never stored.** Every state below is derivable from the record and the
 * event log, and a mutable `deliveryStatus` beside them would be the field that disagrees
 * the first time a sync is interrupted — the same rule that keeps a finding's status out
 * of storage, for the same reason.
 *
 * Pure: facts in, a state out. No clock, no network, no filesystem.
 */

export const DELIVERY_STATES = [
  /** No provider. The ordinary case, and not a problem. */
  'disabled',
  /** Configured, and nothing has been published yet. */
  'not_published',
  'published',
  'pr_open',
  'checks_pending',
  'checks_green',
  'checks_red',
  /** The remote branch moved under us. Publishing again would be guessing. */
  'remote_diverged',
  'delivery_failed',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export interface DeliveryView {
  readonly state: DeliveryState;
  readonly provider: string;
  readonly repository?: string;
  readonly branch?: string;
  readonly publishedCommit?: string;
  readonly issue?: { readonly number: number; readonly url: string };
  readonly pullRequest?: { readonly number: number; readonly url: string; readonly state: string };
  readonly checks: readonly ForgeCheck[];
  readonly checkSummary: { readonly total: number; readonly green: number; readonly red: number; readonly pending: number };
  readonly syncedAt?: string;
  readonly failure?: ForgeFailure;
  /** A sentence for a person, always. A state name alone sends them to the source. */
  readonly detail: string;
}

const EMPTY = { total: 0, green: 0, red: 0, pending: 0 } as const;

export function projectDelivery(input: {
  readonly config: ForgeConfig;
  readonly record?: DeliveryRecord;
}): DeliveryView {
  if (input.config.provider === 'none') {
    return {
      state: 'disabled',
      provider: 'none',
      checks: [],
      checkSummary: EMPTY,
      detail: 'no forge is configured, so this run delivers nowhere',
    };
  }

  const record = input.record;
  if (record === undefined) {
    return {
      state: 'not_published',
      provider: input.config.provider,
      checks: [],
      checkSummary: EMPTY,
      detail: 'nothing has been published for this run yet',
    };
  }

  const repository = `${record.repository.owner}/${record.repository.repo}`;
  const summary = summarise(record.checks);
  const base = {
    provider: record.provider,
    repository,
    checks: record.checks,
    checkSummary: summary,
    ...(record.remoteBranch === undefined ? {} : { branch: record.remoteBranch }),
    // Both, or neither. A branch without a commit is a half-written record, and setting
    // the key to `undefined` says "there is a published commit and it is nothing".
    ...(record.remoteBranch === undefined || record.sourceCommit === undefined
      ? {}
      : { publishedCommit: record.sourceCommit }),
    ...(record.issue === undefined
      ? {}
      : { issue: { number: record.issue.number, url: record.issue.url } }),
    ...(record.pullRequest === undefined
      ? {}
      : {
          pullRequest: {
            number: record.pullRequest.number,
            url: record.pullRequest.url,
            state: record.pullRequest.state,
          },
        }),
    ...(record.syncedAt === undefined ? {} : { syncedAt: record.syncedAt }),
    ...(record.failure === undefined ? {} : { failure: record.failure }),
  };

  // **A failure is reported before anything else, and never as "not published".** A run
  // whose delivery failed after publishing has both facts, and the one an operator needs
  // is the failure.
  if (record.failure !== undefined) {
    return {
      ...base,
      state: record.failure.code === 'forge_remote_ref_conflict' ? 'remote_diverged' : 'delivery_failed',
      detail: record.failure.detail,
    };
  }

  // A branch without a commit is not a publication: both facts arrive together, and one
  // without the other is a record half-written rather than a state to report.
  if (record.remoteBranch === undefined || record.sourceCommit === undefined) {
    return { ...base, state: 'not_published', detail: 'nothing has been published for this run yet' };
  }
  const published = record.sourceCommit;

  if (record.pullRequest === undefined) {
    return {
      ...base,
      state: 'published',
      detail: `${published.slice(0, 8)} is on ${record.remoteBranch}, with no pull request`,
    };
  }

  // **A pull request whose head is not the approved commit is diverged, whatever its
  // checks say.** Green checks on a tree this run did not approve is the exact reading M7
  // exists to make impossible.
  if (
    record.pullRequest.headSha !== undefined &&
    record.pullRequest.headSha !== published
  ) {
    return {
      ...base,
      state: 'remote_diverged',
      detail:
        `pull request #${String(record.pullRequest.number)} points at ` +
        `${record.pullRequest.headSha.slice(0, 8)}, and this run approved ` +
        `${published.slice(0, 8)}`,
    };
  }

  if (summary.total === 0) {
    return {
      ...base,
      state: 'pr_open',
      detail: `pull request #${String(record.pullRequest.number)} is open; no checks were observed`,
    };
  }

  if (summary.pending > 0) {
    return {
      ...base,
      state: 'checks_pending',
      detail: `${String(summary.pending)} of ${String(summary.total)} checks have not finished`,
    };
  }

  if (summary.red > 0) {
    return {
      ...base,
      state: 'checks_red',
      // Said plainly, because the temptation this wording resists is real.
      detail:
        `${String(summary.red)} remote check(s) failed. This is delivery, not quality: ` +
        'the local run is unaffected',
    };
  }

  return {
    ...base,
    state: 'checks_green',
    detail: `all ${String(summary.total)} remote checks passed`,
  };
}

/**
 * How the checks stand.
 *
 * **`unknown` counts as pending, never as green.** A conclusion this product does not
 * recognise is a conclusion it has not read, and rounding one up to success is how a green
 * badge appears over something nobody looked at.
 */
function summarise(checks: readonly ForgeCheck[]): DeliveryView['checkSummary'] {
  let green = 0;
  let red = 0;
  let pending = 0;

  for (const check of checks) {
    if (check.status !== 'completed') {
      pending += 1;
      continue;
    }
    switch (check.conclusion) {
      case 'success':
      case 'skipped':
      case 'neutral':
        green += 1;
        break;
      case 'failure':
      case 'timed_out':
      case 'cancelled':
        red += 1;
        break;
      default:
        pending += 1;
    }
  }

  return { total: checks.length, green, red, pending };
}
