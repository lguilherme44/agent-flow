import { useEffect, useState } from 'react';
import type { AnalyticsView, MetricBucketView, ProjectView } from '@contracts/index.js';
import { api, keys } from '../../lib/api';
import { useResource } from '../../lib/store';
import { formatDuration } from '../../lib/time';
import { runtimeTone } from '../../lib/tone';
import { useT, word } from '../../lib/i18n';
import { Chip, Empty, Meter, NoProjectsYet, Notice, Skeleton, Stat } from '../../components/ui';

/**
 * Aggregates over recent runs (7.4).
 *
 * `/analytics` has been served since M8 and Deck drew none of it, so "what does this
 * workspace actually spend its time on" was a `--classic` question.
 *
 * **No monetary figure appears, at any level, and that is a declared decision.** A
 * subscriber pays a flat fee and a provider's per-token rate is not a bill; a total here
 * would be a number nobody is charging. Time, counts and outcomes are what the runs
 * actually record, so time, counts and outcomes are what this draws.
 *
 * The scope line is not decoration: the server answers over a bounded number of recent
 * runs, and a chart that silently described twenty of two hundred would be lying about
 * its own subject.
 */
export function AnalyticsPage({ projectId }: { projectId?: string }) {
  const t = useT();
  const projects = useResource<ProjectView[]>(keys.projects(), api.projects);
  const [selected, setSelected] = useState<string | undefined>(projectId);
  const [limit, setLimit] = useState(50);

  useEffect(() => {
    setSelected(projectId);
  }, [projectId]);

  // Not fetched at all until there is something to aggregate. With no project the route
  // has no primary to resolve and answers 404, and the page used to read that as "could
  // not be read" — which is a failure, and this is an absence.
  const nothingYet = !projects.loading && (projects.data?.length ?? 0) === 0;
  const analytics = useResource<AnalyticsView>(
    nothingYet ? null : keys.analytics(selected, limit),
    () => api.analytics(selected, limit),
  );

  if (nothingYet) {
    return (
      <main className="page">
        <NoProjectsYet what={t.analytics.aggregateVerb} />
      </main>
    );
  }
  if (analytics.error !== undefined) {
    return (
      <main className="page">
        <Empty error>{t.analytics.couldNotRead}</Empty>
      </main>
    );
  }

  const data = analytics.data;

  return (
    <main className="page">
      <div className="page-head crew-head">
        <div>
          <span className="eyebrow">{t.nav.analytics}</span>
          <h1 className="page-head__title">{t.analytics.title}</h1>
          <p className="page-head__sub">
            {data === undefined
              ? t.analytics.readingRuns
              : t.analytics.scope(data.scope.runsConsidered, data.scope.runsAvailable, data.scope.truncated)}
          </p>
        </div>
        <div className="analytics-controls">
          <label className="crew-control">
            {t.common.project}
            <select
              className="input"
              value={selected ?? ''}
              onChange={(event) => setSelected(event.target.value === '' ? undefined : event.target.value)}
            >
              <option value="">{t.analytics.everyProject}</option>
              {projects.data?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="crew-control">
            {t.analytics.recentRuns}
            <select className="input" value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
              {[10, 25, 50, 100, 200].map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {data === undefined ? (
        <Skeleton rows={8} />
      ) : data.totals.entries === 0 ? (
        <Empty hint={t.analytics.foldHint}>
          {t.analytics.noStageRan}
        </Empty>
      ) : (
        <>
          <div className="telemetry__totals" aria-label={t.telemetry.totals}>
            <Stat label={t.telemetry.stagesAndTasks} value={String(data.totals.entries)} />
            <Stat label={t.telemetry.totalTime} value={formatDuration(data.totals.durationMs)} />
            <Stat label={t.telemetry.failures} value={String(data.totals.failures)} tone={data.totals.failures > 0 ? 'bad' : undefined} />
            <Stat label={t.telemetry.retries} value={String(data.totals.retries)} tone={data.totals.retries > 0 ? 'warn' : undefined} />
            <Stat label={t.telemetry.fellBack} value={String(data.totals.fallbacks)} tone={data.totals.fallbacks > 0 ? 'warn' : undefined} />
            <Stat
              label={t.telemetry.belowEffort}
              value={String(data.totals.reasoningClamped)}
              tone={data.totals.reasoningClamped > 0 ? 'warn' : undefined}
            />
          </div>

          <Outcomes data={data} />

          <Buckets title={t.telemetry.byStage} rows={data.byStage} total={data.totals.durationMs} />
          <Buckets title={t.telemetry.byRunner} rows={data.byRunner} total={data.totals.durationMs} />
          <Buckets
            title={t.telemetry.byModel}
            rows={data.byModel}
            total={data.totals.durationMs}
            empty={t.analytics.noModelReported}
          />
          <Buckets title={t.analytics.byRole} rows={data.byRole} total={data.totals.durationMs} />

          <Notice tone="ghost" k={t.analytics.noFiguresKey}>
            {t.analytics.noFigures}
          </Notice>
        </>
      )}
    </main>
  );
}

/** How runs ended, and how their tasks did. Two different questions, both counts. */
function Outcomes({ data }: { data: AnalyticsView }) {
  const t = useT();
  const tasks = Object.entries(data.tasksByState).sort((a, b) => b[1] - a[1]);

  return (
    <section className="doctor-section" aria-label={t.analytics.outcomes}>
      <div className="doctor-section__head">
        <h3>{t.analytics.outcomes}</h3>
      </div>

      <ul className="doctor-list">
        {data.runsByProject.map((project) => (
          <li key={project.projectId} className="doctor-row" data-project={project.projectId}>
            <span className="doctor-row__name">{project.projectId}</span>
            <span className="doctor-row__value analytics-statuses">
              {Object.entries(project.byStatus)
                .sort((a, b) => b[1] - a[1])
                .map(([status, count]) => (
                  <Chip key={status} tone={runtimeTone(status)}>
                    {String(count)} {word(t, status)}
                  </Chip>
                ))}
            </span>
            <span className="doctor-row__value">
              {t.runs.runCount(project.total)}
            </span>
          </li>
        ))}
      </ul>

      {tasks.length === 0 ? null : (
        <p className="doctor-finding analytics-statuses" data-tone="idle">
          {tasks.map(([state, count]) => (
            <Chip key={state} tone={runtimeTone(state)}>
              {String(count)} {word(t, state)}
            </Chip>
          ))}
        </p>
      )}
    </section>
  );
}

function Buckets({
  title,
  rows,
  total,
  empty,
}: {
  title: string;
  rows: readonly MetricBucketView[];
  total: number;
  empty?: string;
}) {
  const t = useT();
  const sorted = [...rows].sort((a, b) => b.durationMs - a.durationMs);

  return (
    <section className="doctor-section" aria-label={title}>
      <div className="doctor-section__head">
        <h3>{title}</h3>
      </div>
      {sorted.length === 0 ? (
        <p className="doctor-note">{empty ?? t.telemetry.nothingToShow}</p>
      ) : (
        <ul className="doctor-list">
          {sorted.map((bucket) => (
            <li key={bucket.key} className="telemetry-row">
              <span className="doctor-row__name">{word(t, bucket.key)}</span>
              <Meter
                label={formatDuration(bucket.durationMs)}
                done={bucket.durationMs}
                total={total === 0 ? 1 : total}
                tone={bucket.failures > 0 ? 'bad' : 'live'}
              />
              <span className="doctor-row__value">
                {t.telemetry.calls(bucket.count)}
                {bucket.retries > 0 ? ` · ${t.telemetry.retried(bucket.retries)}` : ''}
                {bucket.failures > 0 ? ` · ${t.telemetry.failed(bucket.failures)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
