import type {
  AgentRoster,
} from '../collaboration/roster.js';
import type {
  AgentMessage,
  FindingStatus,
  QualityConfig,
  QualityGateResult,
  ReviewRecord,
  ReviewThreadStatus,
  ReviewThreadView,
  ReviewTotals,
  ReviewView,
  RunEvent,
} from '../../contracts/index.js';
import { projectFindings, type ProjectedFinding } from './findings.js';
import { decideQuality, latestReview, type QualityDecision } from './decision.js';
import { unsatisfiedRequired } from './gates.js';

/**
 * A run's reviews, folded for whoever is reading (M6-09, M6-ACC-21).
 *
 * **One projection, three surfaces.** The CLI prints this, the HTTP API returns it and
 * the dashboard draws it. None of them derives a review's status, a finding's blocking
 * status, a gate's verdict or a review's freshness — §59 names all four, and a browser
 * that computed any of them would be a second authority whose first disagreement with
 * the run puts a decision nobody made on screen.
 *
 * **Freshness is computed here and nowhere else.** It lived in
 * `apps/web/src/lib/review-freshness.ts` and was decided in the browser, by its own
 * rules, from fields it happened to have. Identity against the integrated tree is the
 * only thing that answers it, and this is the only place that knows both.
 *
 * Pure, and a fold over facts the run already recorded. Nothing here decides whether a
 * change proceeds — `decideQuality` does, and this carries its answer so a reader sees
 * the same verdict the workflow acted on.
 */

export interface ReviewProjectionInput {
  readonly reviews: readonly ReviewRecord[];
  readonly messages: readonly AgentMessage[];
  readonly events: readonly RunEvent[];
  readonly quality: QualityConfig;
  readonly roster?: AgentRoster;
  /** The commit each task is integrated as, from the run's own results. */
  readonly integratedTrees?: ReadonlyMap<string, string>;
}

/**
 * The shapes this module produces are declared in `contracts/api.schema.ts`.
 *
 * Contracts may not import from the core, and the browser needs them — so the type lives
 * where every layer can see it and the fold lives here. The same split `TeamView` uses.
 */

export const EMPTY_REVIEW: ReviewView = {
  reviewed: false,
  threads: [],
  gates: [],
  unsatisfiedGates: [],
  totals: {
    reviews: 0,
    tasksReviewed: 0,
    findings: 0,
    openFindings: 0,
    verifiedFindings: 0,
    staleReviews: 0,
    disputes: 0,
    bySeverity: {},
    byCategory: {},
    byIndependence: {},
  },
};

export function projectReviews(input: ReviewProjectionInput): ReviewView {
  if (input.reviews.length === 0) return EMPTY_REVIEW;

  const findings = projectFindings({
    reviews: input.reviews,
    messages: input.messages,
    events: input.events,
  });

  const gates = gatesFromEvents(input.events);
  const byTask = new Map<string, ReviewRecord[]>();
  for (const record of input.reviews) {
    byTask.set(record.taskId, [...(byTask.get(record.taskId) ?? []), record]);
  }

  const threads = [...byTask.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([taskId, records]) =>
      threadOf({ taskId, records, findings, gates, input }),
    );

  return {
    reviewed: true,
    threads,
    gates,
    unsatisfiedGates: unsatisfiedRequired(gates),
    totals: totalsOf(input.reviews, findings, threads),
  };
}

function threadOf(context: {
  taskId: string;
  records: readonly ReviewRecord[];
  findings: readonly ProjectedFinding[];
  gates: readonly QualityGateResult[];
  input: ReviewProjectionInput;
}): ReviewThreadView {
  const { taskId, records, input } = context;
  const latest = latestReview(records);
  const mine = context.findings.filter((held) => held.taskId === taskId);
  const integratedTree = input.integratedTrees?.get(taskId);

  const decision = decideQuality({
    reviews: records,
    findings: mine,
    gates: context.gates,
    quality: input.quality,
    ...(integratedTree === undefined ? {} : { integratedTree }),
  });

  const openBlocking = mine.filter(
    (held) => held.status !== 'verified' && held.finding.severity !== 'low' && held.finding.severity !== 'info',
  ).length;

  return {
    taskId,
    status: statusOf(latest, mine, decision),
    freshness: freshnessOf(latest?.reviewedTree, integratedTree),
    rounds: records.length,
    reviewer: latest?.reviewer ?? '',
    reviewerName: input.roster?.byId(latest?.reviewer ?? '')?.displayName ?? latest?.reviewer ?? '',
    author: latest?.author ?? '',
    independence: latest?.independence ?? 0,
    ...(latest?.reviewedTree === undefined ? {} : { reviewedTree: latest.reviewedTree }),
    ...(integratedTree === undefined ? {} : { integratedTree }),
    findings: mine,
    openBlocking,
    decision,
  };
}

