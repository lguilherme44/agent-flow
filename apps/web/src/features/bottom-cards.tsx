import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { ArrowRight, Check, CircleAlert, FileText, X } from 'lucide-react';
import type { ArtifactView, RunDetailView, TaskSummaryView } from '@contracts/index.js';
import type { TelemetryResponse } from '../lib/api';
import { Card, Empty, Progress, cx } from '../components/ui';
import { formatDuration, formatWhen } from '../lib/format';
import { countTasks } from './run-overview';

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
export function ApprovalCard(props: { run: RunDetailView }): JSX.Element {
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
      footer={
        run.approved ? (
          <span>Bound to this exact plan — a revision reopens the gate</span>
        ) : (
          <span>Approve, reject and revise stay with the CLI</span>
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
              <span
                className={cx(
                  'text-label font-semibold tracking-wide',
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
            <dl className="flex items-baseline gap-2">
              <dt className="text-micro text-faint">Hash</dt>
              <dd className="tabular truncate font-mono text-micro text-text">
                {run.approvedPlanHash ?? '—'}
              </dd>
            </dl>
          ) : (
            <code className="truncate rounded-sm border border-border bg-surface-2 px-2 py-1 font-mono text-micro text-muted">
              {run.status === 'waiting_for_approval'
                ? 'agent-flow approve'
                : 'agent-flow revise "…"'}
            </code>
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

const SLICE_COLOURS = [
  'var(--af-primary-bright)',
  'var(--af-info)',
  'var(--af-warning)',
  'var(--af-success)',
  'var(--af-danger)',
];

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
      <div className="flex h-full min-h-0 items-center gap-3 py-1">
        {/* A thick ring rather than a default thin one, so the chart reads as a
            deliberate piece of the design instead of a library placed in a box. */}
        {/* Smaller below 1440, where the legend needs the width more than the
            ring needs the diameter. */}
        <div className="h-[68px] w-[68px] shrink-0 wide:h-[84px] wide:w-[84px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={24}
                outerRadius={41}
                paddingAngle={1.5}
                stroke="none"
                isAnimationActive={false}
              >
                {data.map((entry, index) => (
                  <Cell
                    key={entry.name}
                    fill={SLICE_COLOURS[index % SLICE_COLOURS.length] as string}
                  />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>

        <ul className="flex min-w-0 flex-1 flex-col gap-1">
          {data.slice(0, 4).map((entry, index) => (
            <li key={entry.name} className="flex items-center gap-1.5">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: SLICE_COLOURS[index % SLICE_COLOURS.length] }}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate text-label text-text" title={entry.name}>
                {entry.name}
              </span>
              <span className="tabular shrink-0 text-label text-muted">
                {entry.share}%{' '}
                {/* The execution count drops below 1280, where the 24px it
                    takes is 24px the model name does not have. The share is
                    the number the legend exists for. */}
                <span className="hidden text-faint xl:inline">({entry.value})</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
