import { useMemo, useState } from 'react';
import type { RunSummaryView } from '@contracts/index.js';
import { featureTitle } from '@contracts/feature-title.js';
import { api, keys } from '../../lib/api';
import { useResource } from '../../lib/store';
import { formatDuration, formatRelative } from '../../lib/time';
import { runStatusTone } from '../../lib/tone';
import { useT, word } from '../../lib/i18n';
import { useNow } from '../../lib/use-now';
import { Chip, Empty, Meter, Skeleton } from '../../components/ui';
import { href, navigate, onLinkClick } from '../../app/router';
import { NewFeatureDialog } from '../deck/NewFeatureDialog';

/** History. Filters are local: narrowing the list costs no round trip. */
export function RunsPage({ projectId }: { projectId?: string }) {
  const t = useT();
  const runs = useResource<RunSummaryView[]>(keys.runs(projectId), () => api.runs(projectId), { refreshMs: 30_000 });
  const projects = useResource(keys.projects(), api.projects);
  const workspace = useResource(keys.workspace(), api.workspace);
  const now = useNow(true, 15_000);
  const [needle, setNeedle] = useState('');
  const [statuses, setStatuses] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  const names = useMemo(() => new Map((projects.data ?? []).map((project) => [project.id, project.name])), [projects.data]);
  const present = useMemo(() => [...new Set((runs.data ?? []).map((run) => run.status))], [runs.data]);

  const visible = useMemo(() => {
    const q = needle.trim().toLowerCase();
    return (runs.data ?? [])
      .filter((run) => statuses.size === 0 || statuses.has(run.status))
      .filter((run) => q === '' || `${run.runId} ${run.feature} ${run.projectId} ${run.stage}`.toLowerCase().includes(q));
  }, [runs.data, needle, statuses]);

  const toggle = (status: string): void =>
    setStatuses((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">{t.runs.history}</span>
          <h1 className="page-head__title">
            {t.runs.runCount(runs.data?.length ?? 0)}
            {projectId === undefined ? '' : ` · ${names.get(projectId) ?? projectId}`}
          </h1>
        </div>
        <div className="filters">
          <button type="button" className="btn btn--primary" onClick={() => setCreating(true)} disabled={(projects.data?.length ?? 0) === 0}>
            {t.deck.newFeature}
          </button>
          <input className="input" placeholder={t.runs.filterPlaceholder} value={needle} onChange={(event) => setNeedle(event.target.value)} aria-label={t.runs.filterAria} />
          {present.map((status) => (
            <button key={status} type="button" className="toggle" aria-pressed={statuses.has(status)} onClick={() => toggle(status)}>
              {word(t, status)}
            </button>
          ))}
          {projectId === undefined ? null : (
            <a className="btn btn--ghost btn--sm" href={href({ name: 'runs' })} onClick={onLinkClick}>
              {t.runs.allProjects}
            </a>
          )}
        </div>
      </div>

      <NewFeatureDialog
        open={creating}
        onClose={() => setCreating(false)}
        projects={projects.data ?? []}
        rows={workspace.data?.projects ?? []}
        initialProjectId={projectId}
      />

      {runs.error !== undefined ? (
        <Empty error>{t.runs.couldNotRead}</Empty>
      ) : runs.loading ? (
        <Skeleton rows={5} />
      ) : visible.length === 0 ? (
        <Empty hint={needle === '' && statuses.size === 0 ? t.runs.startOneHint : t.runs.loosenFilter}>
          {t.runs.noMatch}
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.deck.colProject}</th>
                <th>{t.runs.colRun}</th>
                <th>{t.deck.colFeature}</th>
                <th>{t.runs.colStatus}</th>
                <th>{t.newFeature.workflow.toLowerCase()}</th>
                <th>{t.deck.colTasks}</th>
                <th>{t.inspector.duration}</th>
                <th>{t.run.updated}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((run) => {
                const to = href({ name: 'run', projectId: run.projectId, runId: run.runId });
                return (
                  <tr key={`${run.projectId}/${run.runId}`} className="is-link" onClick={() => navigate(to)}>
                    <td className="nowrap">{names.get(run.projectId) ?? run.projectId}</td>
                    <td className="mono nowrap">
                      <a href={to} onClick={onLinkClick} style={{ fontWeight: 600 }}>
                        {run.runId}
                      </a>
                    </td>
                    <td className="cell-max">
                      <span className="truncate" style={{ display: 'block', maxWidth: 460 }} title={run.feature}>
                        {featureTitle(run.feature)}
                      </span>
                    </td>
                    <td>
                      <Chip tone={runStatusTone(run.status)}>{word(t, run.status)}</Chip>
                    </td>
                    <td className="mono">{run.workflow === undefined ? t.common.none : word(t, run.workflow)}</td>
                    {/* One column for the tasks: a progress bar beside a count that says the same
                        thing was two columns, and pushed the duration off the table. */}
                    <td className="nowrap">
                      <span className="runs-tasks">
                        <Meter done={run.completedTasks} total={Math.max(run.taskCount, 1)} tone={run.status === 'failed' ? 'bad' : run.status === 'completed' ? 'ok' : 'live'} />
                        <span className="mono">
                          {run.completedTasks}/{run.taskCount}
                        </span>
                      </span>
                    </td>
                    <td className="mono nowrap">{formatDuration(run.durationMs)}</td>
                    <td className="mono nowrap">{formatRelative(run.updatedAt, now, t.time)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
