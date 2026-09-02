import { CircleAlert, CircleCheck, CircleDot, FileWarning, RefreshCw } from 'lucide-react';
import type {
  ProjectedFindingView,
  QualityGateResult,
  ReviewThreadView,
  ReviewView,
} from '@contracts/index.js';
import { Badge, Card, Empty, cx } from '../components/ui';

/**
 * What the reviewers found, and whether the gates agree (§60–§62).
 *
 * **A projection of the server's projection.** Nothing here decides a review's status, a
 * finding's blocking status, a gate's verdict or a review's freshness — §59 names all
 * four, and each arrives answered. A component that computed any of them would be a
 * second authority whose first disagreement with the run puts a decision nobody made on
 * screen.
 *
 * Deliberately not a code-review tool. A diff viewer with inline comments is a product;
 * what a person needs from this card is **what is blocking, what is stale, and what the
 * commands said** — the three things that decide whether the run can move on.
 */

const STATUS: Record<ReviewThreadView['status'], { icon: typeof CircleDot; tone: 'success' | 'warning' | 'danger' | 'muted' }> = {
  approved: { icon: CircleCheck, tone: 'success' },
  changes_requested: { icon: FileWarning, tone: 'warning' },
  awaiting_recheck: { icon: RefreshCw, tone: 'info' as never },
  in_review: { icon: CircleDot, tone: 'muted' },
  blocked: { icon: CircleAlert, tone: 'danger' },
};

const SEVERITY_TONE: Record<string, 'danger' | 'warning' | 'info' | 'muted'> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'info',
  info: 'muted',
};

export function ReviewPanel(props: { review: ReviewView | undefined; className?: string }): JSX.Element {
  const view = props.review;
  const threads = view?.threads ?? [];
  const totals = view?.totals;

  // **Answered, not derived.** This filtered the gate list here, and the dashboard's own
  // architecture rule caught it: `required && status !== 'passed'` is the sentence that
  // turns evidence into a refusal, and one place answers it.
  const failing = view?.unsatisfiedGates ?? [];

  return (
    <Card
      title="Review"
      {...(props.className === undefined ? {} : { className: props.className })}
      footer={
        totals === undefined ? null : (
          <span>
            {String(totals.reviews)} review(s) over {String(totals.tasksReviewed)} task(s) ·{' '}
            {String(totals.findings)} finding(s), {String(totals.openFindings)} open,{' '}
            {String(totals.verifiedFindings)} verified
            {totals.staleReviews === 0 ? null : ` · ${String(totals.staleReviews)} stale`}
          </span>
        )
      }
    >
      {view?.reviewed !== true ? (
        <Empty
          title="Nothing reviewed."
          // "No reviewer" and "reviewed and found nothing" are different states, and the
          // hint depends on which — sending somebody to configure a reviewer they already
          // have would be the screen misreading its own data.
          hint="Give a team member the review skill to have each change read by somebody who did not write it."
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          {failing.length === 0 ? null : <FailingGates gates={failing} />}
          <ul className="flex flex-col divide-y divide-border/70">
            {threads.slice(0, 4).map((thread) => (
              <Thread key={thread.taskId} thread={thread} />
            ))}
          </ul>
          {threads.length > 4 ? (
            <p className="text-micro text-faint">… and {String(threads.length - 4)} more task(s)</p>
          ) : null}
          <Gates gates={view.gates} />
        </div>
      )}
    </Card>
  );
}

/**
 * One change's review: who read it, whether it still describes what is integrated, and
 * what remains open.
 *
 * The findings are behind a disclosure for the reason the assignment ranking is: "what
 * exactly did they find" is a real question and a rare one, and a card that answered it
 * unprompted would be a card nobody can scan.
 */