/**
 * Where this review stands, from the record and the decision.
 *
 * `approved` is the decision's answer, not the reviewer's: a review that said `approve`
 * over a tree that has since changed is `awaiting_recheck`, and one whose gate failed is
 * not approved however satisfied the reviewer was (I-44).
 */
function statusOf(
  latest: ReviewRecord | undefined,
  findings: readonly ProjectedFinding[],
  decision: QualityDecision,
): ReviewThreadStatus {
  if (latest === undefined) return 'in_review';
  if (decision.approved) return 'approved';
  if (latest.verdict === 'blocked') return 'blocked';

  // Every blocking finding has corrective work behind it and nobody has looked again.
  const unresolved = findings.filter((held) => held.status === 'open' || held.status === 'disputed');
  if (findings.length > 0 && unresolved.length === 0) return 'awaiting_recheck';

  return 'changes_requested';
}

/**
 * Whether the latest review still describes what is integrated (I-41).
 *
 * `unverifiable` when either side has no commit — a sequential run has no tree, and
 * calling that stale would refuse every sequential review on the strength of a
 * measurement nobody took.
 */
function freshnessOf(
  reviewed: string | undefined,
  integrated: string | undefined,
): 'current' | 'stale' | 'unverifiable' {
  if (reviewed === undefined || integrated === undefined) return 'unverifiable';
  return reviewed === integrated ? 'current' : 'stale';
}

/**
 * What each gate said, from the audit trail.
 *
 * The events the review service already wrote, rather than a second evaluation: two
 * projections of one gate would be two answers about whether the build passed.
 */
function gatesFromEvents(events: readonly RunEvent[]): QualityGateResult[] {
  const latest = new Map<string, QualityGateResult>();

  for (const event of events) {
    if (event.type !== 'quality_gate_evaluated') continue;
    const gateId = event.detail['gate'];
    const status = event.detail['status'];
    if (typeof gateId !== 'string' || typeof status !== 'string') continue;

    latest.set(gateId, {
      gateId,
      category: (typeof event.detail['category'] === 'string'
        ? event.detail['category']
        : 'custom') as QualityGateResult['category'],
      required: event.detail['required'] === true,
      status: status as QualityGateResult['status'],
      ...(typeof event.detail['exitCode'] === 'number' ? { exitCode: event.detail['exitCode'] } : {}),
      ...(typeof event.detail['durationMs'] === 'number'
        ? { durationMs: event.detail['durationMs'] }
        : {}),
    });
  }

  return [...latest.values()].sort((a, b) => (a.gateId < b.gateId ? -1 : 1));
}

function totalsOf(
  reviews: readonly ReviewRecord[],
  findings: readonly ProjectedFinding[],
  threads: readonly ReviewThreadView[],
): ReviewTotals {
  const count = (values: readonly string[]): Record<string, number> => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : 1)));
  };

  const statuses = (status: FindingStatus): number =>
    findings.filter((held) => held.status === status).length;

  return {
    reviews: reviews.length,
    tasksReviewed: threads.length,
    findings: findings.length,
    openFindings: statuses('open'),
    verifiedFindings: statuses('verified'),
    staleReviews: threads.filter((thread) => thread.freshness === 'stale').length,
    disputes: statuses('disputed'),
    bySeverity: count(findings.map((held) => held.finding.severity)),
    byCategory: count(findings.map((held) => held.finding.type)),
    byIndependence: count(reviews.map((review) => String(review.independence))),
  };
}
