import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip as ReTooltip } from 'recharts';
import { Check, FileText, X } from 'lucide-react';
import type { ArtifactView, RunDetailView, TaskSummaryView } from '@contracts/index.js';
import type { TelemetryResponse } from '../lib/api';
import { Badge, Card, Empty, cx } from '../components/ui';
import { formatDuration, formatWhen } from '../lib/format';
import { countTasks } from './run-overview';

/**
 * The bottom row of the reference composition (§78).
 *
 * Four cards, equal height, dense. Each answers one question a person asks after
 * looking at the table: what was produced, who opened the gate, did it work, and
 * where did the effort go.
 */

/** Artifacts (§78, UI-16). */
export function ArtifactsCard(props: {
  artifacts: ArtifactView[] | undefined;
  onOpen: (name: string) => void;
}): JSX.Element {
  const available = (props.artifacts ?? []).filter((artifact) => artifact.available);

  return (
    <Card title="Artifacts">
      {available.length === 0 ? (
        <Empty title="Nothing produced yet." />
      ) : (
        <ul className="flex flex-col">
          {available.map((artifact) => (
            <li key={artifact.name}>
              <button
                type="button"
                onClick={() => {
                  props.onOpen(artifact.name);
                }}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-surface-2"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                  <span className="truncate text-body">{artifact.label}</span>
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
 * Shows the hash, because the hash is the guarantee: approval is granted to one
 * specific plan, and a plan that changed afterwards is not the approved one. A
 * card that showed only "approved by you at 19:12" would be describing a
 * property the run may no longer have.
 */
export function ApprovalCard(props: { run: RunDetailView }): JSX.Element {
  const { run } = props;
  const forced = run.degradationDetail.some(
    (degradation) => degradation.kind === 'forced_approval',
  );

  return (
    <Card title="Approval">
      <div className="flex h-full flex-col gap-2 p-3">
        {run.approved ? (
          <>
            <span className="flex items-center gap-1.5 text-body text-success">
              <Check className="h-4 w-4" aria-hidden />
              Approved {formatWhen(run.approvedAt)}
            </span>
            <dl className="flex items-baseline gap-2">
              <dt className="text-label text-faint">Plan hash</dt>
              <dd className="tabular font-mono text-label text-text">
                {run.approvedPlanHash ?? '—'}
              </dd>
            </dl>
            {forced ? (
              <p className="rounded-sm bg-warning-soft px-2 py-1 text-label text-warning">
                Approved with --force, over a failed or missing review. The review
                gate did not hold for this run.
              </p>
            ) : null}
          </>
        ) : run.status === 'waiting_for_approval' ? (
          <>
            <span className="flex items-center gap-1.5 text-body text-warning">
              Plan ready for review.
            </span>
            <p className="text-label text-muted">
              Read the SDD and the plan, then run:
            </p>
            <code className="rounded-sm bg-surface-2 px-2 py-1 font-mono text-label text-text">
              agent-flow approve
            </code>
          </>
        ) : run.status === 'plan_rejected' ? (
          <>
            <span className="flex items-center gap-1.5 text-body text-danger">
              <X className="h-4 w-4" aria-hidden />
              The review rejected this plan.
            </span>
            <code className="rounded-sm bg-surface-2 px-2 py-1 font-mono text-label text-text">
              agent-flow revise &quot;…&quot;
            </code>
          </>
        ) : (
          <Empty title="Not at the gate yet." />
        )}
      </div>
    </Card>
  );
}

/** Execution Summary (§78, UI-18). */
export function ExecutionSummaryCard(props: {
  run: RunDetailView;
  tasks: TaskSummaryView[];
}): JSX.Element {
  const counts = countTasks(props.tasks);
  const withValidation = props.tasks.filter((task) => task.validationPassed !== undefined);
  const passing = withValidation.filter((task) => task.validationPassed === true).length;

  // Requirement coverage as this run can actually observe it: how many distinct
  // requirements the plan's tasks cite. It is not the SDD's own total — that
  // lives in the SDD, and claiming a percentage against a denominator we did not
  // read would be a number that looks precise and is not.
  const requirements = new Set(props.tasks.flatMap((task) => task.requirements));

  return (
    <Card title="Execution summary">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 p-3">
        <Row label="Tasks completed" value={`${String(counts.completed)} / ${String(counts.total)}`} />
        <Row
          label="Validation passing"
          value={
            withValidation.length === 0
              ? '—'
              : `${String(passing)} / ${String(withValidation.length)}`
          }
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

function Row(props: { label: string; value: string; tone?: 'danger' | 'warning' }): JSX.Element {
  return (
    <div className="flex flex-col">
      <dt className="text-label uppercase tracking-wide text-faint">{props.label}</dt>
      <dd
        className={cx(
          'tabular text-body-lg font-medium',
          props.tone === 'danger' && 'text-danger',
          props.tone === 'warning' && 'text-warning',
        )}
      >
        {props.value}
      </dd>
    </div>
  );
}

const SLICE_COLOURS = [
  'var(--af-primary)',
  'var(--af-info)',
  'var(--af-success)',
  'var(--af-warning)',
  'var(--af-danger)',
];

/**
 * Model Usage (§78, UI-19).
 *
 * Executions, share, retries and fallbacks — and no money anywhere. This is
 * operational telemetry, not billing: the tool measures duration and counts,
 * which it observed, and has no basis for a price, which it did not.
 *
 * Falls back to grouping by *runner* when no model was reported. A run where
 * nothing recorded a model is common — the adapters omit the flag when none is
 * configured — and a donut labelled "unknown 100%" would be worse than one that
 * says what it actually knows.
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

  const data = buckets.map(([name, bucket]) => ({
    name,
    value: bucket.count,
    share: total === 0 ? 0 : Math.round((bucket.count / total) * 100),
  }));

  return (
    <Card
      title="Model usage"
      // The qualifier sits with the legend, not in the header: the header is a
      // fixed height and the longer of the two labels pushed the card's own
      // title out of view.
      action={
        <span className="whitespace-nowrap text-label text-faint">
          {grouping === 'runner' ? 'by runner' : 'by model'}
        </span>
      }
    >
      <div className="flex h-full min-h-0 items-center gap-3 p-3">
        <div className="h-20 w-20 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={22}
                outerRadius={38}
                paddingAngle={2}
                stroke="none"
              >
                {data.map((entry, index) => (
                  <Cell
                    key={entry.name}
                    fill={SLICE_COLOURS[index % SLICE_COLOURS.length] as string}
                  />
                ))}
              </Pie>
              <ReTooltip
                contentStyle={{
                  background: 'var(--af-surface-2)',
                  border: '1px solid var(--af-border)',
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Legend content={() => null} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {grouping === 'runner' ? (
            <p className="text-label text-faint">No model was reported by any runner.</p>
          ) : null}
          <ul className="flex flex-col gap-0.5">
            {data.map((entry, index) => (
              <li key={entry.name} className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: SLICE_COLOURS[index % SLICE_COLOURS.length] }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-label">{entry.name}</span>
                <span className="tabular text-label text-muted">{entry.share}%</span>
              </li>
            ))}
          </ul>

          <div className="mt-1 flex flex-wrap gap-1 border-t border-border pt-1.5">
            <Badge>{formatDuration(summary.durationMs)} total</Badge>
            <Badge tone={summary.retries > 0 ? 'warning' : 'muted'}>
              {summary.retries} retries
            </Badge>
            <Badge tone={summary.fallbacks > 0 ? 'warning' : 'muted'}>
              {summary.fallbacks} fallbacks
            </Badge>
          </div>
        </div>
      </div>
    </Card>
  );
}