function Thread(props: { thread: ReviewThreadView }): JSX.Element {
  const { thread } = props;
  const { icon: Icon, tone } = STATUS[thread.status];
  const unresolved = thread.findings.filter((held) => held.status !== 'verified');

  return (
    <li className="py-1.5">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-label">
          <Icon
            className={cx(
              'h-3.5 w-3.5 shrink-0',
              thread.status === 'approved' && 'text-success',
              thread.status === 'blocked' && 'text-danger',
              thread.status === 'changes_requested' && 'text-warning',
            )}
            aria-hidden
          />
          <span className="tabular font-medium text-text">{thread.taskId}</span>
          {/* §97: status in words, never in colour alone. */}
          <Badge tone={tone === ('info' as never) ? 'info' : tone} caps>
            {thread.status.replace(/_/g, ' ')}
          </Badge>
          {thread.freshness === 'stale' ? (
            <Badge tone="warning" caps>
              stale
            </Badge>
          ) : null}
          {/* The count is the affordance as well as the fact: a row that says "2 open"
              is a row a reader knows has something behind it. Without it the threads
              collapsed to one line each with nothing to suggest they expand. */}
          {unresolved.length === 0 ? null : (
            <span className="shrink-0 text-micro text-faint group-open:hidden">
              {String(unresolved.length)} open
            </span>
          )}
          <span className="ml-auto truncate text-micro text-faint">
            {thread.reviewerName} · independence {String(thread.independence)}
            {thread.rounds > 1 ? ` · round ${String(thread.rounds)}` : ''}
          </span>
        </summary>

        {/* **The detail, not the condition's name.** `blockedBy` lists conditions, and a
            condition is phrased as the thing that should be true — so rendering it raw
            put "no blocking finding is open" under a change that is blocked by exactly
            that, which reads as a reassurance. The detail says which finding. */}
        {thread.decision.approved ? null : (
          <p className="mt-1 text-micro leading-snug text-warning">
            Blocked:{' '}
            {thread.decision.conditions
              .filter((condition) => !condition.met)
              .map((condition) => condition.detail ?? condition.name)
              .join('; ')}
          </p>
        )}

        {unresolved.length === 0 ? (
          <p className="mt-1 text-micro text-faint">Nothing open.</p>
        ) : (
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {unresolved.slice(0, 5).map((held) => (
              <FindingRow key={held.finding.id} held={held} />
            ))}
          </ul>
        )}
      </details>
    </li>
  );
}

/**
 * One finding, with the four things §61 asks for that a reader acts on.
 *
 * Severity and status carry the weight; the place and the suggested action are what turn
 * a complaint into work. The corrective task is shown when there is one, because "fixed"
 * without a name is a claim and with one it is a thing to go and read.
 */
function FindingRow(props: { held: ProjectedFindingView }): JSX.Element {
  const { finding, status, correctiveTask } = props.held;

  return (
    <li className="rounded-sm border border-border/70 bg-surface-2/40 px-2 py-1">
      <p className="flex flex-wrap items-center gap-1.5 text-micro">
        <Badge tone={SEVERITY_TONE[finding.severity] ?? 'muted'} caps>
          {finding.severity}
        </Badge>
        <span className="tabular font-medium text-text">{finding.id}</span>
        <span className="text-faint">{finding.type}</span>
        <Badge tone={status === 'fixed' ? 'info' : status === 'disputed' ? 'warning' : 'muted'}>
          {status}
        </Badge>
        {correctiveTask === undefined ? null : (
          <span className="text-faint">→ {correctiveTask}</span>
        )}
      </p>
      <p className="mt-0.5 text-micro leading-snug text-muted">{finding.description}</p>
      {finding.file === undefined ? null : (
        <p className="mt-0.5 truncate text-micro text-faint">
          {finding.file}
          {finding.location === undefined ? '' : `:${String(finding.location.line)}`}
        </p>
      )}
    </li>
  );
}

/**
 * The one thing that must never read as a detail.
 *
 * A required gate that did not run is not a gate that passed, and folding it into a count
 * beside the passing ones is how absence of evidence becomes evidence of absence.
 */
function FailingGates(props: { gates: readonly QualityGateResult[] }): JSX.Element {
  return (
    <div className="rounded-md border border-danger/40 bg-danger/5 p-2">
      <p className="flex items-center gap-1.5 text-label font-semibold text-danger">
        <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {String(props.gates.length)} required gate(s) unsatisfied
      </p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {props.gates.map((gate) => (
          <li key={gate.gateId} className="text-micro text-muted">
            <span className="font-medium text-text">{gate.gateId}</span>{' '}
            {gate.status.replace('_', ' ')}
            {gate.detail === undefined ? '' : ` — ${gate.detail}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Every gate, as operational evidence (§62) — including the ones that did not run. */
function Gates(props: { gates: readonly QualityGateResult[] }): JSX.Element | null {
  if (props.gates.length === 0) return null;

  return (
    <div className="rounded-md border border-border/70 bg-surface-2/40 p-2">
      <p className="text-label font-medium text-text">Quality gates</p>
      {/* **Chips rather than a two-column table.** The first version put each gate in a
          grid cell with `justify-between`, which pushed every status to the far right of
          its column — so `lint … passed  security … not run` read as four unrelated
          words and the pairs had to be reassembled by eye. A label and its verdict belong
          next to each other. */}
      <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {props.gates.map((gate) => (
          <li key={gate.gateId} className="flex items-center gap-1 text-micro">
            <span className="truncate text-muted">
              {gate.gateId}
              {gate.required ? '' : ' (advisory)'}
            </span>
            {/* `not run` is never grey-and-forgettable when the gate is required (§62). */}
            <span
              className={cx(
                'shrink-0 font-medium',
                gate.status === 'passed' && 'text-success',
                gate.status === 'failed' && 'text-danger',
                gate.status === 'not_run' && (gate.required ? 'text-danger' : 'text-faint'),
                gate.status === 'not_applicable' && 'text-faint',
              )}
            >
              {gate.status.replace('_', ' ')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
