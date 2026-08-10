import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { Info } from 'lucide-react';
import type { AnalyticsView, MetricBucketView } from '@contracts/index.js';
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
import { formatDuration, humanise } from '../lib/format';
import { stageIndex } from '../lib/stages';
import { TONE_DOT, runToneOf, taskToneOf } from '../lib/status';

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
          note="planning stages only"
          explain="The implementation stage is absent on purpose: it runs once per task, and every one of those is already counted under time per complexity. Including both would double every implementation call in every total."
          buckets={orderedByStage(data.byStage)}
          measure="duration"
        />
        <DistributionPanel data={data} />
      </div>

      <div className="grid shrink-0 grid-cols-1 gap-3 xl:grid-cols-3">
        <MetricPanel
          title="Time per complexity"
          note="by executor role"
          explain="The router sends a complex task to executor.complex, and that decision is what the run recorded. Inferring complexity any other way would report a routing decision nobody made."
          buckets={data.byRole.filter((bucket) => bucket.key.startsWith('executor.'))}
          measure="duration"
          rename={(key) => key.replace('executor.', '')}
        />
        <RunsPerProject data={data} />
        <TasksByState data={data} />
      </div>
    </div>
  );
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
                  <span className="tabular shrink-0 text-label text-muted">
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
                <span className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                  <span
                    className="block h-full rounded-full bg-primary-bright"
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

const SLICE_COLOURS = [
  'var(--af-primary-bright)',
  'var(--af-info)',
  'var(--af-warning)',
  'var(--af-success)',
  'var(--af-danger)',
];

/**
 * Model distribution, and runner distribution beneath it.
 *
 * The one donut on the page, because share-of-total is what it answers and a
 * part-of-whole is the one shape a ring reads better than a list. Falls back to
 * grouping by runner when no adapter reported a model — common in practice, since
 * a role that pins no model leaves the flag off — and says which grouping it used.
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
          <div className="flex items-center gap-3">
            <div className="h-[84px] w-[84px] shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                  <Pie
                    data={slices}
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
                    {slices.map((slice, index) => (
                      <Cell
                        key={slice.name}
                        fill={SLICE_COLOURS[index % SLICE_COLOURS.length] as string}
                      />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>

            <ul className="flex min-w-0 flex-1 flex-col gap-1">
              {slices.slice(0, 5).map((slice, index) => (
                <li key={slice.name} className="flex items-center gap-1.5 text-label">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: SLICE_COLOURS[index % SLICE_COLOURS.length] }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-text" title={slice.name}>
                    {slice.name}
                  </span>
                  <span className="tabular shrink-0 text-micro text-muted">
                    {slice.share}% ({slice.value})
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Runner distribution as a footnote to the model one, since the same
              runner serves several models and the two answer different questions:
              which model did the work, and which provider actually executed it. */}
          {grouping === 'model' && byRunner.length > 0 ? (
            <div className="flex flex-col gap-1 border-t border-border pt-2.5">
              <span className="text-micro uppercase tracking-wide text-faint">By runner</span>
              {byRunner.map((bucket) => (
                <span key={bucket.key} className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-label text-text">{bucket.key}</span>
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
                <span className="truncate text-label text-text">{entry.projectId}</span>
                <span className="tabular shrink-0 text-label text-muted">{entry.total}</span>
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
                <span className="tabular shrink-0 text-label text-muted">
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
