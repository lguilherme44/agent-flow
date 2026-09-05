import { useMemo, useState } from 'react';
import type { RunSummaryView } from '@contracts/index.js';
import { api, keys } from '../../lib/api';
import { useResource } from '../../lib/store';
import { formatDuration, formatRelative } from '../../lib/time';
import { runStatusTone, words } from '../../lib/tone';
import { useNow } from '../../lib/use-now';
import { Chip, Empty, Meter, Skeleton } from '../../components/ui';
import { href, navigate, onLinkClick } from '../../app/router';

/** History. Filters are local: narrowing the list costs no round trip. */
export function RunsPage({ projectId }: { projectId?: string }) {
  const runs = useResource<RunSummaryView[]>(keys.runs(projectId), () => api.runs(projectId), { refreshMs: 30_000 });
  const projects = useResource(keys.projects(), api.projects);
  const now = useNow(true, 15_000);
  const [needle, setNeedle] = useState('');
  const [statuses, setStatuses] = useState<Set<string>>(new Set());

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
          <span className="eyebrow">History</span>
          <h1 className="page-head__title">
            {runs.data?.length ?? 0} run{runs.data?.length === 1 ? '' : 's'}
            {projectId === undefined ? '' : ` · ${names.get(projectId) ?? projectId}`}
          </h1>
          <p className="page-head__sub">Newest first. Every row is one project's run; ids restart per project per year.</p>
        </div>
        <div className="filters">
          <input className="input" placeholder="Filter by id, feature, project…" value={needle} onChange={(event) => setNeedle(event.target.value)} aria-label="Filter runs" />
          {present.map((status) => (
            <button key={status} type="button" className="toggle" aria-pressed={statuses.has(status)} onClick={() => toggle(status)}>
              {words(status)}
            </button>
          ))}
          {projectId === undefined ? null : (
            <a className="btn btn--ghost btn--sm" href={href({ name: 'runs' })} onClick={onLinkClick}>
              all projects
            </a>
          )}
        </div>
      </div>

      {runs.error !== undefined ? (
        <Empty error>Runs could not be read.</Empty>
      ) : runs.loading ? (
        <Skeleton rows={5} />
      ) : visible.length === 0 ? (
        <Empty hint={needle === '' && statuses.size === 0 ? 'Start one with `agent-flow feature "…"`.' : 'Loosen the filter.'}>
          No runs match.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>project</th>
                <th>run</th>
                <th>feature</th>
                <th>status</th>
                <th>workflow</th>
                <th>progress</th>
                <th>tasks</th>
                <th>degraded</th>
                <th>duration</th>
                <th>updated</th>
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
                      {run.revisionCount !== undefined && run.revisionCount > 0 ? <span className="faint">{` r${String(run.revisionCount)}`}</span> : null}
                    </td>
                    <td className="cell-max">
                      <span className="truncate" style={{ display: 'block', maxWidth: 460 }} title={run.feature}>
                        {run.feature}
                      </span>
                    </td>
                    <td>
                      <Chip tone={runStatusTone(run.status)}>{words(run.status)}</Chip>
                    </td>
                    <td className="mono">{run.workflow ?? '—'}</td>
                    <td style={{ minWidth: 120 }}>
                      <Meter done={run.progress} total={100} tone={run.status === 'failed' ? 'bad' : run.status === 'completed' ? 'ok' : 'live'} />
                    </td>
                    <td className="mono">
                      {run.completedTasks}/{run.taskCount}
                    </td>
                    <td className="mono" style={{ color: run.degradations > 0 ? 'var(--warn)' : undefined }}>
                      {run.degradations === 0 ? '—' : run.degradations}
                    </td>
                    <td className="mono">{formatDuration(run.durationMs)}</td>
                    <td className="mono">{formatRelative(run.updatedAt, now)}</td>
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
