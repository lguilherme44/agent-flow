import { Info } from 'lucide-react';
import type {
  AnalyticsView,
  ContextTelemetryAnalyticsView,
  ContextTelemetryObservation,
  MetricBucketView,
} from '@contracts/index.js';
import { useProjectSelection } from '../app/project-context';
import { useAnalytics } from '../lib/queries';
import {
  Empty,
  Panel,
  SectionHeader,
  StripItem,
  Tooltip,
  cx,
} from '../components/ui';
import { formatCompactCount, formatDuration, humanise } from '../lib/format';
import { stageIndex } from '../lib/stages';
import { TONE_DOT, magnitudeStep as step, runToneOf, taskToneOf } from '../lib/status';

/**
 * Analytics (UI-25, §84) — the operational questions, asked afterwards.
 *
 * Everything here is a projection of the state and event files the CLI already
 * writes. No metric is stored for analytics' sake, so there is no third writer to
 * disagree with the two that exist, and no number on this page can be stale in a
 * way `status` is not.
 *
 * Three rules, all of them about not lying:
 *
 * **No cost, anywhere.** Agent Flow observes durations and counts. A price is a
 * guess about a contract between the user and somebody else, and presenting one as
 * fact would be the single most misleading thing this page could do.
 *
 * **"Time per complexity" is time per executor role**, and says so. The router
 * sends a complex task to `executor.complex`, and that decision is what the run
 * recorded. Inferring complexity from anything else would be reporting a routing
 * decision nobody made.
 *
 * It is also a breakdown rather than a separate measurement, and the labels say
 * that too. Telemetry carries one entry per planning stage and one per *task*, and
 * every task entry's stage is `implementation` — so the implementation row in "time
 * per stage" is the sum of exactly the tasks this panel splits by executor. An
 * earlier version of this page claimed implementation was excluded from the stage
 * totals. It never was, and running it against a real run is what showed that.
 *
 * **The scope is stated.** The server aggregates the most recent runs and reports
 * the bound; when history was left out, this page says how much. A chart that
 * describes twenty of two hundred runs while looking like it describes all of them
 * is worse than no chart.
 *
 * Bars rather than charts almost everywhere, and that is a reading decision, not a
 * shortcut. Six recharts panels would be six boxes of equal weight — the card soup
 * the dashboard redesign removed — and a horizontal bar with its number printed
 * beside it is both denser and easier to compare than a plot of the same data. The
 * one donut is where a part-of-whole genuinely reads better than a list.
 */
