import { ArrowRight, Check, CircleAlert, FileText, X } from 'lucide-react';
import type { ArtifactView, RunDetailView, TaskSummaryView } from '@contracts/index.js';
import type { TelemetryResponse } from '../lib/api';
import { magnitudeStep as step } from '../lib/status';
import { Card, Empty, Progress, cx } from '../components/ui';
import { formatDuration, formatWhen } from '../lib/format';
import { countTasks } from './run-overview';
import { ReviewGateButton } from './run-actions';

/**
 * The bottom row (§78).
 *
 * Secondary by construction, not by intention. These four answer questions a
 * person asks *after* reading the table — what was produced, who opened the
 * gate, did it work, where did the effort go — so they are quieter than the
 * table in every dimension the eye measures: smaller headings, no filled status
 * blocks, a muted footer link instead of a call to action.
 *
 * Equal height across all four, because the reference has a flat bottom edge and
 * letting cards size to their content makes the row ragged.
 */

/** Artifacts (§78, UI-16). */
export function ArtifactsCard(props: {
  artifacts: ArtifactView[] | undefined;
  onOpen: (name: string) => void;
}): JSX.Element {
  const all = props.artifacts ?? [];
  const available = all.filter((artifact) => artifact.available);

  return (
    <Card
      title="Artifacts"
      footer={
        <span className="flex items-center gap-1">
          {String(available.length)} of {String(all.length)} produced
          <ArrowRight className="h-3 w-3" aria-hidden />
        </span>
      }
    >
      {available.length === 0 ? (
        <Empty title="Nothing produced yet." />
      ) : (
        <ul className="flex flex-col divide-y divide-border/70">
          {/* Three, which is what fits without the fourth being sliced in half.
              The footer says how many there are in total. */}
          {available.slice(0, 3).map((artifact) => (
            <li key={artifact.name}>
              <button
                type="button"
                onClick={() => {
                  props.onOpen(artifact.name);
                }}
                className="flex w-full items-center justify-between gap-2 py-1 text-left hover:text-primary-bright"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
                  <span className="truncate text-label">{artifact.label}</span>
                </span>
                <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-label="available" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * Approval (§78, UI-17).
 *
 * The state is the headline; the hash and the timestamp are the supporting
 * detail. And the hash is shown at all because it *is* the guarantee: approval
 * is granted to one specific plan, so a card saying only "approved at 19:12"
 * would describe a property the run may no longer have.
 */
export function ApprovalCard(props: {
  run: RunDetailView;
  projectId: string | undefined;
}): JSX.Element {
  const { run } = props;
  const forced = run.degradationDetail.some(
    (degradation) => degradation.kind === 'forced_approval',
  );

  const state = run.approved
    ? { label: 'APPROVED', tone: 'success' as const, icon: Check }
    : run.status === 'waiting_for_approval'
      ? { label: 'WAITING', tone: 'warning' as const, icon: CircleAlert }
      : run.status === 'plan_rejected'
        ? { label: 'REJECTED', tone: 'danger' as const, icon: X }
        : null;

  return (
    <Card
      title="Plan approval"
      className={cx(
        run.status === 'waiting_for_approval' && 'border-warning/30 shadow-glow-warning',
        run.status === 'plan_rejected' && 'border-danger/30',
      )}
      footer={
        run.approved ? (
          <span>Bound to this exact plan — a revision reopens the gate</span>
        ) : run.status === 'waiting_for_approval' ? (
          <span>The SDD and the plan are in Artifacts, beside this card</span>
        ) : run.status === 'running' ? (
          <span>Planning in progress ({run.stage ?? 'running'})</span>
        ) : run.status === 'plan_rejected' ? (
          <span>Plan review rejected this plan</span>
        ) : (
          <span>Review &amp; approve is in the run header</span>
        )
      }
    >
      {state === null ? (
        <Empty title="Not at the gate yet." />
      ) : (
        <div className="flex flex-col gap-2 py-1">
          <div
            className={cx(
              'flex items-center gap-2 rounded-md border px-2.5 py-2',
              state.tone === 'success' && 'border-success/25 bg-success-soft',
              state.tone === 'warning' && 'border-warning/25 bg-warning-soft',
              state.tone === 'danger' && 'border-danger/25 bg-danger-soft',
            )}
          >
            <state.icon
              className={cx(
                'h-4 w-4 shrink-0',
                state.tone === 'success' && 'text-success',
                state.tone === 'warning' && 'text-warning',
                state.tone === 'danger' && 'text-danger',
              )}
              aria-hidden
            />
            <div className="flex min-w-0 flex-col">
              {/* APPROVED / WAITING / REJECTED is the answer this card exists
                  to give, and the line under it is the timestamp — so the
                  status has to be the larger of the two. The first pass had it
                  the wrong way round (12px status over a 14px caption), and
                  fixing that by promoting the status overflowed the card: this
                  row has a fixed height, and the `Review the plan` button below
                  lost its label to it.

                  So the pair is corrected downwards instead: 12 over 11, which
                  is the ordering the rest of the app uses for a value over its
                  caption and the vertical budget this card was built with.
                  `tracking-caps` stays — 0.025em was under the 0.06em floor
                  this pass set for upper-case everywhere else. */}
              <span
                className={cx(
                  'text-label font-semibold uppercase tracking-caps',
                  state.tone === 'success' && 'text-success',
                  state.tone === 'warning' && 'text-warning',
                  state.tone === 'danger' && 'text-danger',
                )}
              >
                {state.label}
              </span>
              <span className="truncate text-micro text-muted">
                {run.approved
                  ? formatWhen(run.approvedAt)
                  : run.status === 'waiting_for_approval'
                    ? 'Read the SDD and the plan first'
                    : 'The review rejected this plan'}
              </span>
            </div>
          </div>

          {run.approved ? (
            <div className="flex flex-col gap-1">
              <dl className="flex items-baseline justify-between text-micro">
                <dt className="text-faint">Plan Hash</dt>
                <dd className="tabular truncate font-mono text-text" title={run.approvedPlanHash}>
                  {run.approvedPlanHash ?? '—'}
                </dd>
              </dl>
              {run.isolation?.integrationHead ? (
                <dl className="flex items-baseline justify-between text-micro">
                  <dt className="text-faint">Integration Head</dt>
                  <dd
                    className="tabular truncate font-mono text-text"
                    title={run.isolation.integrationHead}
                  >
                    {run.isolation.integrationHead.slice(0, 8)}
                  </dd>
                </dl>
              ) : null}
            </div>
          ) : run.status === 'waiting_for_approval' ? (
            // Operational, as §94 asks: the card that says a plan is ready for
            // review is the card that opens the review. It used to name the
            // button in the header instead, which is a direction, not a control.
            <div className="flex items-center gap-2">
              <ReviewGateButton
                projectId={props.projectId}
                run={run}
                label="Review the plan"
              />
              {/* `text-micro`: this is a caption *beside* a control, in the
                  narrowest card of the row. At 14px it stopped fitting on the
                  line and pushed the button into truncating its own label. */}
              <span className="truncate text-micro text-muted">verdict, findings and hash</span>
            </div>
          ) : (
            <span className="truncate text-label text-muted">
              Request a revision to produce a plan the review can pass.
            </span>
          )}

          {forced ? (
            <p className="text-micro text-warning">
              Approved with --force: the review gate did not hold for this run.
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}

/** Execution summary (§78, UI-18). */
export function ExecutionSummaryCard(props: {
  run: RunDetailView;
  tasks: TaskSummaryView[];
}): JSX.Element {
  const counts = countTasks(props.tasks);
  const withValidation = props.tasks.filter((task) => task.validationPassed !== undefined);
  const passing = withValidation.filter((task) => task.validationPassed === true).length;

  // Requirement coverage as this run can actually observe it: how many distinct
  // requirements the plan's tasks cite. Not the SDD's own total — that lives in
  // the SDD, and a percentage against a denominator we never read would look
  // precise and not be.
  const requirements = new Set(props.tasks.flatMap((task) => task.requirements));

  return (
    <Card
      title="Execution summary"
      footer={
        <span className="flex items-center gap-1">
          {props.run.degradations === 0
            ? 'No capability was lost'
            : `${String(props.run.degradations)} degradation(s) recorded`}
          <ArrowRight className="h-3 w-3" aria-hidden />
        </span>
      }
    >
      <dl className="flex flex-col gap-1.5 py-1">
        <Row
          label="Tasks completed"
          value={`${String(counts.completed)} / ${String(counts.total)}`}
          ratio={counts.total === 0 ? 0 : (counts.completed / counts.total) * 100}
        />
        <Row
          label="Validation passing"
          value={
            withValidation.length === 0
              ? '—'
              : `${String(passing)} / ${String(withValidation.length)}`
          }
          ratio={withValidation.length === 0 ? 0 : (passing / withValidation.length) * 100}
          {...(withValidation.length > 0 && passing < withValidation.length
            ? { tone: 'danger' as const }
            : {})}
        />
        <Row label="Requirements cited" value={String(requirements.size)} />
        <Row
          label="Degradations"
          value={String(props.run.degradations)}
          {...(props.run.degradations > 0 ? { tone: 'warning' as const } : {})}
        />
      </dl>
    </Card>
  );
}

function Dot(): JSX.Element {
  return <span className="text-border-strong">·</span>;
}

function Row(props: {
  label: string;
  value: string;
  ratio?: number;
  tone?: 'danger' | 'warning';
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <dt className="w-32 shrink-0 truncate text-label text-muted">{props.label}</dt>
      <dd
        className={cx(
          'tabular w-14 shrink-0 text-label font-medium',
          props.tone === 'danger' && 'text-danger',
          props.tone === 'warning' && 'text-warning',
          props.tone === undefined && 'text-text',
        )}
      >
        {props.value}
      </dd>
      {/* The bar is hidden below 1280, where the card leaves it about 30px.
          A progress bar that short is not a reading of a ratio, it is a
          smudge — and the number beside it already says the same thing. */}
      {props.ratio === undefined ? null : (
        <Progress
          value={props.ratio}
          tone={props.tone === 'danger' ? 'danger' : 'success'}
          className="hidden flex-1 xl:block"
          label={props.label}
        />
      )}
    </div>
  );
}

/**
 * Model usage (§78, UI-19).
 *
 * Executions, share, retries and fallbacks — and no money anywhere. This is
 * operational telemetry, not billing: the tool measures duration and counts,
 * which it observed, and has no basis for a price, which it did not.
 *
 * Falls back to grouping by *runner* when no model was reported, which is common
 * — the adapters omit the flag when nothing is configured. A donut labelled
 * "unknown 100%" would be worse than one that says what it actually knows.
 */
export function ModelUsageCard(props: { telemetry: TelemetryResponse | undefined }): JSX.Element {
  const summary = props.telemetry?.summary;

  if (summary === undefined || summary.entries === 0) {
    return (
      <Card title="Model usage">
        <Empty title="Nothing has run yet." />
      </Card>
    );
  }

  const byModel = Object.entries(summary.byModel);
  const grouping = byModel.length > 0 ? 'model' : 'runner';
  const buckets = byModel.length > 0 ? byModel : Object.entries(summary.byRunner);
  const total = buckets.reduce((sum, [, bucket]) => sum + bucket.count, 0);

  const data = buckets
    .map(([name, bucket]) => ({
      name,
      value: bucket.count,
      share: total === 0 ? 0 : Math.round((bucket.count / total) * 100),
    }))
    .sort((a, b) => b.value - a.value);

  return (
    <Card
      title="Model usage"
      action={<span className="whitespace-nowrap text-micro text-faint">by {grouping}</span>}
      footer={
        // One line, no wrapping. Four facts on two lines made the shortest card
        // in the row the tallest thing in it.
        // One line, no wrapping. Retries and fallbacks drop below 1280, where
        // the card is ~215px wide and the fourth fact was being sliced through
        // rather than shown — the two that remain are the ones that describe
        // every run, not only a degraded one.
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <span>{String(total)} runs</span>
          <Dot />
          <span>{formatDuration(summary.durationMs)}</span>
          <span className="hidden items-center gap-1.5 xl:flex">
            <Dot />
            <span className={summary.retries > 0 ? 'text-warning' : undefined}>
              {summary.retries} retries
            </span>
            <Dot />
            <span className={summary.fallbacks > 0 ? 'text-warning' : undefined}>
              {summary.fallbacks} fallbacks
            </span>
          </span>
        </span>
      }
    >
      {/* Was a ring in the same five semantic hues the analytics donut used, and
          it fails for the same measured reason: the adjacent pair `info` ↔
          `primary-bright` scores ΔE 1.1 under deuteranopia. In a 68px ring with
          an 8px legend dot, hue is the only channel there is.

          One stacked bar carries the same part-of-whole in a tenth of the
          height, on the neutral magnitude ramp, with every part labelled
          directly — which also gives this card back the vertical space the ring
          was taking from the model names. */}
      <div className="flex h-full min-h-0 flex-col justify-center gap-2 py-1">
        <span
          className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-surface-3"
          role="img"
          aria-label={`Share of executions by ${grouping}: ${data
            .map((entry) => `${entry.name} ${String(entry.share)}%`)
            .join(', ')}`}
        >
          {data.map((entry, index) => (
            <span
              key={entry.name}
              className="block h-full"
              style={{ width: `${String(entry.share)}%`, background: step(index) }}
            />
          ))}
        </span>

        <ul className="flex min-w-0 flex-col">
          {data.slice(0, 4).map((entry, index) => (
            <li key={entry.name} className="flex items-center gap-1.5 py-0.5">
              <span
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{ background: step(index) }}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate text-body-lg text-text" title={entry.name}>
                {entry.name}
              </span>
              <span className="tabular shrink-0 text-body-lg text-muted">
                {entry.share}%{' '}
                {/* The execution count drops below 1280, where the 24px it
                    takes is 24px the model name does not have. The share is
                    the number the legend exists for. */}
                <span className="hidden text-micro text-faint xl:inline">({entry.value})</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