export function AnalyticsPage(): JSX.Element {
  const { projectId } = useProjectSelection();
  const analytics = useAnalytics(projectId);

  if (analytics.isError) {
    return (
      <Empty
        title="Analytics could not be read."
        hint={analytics.error instanceof Error ? analytics.error.message : undefined}
      />
    );
  }

  if (analytics.data === undefined) {
    return <Empty title={analytics.isLoading ? 'Reading history…' : 'Nothing to show.'} />;
  }

  const data = analytics.data;

  if (data.scope.runsConsidered === 0) {
    return (
      <Empty
        title="Nothing to measure yet."
        hint={
          <>
            Analytics is derived from finished work. Run{' '}
            <code className="font-mono">agent-flow feature &quot;…&quot;</code> first.
          </>
        }
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto">
      <Totals data={data} />

      <div className="grid shrink-0 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <MetricPanel
          title="Time per stage"
          note="implementation is every task, summed"
          explain="Each planning stage runs once. Implementation runs once per task, and its row here is all of them together — the panel below breaks that same total down by the executor role each task was routed to."
          buckets={orderedByStage(data.byStage)}
          measure="duration"
        />
        <DistributionPanel data={data} />
      </div>

      <div className="grid shrink-0 grid-cols-1 gap-3 xl:grid-cols-3">
        <MetricPanel
          title="Time per complexity"
          note="by executor role"
          explain="The implementation row above, broken down. The router sends a complex task to executor.complex, and that decision is what the run recorded — inferring complexity any other way would report a routing decision nobody made."
          buckets={data.byRole.filter((bucket) => bucket.key.startsWith('executor.'))}
          measure="duration"
          rename={(key) => key.replace('executor.', '')}
        />
        <RunsPerProject data={data} />
        <TasksByState data={data} />
      </div>

      <ExecutionInsightsPanel data={data} />

      {data.context === undefined ? null : <ContextIntelligencePanel data={data.context} />}
    </div>
  );
}

/**
 * Deterministic facts about execution history.
 *
 * Generated entirely from closed observations and counts — no model prose,
 * no causal claims, no guesses.
 */
function ExecutionInsightsPanel(props: { data: AnalyticsView }): JSX.Element {
  const { data } = props;
  const insights: string[] = [];

  insights.push(
    `${data.totals.entries} total agent invocations observed across ${data.scope.runsConsidered} runs.`,
  );

  if (data.totals.retries > 0) {
    insights.push(
      `${data.totals.retries} ${data.totals.retries === 1 ? 'retry was' : 'retries were'} observed across runs.`,
    );
  } else {
    insights.push('0 retries were observed.');
  }

  if (data.totals.failures > 0) {
    insights.push(
      `${data.totals.failures} ${data.totals.failures === 1 ? 'failure was' : 'failures were'} recorded.`,
    );
  } else {
    insights.push('0 failures were recorded.');
  }

  if (data.totals.fallbacks > 0) {
    insights.push(
      `${data.totals.fallbacks} ${data.totals.fallbacks === 1 ? 'fallback was' : 'fallbacks were'} triggered due to primary runner errors.`,
    );
  }

  if (data.context?.outcomes) {
    const outcomes = data.context.outcomes;
    const bypassed = outcomes.bypassedObservations;
    const delivered = outcomes.deliveredAdvisories;
    insights.push(
      `${outcomes.utilityCalls} Utility model invocation${outcomes.utilityCalls === 1 ? '' : 's'} recorded — ${delivered} delivered, ${bypassed} bypassed of ${outcomes.observations} observations.`,
    );
    if (bypassed > 0) {
      const [top] = outcomes.bypassReasons;
      if (top !== undefined) {
        insights.push(
          `${top.count} of ${bypassed} bypass${bypassed === 1 ? '' : 'es'} were ${humanise(top.reason).toLowerCase()}.`,
        );
      }
    }
  }
  if (
    data.context?.aggregate?.utilityLatencyMs !== undefined &&
    data.context.aggregate.utilityLatencyMs > 0
  ) {
    insights.push(
      `Utility inference contributed ${formatDuration(data.context.aggregate.utilityLatencyMs)} of observed latency.`,
    );
  }

  return (
    <Panel
      divided
      className="shrink-0"
      header={
        <SectionHeader title="Execution Insights">
          <span className="text-micro text-faint">deterministic summary · closed observations</span>
        </SectionHeader>
      }
    >
      <div className="flex flex-col gap-2 px-4 pb-3 pt-1">
        <ul className="m-0 list-disc pl-4 text-body-lg text-muted space-y-1">
          {insights.map((insight, idx) => (
            <li key={idx}>
              <span className="text-text">{insight}</span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

/**
 * What Context Intelligence did, operationally — the part of §23 that can be
 * measured rather than claimed.
 *
 * Estimates, and says so. The adapter counts a provider-independent estimate of
 * the tokens it assembled and the tokens that actually left, and the reader
 * subtracts the second from the first. No number on this page is a bill, and none
 * claims to be: the header and the basis row say so, the way every other claim on
 * the page has a guardrail around it.
 */
function ContextIntelligencePanel(props: { data: ContextTelemetryAnalyticsView }): JSX.Element {
  const { data } = props;
  const aggregate = data.aggregate;
  const outcomes = data.outcomes;
  const scope = data.scope;

  // Delivery is counted per observation from closed facts, never derived from
  // overlapping aggregate counters. `(utilityCalls - failures) / utilityCalls`
  // was the old math: a single failed call that recorded both utilityFailures
  // and structuredOutputFailures looked like two, and a bypass that never called
  // the model looked like one that had.
  const deliveryRate =
    outcomes !== undefined && outcomes.observations > 0
      ? `${Math.round((outcomes.deliveredAdvisories / outcomes.observations) * 100)}%`
      : 'Delivery rate unavailable';
  const utilityCalls = outcomes?.utilityCalls ?? aggregate?.utilityCalls;

  return (
    <Panel
      divided
      className="shrink-0"
      header={
        <SectionHeader title="Context intelligence">
          <div className="flex items-center gap-2">
            <span className="rounded-sm border border-primary-border bg-primary-soft px-1.5 py-0.5 text-micro font-semibold uppercase tracking-caps text-text">
              ESTIMATED · NOT BILLING
            </span>
          </div>
        </SectionHeader>
      }
    >
      {aggregate === undefined && outcomes === undefined ? (
        <Empty
          title="Telemetry recorded, none aggregated."
          hint="Adaptive run telemetry could not be summed — check the run audit trail."
        />
      ) : (
        <div className="flex flex-col gap-3 pb-3">
          {/* Funnel & Outcome Summary */}
          <div className="flex flex-wrap items-stretch divide-x divide-border px-4 pt-1">
            {aggregate?.candidatesBefore !== undefined ? (
              <StripItem label="Candidates Before" value={String(aggregate.candidatesBefore)} />
            ) : null}
            {aggregate?.candidatesAfter !== undefined ? (
              <StripItem label="Candidates Selected" value={String(aggregate.candidatesAfter)} />
            ) : null}
            {aggregate?.filesBefore !== undefined ? (
              <StripItem label="Files Before" value={String(aggregate.filesBefore)} />
            ) : null}
            {aggregate?.filesAfter !== undefined ? (
              <StripItem label="Files Selected" value={String(aggregate.filesAfter)} />
            ) : null}
            <StripItem label="Utility calls" value={countLabel(utilityCalls)} />
            {outcomes === undefined ? null : (
              <>
                <StripItem
                  label="Delivered advisories"
                  value={String(outcomes.deliveredAdvisories)}
                />
                <StripItem
                  label="Bypassed"
                  value={String(outcomes.bypassedObservations)}
                  {...(outcomes.bypassedObservations > 0
                    ? { tone: 'warning' as const }
                    : {})}
                />
              </>
            )}
            <StripItem
              label="Delivery Rate"
              value={deliveryRate}
              {...(deliveryRate === 'Delivery rate unavailable' ? { tone: 'muted' as const } : {})}
            />
            {aggregate?.utilityLatencyMs !== undefined ? (
              <StripItem label="Utility latency" value={formatDuration(aggregate.utilityLatencyMs)} />
            ) : null}
          </div>

          {/* Token Estimates Strip */}
          {aggregate === undefined ? null : (
            <div className="flex flex-wrap items-stretch divide-x divide-border border-t border-border px-4 pt-2">
              <StripItem
                label="Estimated input"
                value={tokenLabel(aggregate.estimatedInputTokens)}
              />
              <StripItem
                label="Primary context"
                value={tokenLabel(
                  aggregate.estimatedPrimaryContextTokens ?? aggregate.estimatedCompressedTokens,
                )}
              />
              <StripItem
                label="Estimated avoided"
                value={tokenLabel(aggregate.estimatedAvoidedTokens)}
              />
            </div>
          )}

          {/* Bypass / Degradation Breakdown — from the outcomes histogram, which
              preserves duplicates, never from the aggregate's single bypassReason
              ("1 occurrence" was a number with a denominator of one). */}
          {outcomes !== undefined && outcomes.bypassedObservations > 0 ? (
            <div className="mx-4 rounded-md border border-warning/30 bg-warning-soft/40 p-3 text-label text-text">
              <span className="font-medium text-warning mb-1 block">Bypass Reason Breakdown</span>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-micro">
                {outcomes.bypassReasons.map((entry) => (
                  <div key={entry.reason} className="flex items-center justify-between">
                    <dt className="text-muted">{humanise(entry.reason)}</dt>
                    <dd className="font-mono font-semibold text-text">
                      {entry.count} occurrence{entry.count === 1 ? '' : 's'}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          {/* Scope and Metadata */}
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-border px-4 pt-2.5 text-micro text-faint">
            <span>
              {scope.runsObserved} run{scope.runsObserved === 1 ? '' : 's'} observed ·{' '}
              {scope.observations} of {scope.observationLimit} observations
            </span>
            {aggregate === undefined || effectiveIdentity(aggregate) === undefined ? null : (
              <span>
                effective {aggregate.effectiveProvider} · {aggregate.effectiveModel}
              </span>
            )}
            {scope.truncated ? (
              <span className="flex items-center gap-1 text-warning">
                <Info className="h-3 w-3" aria-hidden />
                older observations excluded{scope.eventLogsTruncated > 0 ? '; some event logs cut' : ''}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </Panel>
  );
}

function tokenLabel(value: number | undefined): string {
  return value === undefined
    ? '—'
    : `${formatCompactCount(value)} token${value === 1 ? '' : 's'}`;
}

function countLabel(value: number | undefined): string {
  return value === undefined ? '—' : String(value);
}

function effectiveIdentity(
  aggregate: ContextTelemetryObservation,
): { provider: string; model: string } | undefined {
  if (aggregate.effectiveProvider === undefined || aggregate.effectiveModel === undefined) {
    return undefined;
  }
  return { provider: aggregate.effectiveProvider, model: aggregate.effectiveModel };
}

/**
 * The counts, as a strip inside one panel header.
 *
 * Six bordered cards would be the pattern this design removed. The strip is the
 * same six numbers at a fifth of the height, and the height goes to the panels
 * that hold comparisons.
 */
function Totals(props: { data: AnalyticsView }): JSX.Element {
  const { scope, totals } = props.data;

  return (
    <Panel
      className="shrink-0"
      header={
        <SectionHeader title="Analytics">
          {scope.truncated ? (
            <Tooltip
              content={
                <span>
                  Every number on this page covers the {scope.runsConsidered} most recent runs
                  of {scope.runsAvailable}. Older history is excluded, not summarised.
                </span>
              }
            >
              <span className="flex items-center gap-1 rounded-sm bg-warning-soft px-1.5 py-px text-micro font-medium text-warning">
                <Info className="h-3 w-3" aria-hidden />
                {scope.runsConsidered} of {scope.runsAvailable} runs
              </span>
            </Tooltip>
          ) : (
            <span className="text-micro text-faint">
              all {scope.runsAvailable} run{scope.runsAvailable === 1 ? '' : 's'} ·{' '}
              {scope.projectIds.length} project{scope.projectIds.length === 1 ? '' : 's'}
            </span>
          )}
        </SectionHeader>
      }
    >
      <div className="flex flex-wrap items-stretch divide-x divide-border px-4 pb-3">
        <StripItem label="Runs" value={scope.runsConsidered} />
        <StripItem label="Agent calls" value={totals.entries} />
        <StripItem label="Total time" value={formatDuration(totals.durationMs)} />
        <StripItem
          label="Failures"
          value={totals.failures}
          {...(totals.failures > 0 ? { tone: 'danger' as const } : {})}
        />
        <StripItem
          label="Retries"
          value={totals.retries}
          {...(totals.retries > 0 ? { tone: 'warning' as const } : {})}
        />
        <StripItem
          label="Fallbacks"
          value={totals.fallbacks}
          {...(totals.fallbacks > 0 ? { tone: 'warning' as const } : {})}
        />
        <StripItem
          label="Effort clamped"
          value={totals.reasoningClamped}
          {...(totals.reasoningClamped > 0 ? { tone: 'warning' as const } : {})}
        />
      </div>
    </Panel>
  );
}

/**
 * A ranked bar list.
 *
 * The bar is a proportion of the largest value, not of the total: these are
 * comparisons between rows, and scaling to the sum makes every bar short as soon
 * as there are more than three of them.
 */
function MetricPanel(props: {
  title: string;
  /** Short enough for the header. The explanation goes in `explain`. */
  note?: string;
  explain?: string;
  buckets: MetricBucketView[];
  measure: 'duration' | 'count';
  rename?: (key: string) => string;
}): JSX.Element {
  const max = Math.max(
    1,
    ...props.buckets.map((bucket) =>
      props.measure === 'duration' ? bucket.durationMs : bucket.count,
    ),
  );

  return (
    <Panel
      divided
      header={
        <SectionHeader title={props.title}>
          {props.note === undefined ? null : props.explain === undefined ? (
            <span className="truncate text-micro text-faint">{props.note}</span>
          ) : (
            <Tooltip content={<span>{props.explain}</span>}>
              <span className="shrink-0 cursor-default border-b border-dashed border-border-strong text-micro text-faint">
                {props.note}
              </span>
            </Tooltip>
          )}
        </SectionHeader>
      }
    >
      {props.buckets.length === 0 ? (
        // "not available" rather than a zero: nothing has produced this metric,
        // which is different from it being zero.
        <Empty title="Not available yet." hint="Nothing in this history recorded it." />
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto px-4 py-2.5">
          {props.buckets.map((bucket) => {
            const value = props.measure === 'duration' ? bucket.durationMs : bucket.count;

            return (
              <li key={bucket.key} className="flex flex-col gap-1 py-1.5">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-label capitalize text-text">
                    {props.rename === undefined ? humanise(bucket.key) : props.rename(bucket.key)}
                  </span>
                  <span className="tabular shrink-0 text-body-lg text-muted">
                    {props.measure === 'duration'
                      ? formatDuration(bucket.durationMs)
                      : bucket.count}
                    <span className="ml-1.5 text-micro text-faint">
                      {props.measure === 'duration'
                        ? `${bucket.count} call${bucket.count === 1 ? '' : 's'}`
                        : ''}
                    </span>
                  </span>
                </span>
                {/* The bar measures time and nothing else. Colouring it by
                    failures made a stage with one bad call out of twenty-three
                    look entirely red — two dimensions in one mark, and the
                    louder one wins. The failure count below carries that. */}
                {/* Steel, not violet. Eight rows painted in the accent made the
                    accent the page's background texture, and magnitude is not a
                    status — it belongs on the neutral axis. */}
                <span className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                  <span
                    className="block h-full rounded-full bg-scale-4"
                    style={{ width: `${String(Math.max(2, (value / max) * 100))}%` }}
                  />
                </span>
                {bucket.failures === 0 && bucket.retries === 0 && bucket.fallbacks === 0 ? null : (
                  <span className="flex gap-2 text-micro text-warning">
                    {bucket.failures > 0 ? <span>{bucket.failures} failed</span> : null}
                    {bucket.retries > 0 ? <span>{bucket.retries} retried</span> : null}
                    {bucket.fallbacks > 0 ? <span>{bucket.fallbacks} fell back</span> : null}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/**
 * Model distribution, and runner distribution beneath it.
 *
 * Share-of-total as one stacked bar with its parts labelled directly, not as a
 * ring. The ring was the only mark on the page where colour was the sole
 * channel — an 8px dot and a name — which is exactly where the closest pair in
 * the old palette did the most damage. A stacked bar carries the same
 * part-of-whole, reads at a glance, and costs a fifth of the height; the ranked
 * list under it answers "how many" and "how long", which a ring never could.
 *
 * Falls back to grouping by runner when no adapter reported a model — common in
 * practice, since a role that pins no model leaves the flag off — and says which
 * grouping it used.
 */
function DistributionPanel(props: { data: AnalyticsView }): JSX.Element {
  const { byModel, byRunner } = props.data;
  const grouping = byModel.length > 0 ? 'model' : 'runner';
  const buckets = byModel.length > 0 ? byModel : byRunner;
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);

  const slices = [...buckets]
    .sort((a, b) => b.count - a.count)
    .map((bucket) => ({
      name: bucket.key,
      value: bucket.count,
      share: total === 0 ? 0 : Math.round((bucket.count / total) * 100),
    }));

  return (
    <Panel
      divided
      header={
        <SectionHeader title="Distribution">
          <span className="whitespace-nowrap text-micro text-faint">by {grouping}</span>
        </SectionHeader>
      }
    >
      {slices.length === 0 ? (
        <Empty title="Not available yet." />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3">
          {/* A 2px surface gap between segments, so two adjacent steps of one
              ramp never read as a single wider segment. */}
          <span
            className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-surface-3"
            role="img"
            aria-label={`Share of agent calls by ${grouping}: ${slices
              .map((slice) => `${slice.name} ${String(slice.share)}%`)
              .join(', ')}`}
          >
            {slices.map((slice, index) => (
              <span
                key={slice.name}
                className="block h-full"
                style={{ width: `${String(slice.share)}%`, background: step(index) }}
              />
            ))}
          </span>

          {/* One list, not a legend plus a list. The first pass named every
              model twice in the same panel — which is the redundancy this page
              exists to remove, and a screen reader read it twice. The swatch
              carries the order back to the bar; the row carries the identity,
              the share and the count. */}
          <ul className="flex flex-col">
            {slices.map((slice, index) => (
              <li
                key={slice.name}
                className="flex items-baseline justify-between gap-2 border-t border-border py-1.5"
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span
                    className="h-2 w-2 shrink-0 rounded-sm"
                    style={{ background: step(index) }}
                    aria-hidden
                  />
                  <span className="truncate text-body-lg text-text" title={slice.name}>
                    {slice.name}
                  </span>
                </span>
                <span className="tabular shrink-0 text-body-lg text-muted">
                  {slice.share}%
                  <span className="ml-1.5 text-micro text-faint">{slice.value} calls</span>
                </span>
              </li>
            ))}
          </ul>

          {/* Runner distribution as a footnote to the model one, since the same
              runner serves several models and the two answer different questions:
              which model did the work, and which provider actually executed it. */}
          {grouping === 'model' && byRunner.length > 0 ? (
            <div className="flex flex-col gap-1 border-t border-border pt-2.5">
              <span className="text-micro uppercase tracking-caps text-faint">By runner</span>
              {byRunner.map((bucket) => (
                <span key={bucket.key} className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-body-lg text-text">{bucket.key}</span>
                  <span className="tabular shrink-0 text-micro text-muted">
                    {bucket.count} · {formatDuration(bucket.durationMs)}
                  </span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

function RunsPerProject(props: { data: AnalyticsView }): JSX.Element {
  const rows = props.data.runsByProject.filter((entry) => entry.total > 0);

  return (
    <Panel
      divided
      header={<SectionHeader title="Runs per project" />}
    >
      {rows.length === 0 ? (
        <Empty title="Not available yet." />
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto px-4 py-2.5">
          {rows.map((entry) => (
            <li key={entry.projectId} className="flex flex-col gap-1 py-1.5">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-body-lg text-text">{entry.projectId}</span>
                <span className="tabular shrink-0 text-body-lg text-muted">{entry.total}</span>
              </span>
              {/* Stacked by status, so "twelve runs" and "twelve runs, four
                  failed" do not look the same. */}
              <span className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                {Object.entries(entry.byStatus).map(([status, count]) => (
                  <span
                    key={status}
                    className={cx('block h-full', TONE_DOT[runToneOf(status)])}
                    style={{ width: `${String((count / entry.total) * 100)}%` }}
                    title={`${humanise(status)}: ${String(count)}`}
                  />
                ))}
              </span>
              <span className="flex flex-wrap gap-2 text-micro text-faint">
                {Object.entries(entry.byStatus).map(([status, count]) => (
                  <span key={status}>
                    {count} {humanise(status).toLowerCase()}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function TasksByState(props: { data: AnalyticsView }): JSX.Element {
  const entries = Object.entries(props.data.tasksByState).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);

  return (
    <Panel divided header={<SectionHeader title="Tasks by status" />}>
      {entries.length === 0 ? (
        <Empty title="Not available yet." />
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto px-4 py-2.5">
          {entries.map(([state, count]) => (
            <li key={state} className="flex flex-col gap-1 py-1.5">
              <span className="flex items-baseline justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={cx('h-2 w-2 shrink-0 rounded-full', TONE_DOT[taskToneOf(state)])}
                    aria-hidden
                  />
                  <span className="truncate text-label capitalize text-text">
                    {humanise(state)}
                  </span>
                </span>
                <span className="tabular shrink-0 text-body-lg text-muted">
                  {count}
                  <span className="ml-1.5 text-micro text-faint">
                    {total === 0 ? '' : `${String(Math.round((count / total) * 100))}%`}
                  </span>
                </span>
              </span>
              <span className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                <span
                  className={cx('block h-full rounded-full', TONE_DOT[taskToneOf(state)])}
                  style={{ width: `${String(Math.max(2, (count / Math.max(1, total)) * 100))}%` }}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * Stage buckets in pipeline order rather than by duration.
 *
 * The one aggregate where order carries meaning: "where does the time go" is read
 * against the sequence the run went through, and sorting discovery after planning
 * because it happened to be slower breaks the shape a reader is looking for.
 */
function orderedByStage(buckets: readonly MetricBucketView[]): MetricBucketView[] {
  return [...buckets].sort((a, b) => stageIndex(a.key) - stageIndex(b.key));
}
