import { useMemo, useState } from 'react';
import type { AttentionItem, ControlSnapshotView, ProjectView, StageViewResponse, WorkspaceProjectView } from '@contracts/index.js';
import { api, keys } from '../../lib/api';
import { useResource, useResources } from '../../lib/store';
import { formatRelative } from '../../lib/time';
import { deliveryTone, priorityTone, runtimeTone, words } from '../../lib/tone';
import { useNow } from '../../lib/use-now';
import { Chip, Empty, Meter, Pri, Skeleton, Tape } from '../../components/ui';
import { href, onLinkClick } from '../../app/router';

/** Runtime statuses after which a project is not moving. */
const STILL = new Set(['complete', 'failed', 'cancelled']);

/** How many tickets the queue shows before it asks to be unfolded. */
const QUEUE_FOLD = 6;

/**
 * The deck: every project the server can see, and what wants a person first.
 *
 * Two questions, in order. "What needs me" is the attention items of every project whose
 * workspace row says it has any, fetched from each run's control snapshot and merged into
 * one queue in the server's own order — priority, then age — so a P1 on the fourth project
 * is above a P3 on the first. "What is each project doing" is one lane per project, with
 * the pipeline tape the run page draws large.
 */
export function DeckPage() {
  const workspace = useResource(keys.workspace(), api.workspace, { refreshMs: 30_000 });
  const projects = useResource(keys.projects(), api.projects, { refreshMs: 60_000 });
  const now = useNow(true, 15_000);
  const [unfolded, setUnfolded] = useState(false);

  const rows = workspace.data?.projects ?? [];
  const byId = useMemo(() => new Map((projects.data ?? []).map((project) => [project.id, project])), [projects.data]);

  const moving = rows.filter((row) => row.runtime !== undefined && !STILL.has(row.runtime));
  const idle = rows.filter((row) => row.runId === undefined);
  const wanting = rows.filter((row) => row.attentionCount > 0 && row.runId !== undefined);

  // The signature is what matters: a new array of the same addresses must not resubscribe.
  const wantingSignature = wanting.map((row) => `${row.projectId}/${row.runId ?? ''}`).join('\n');
  const controls = useResources<ControlSnapshotView>(
    useMemo(
      () =>
        wantingSignature === ''
          ? []
          : wantingSignature.split('\n').map((pair) => {
              const [projectId = '', runId = ''] = pair.split('/');
              const address = { projectId, runId };
              return { key: keys.control(address), fetcher: () => api.control(address) };
            }),
      [wantingSignature],
    ),
  );

  const queue = useMemo(() => {
    const items: { item: AttentionItem; projectId: string; projectName: string }[] = [];
    for (const row of wanting) {
      const snapshot = controls.get(keys.control({ projectId: row.projectId, runId: row.runId ?? '' }))?.data;
      for (const item of snapshot?.attention ?? []) {
        items.push({ item, projectId: row.projectId, projectName: byId.get(row.projectId)?.name ?? row.name });
      }
    }
    // The server's ladder: priority first, then age. Never re-ranked here — only merged.
    return items.sort((a, b) => a.item.priority.localeCompare(b.item.priority) || a.item.since.localeCompare(b.item.since));
  }, [wanting, controls, byId]);
  const queueLoading = wanting.some((row) => controls.get(keys.control({ projectId: row.projectId, runId: row.runId ?? '' }))?.loading === true);
  const totalAttention = wanting.reduce((sum, row) => sum + row.attentionCount, 0);
  const shown = unfolded ? queue : queue.slice(0, QUEUE_FOLD);

  const ordered = useMemo(() => {
    const rank = (row: WorkspaceProjectView): number => {
      if (row.topPriority !== undefined) return Number.parseInt(row.topPriority.slice(1), 10);
      if (row.runtime !== undefined && !STILL.has(row.runtime)) return 5;
      if (row.runId !== undefined) return 6;
      return 7;
    };
    return [...rows].sort((a, b) => rank(a) - rank(b) || (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  }, [rows]);

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Workspace</span>
          <h1 className="page-head__title">
            {rows.length} project{rows.length === 1 ? '' : 's'}
          </h1>
          <p className="page-head__sub">
            {workspace.data === undefined
              ? 'Reading the workspace…'
              : `Observed ${formatRelative(workspace.data.observedAt, now)} · ${String(moving.length)} moving · ${String(totalAttention)} item${totalAttention === 1 ? '' : 's'} waiting on a person`}
          </p>
        </div>
        <div className="deck-summary" aria-label="Workspace summary">
          <div className="stat">
            <span className="stat__value" data-tone={moving.length > 0 ? 'live' : undefined}>
              {moving.length}
            </span>
            <span className="stat__label">moving</span>
          </div>
          <div className="stat">
            <span className="stat__value" data-tone={totalAttention > 0 ? 'warn' : 'ok'}>
              {totalAttention}
            </span>
            <span className="stat__label">need you</span>
          </div>
          <div className="stat">
            <span className="stat__value" data-tone="ghost">
              {idle.length}
            </span>
            <span className="stat__label">idle</span>
          </div>
        </div>
      </div>

      <section className="section" aria-labelledby="needs-you">
        <div className="section__head">
          <h2 id="needs-you" className="eyebrow" style={{ margin: 0 }}>
            Needs you
          </h2>
          <span className="section__count">
            {totalAttention} item{totalAttention === 1 ? '' : 's'}
            {wanting.length > 1 ? ` · ${String(wanting.length)} projects` : ''}
          </span>
        </div>
        {workspace.error !== undefined ? (
          <Empty error hint="The queue is a projection over the runs on disk; when the server cannot read it, nothing is shown rather than something stale.">
            The attention queue could not be read.
          </Empty>
        ) : workspace.loading || (queue.length === 0 && queueLoading) ? (
          <Skeleton rows={2} />
        ) : queue.length === 0 ? (
          <div className="queue">
            <div className="ticket--quiet">
              <span className="ticket__mark" aria-hidden="true">
                ●
              </span>
              Nothing needs a person right now. Every gate is open, every required check answered.
            </div>
          </div>
        ) : (
          <>
            <div className="queue" role="list" aria-label="Attention queue">
              {shown.map(({ item, projectId, projectName }) => (
                // `item.id` is stable but not unique: three degradations on one run share
                // `degradation_recorded`. A duplicate React key renders extra rows out of
                // order, which is exactly what happened here. `since` tells them apart.
                <a
                  key={`${projectId}|${item.id}|${item.since}`}
                  className="ticket"
                  role="listitem"
                  href={href({
                    name: 'run',
                    projectId,
                    runId: item.scope.runId,
                    ...(item.scope.taskId === undefined ? {} : { task: item.scope.taskId }),
                  })}
                  onClick={onLinkClick}
                >
                  <Pri priority={item.priority} />
                  <div className="ticket__scope">
                    <span className="ticket__project truncate">{projectName}</span>
                    <span className="ticket__run">
                      {item.scope.runId}
                      {item.scope.taskId === undefined ? '' : ` · ${item.scope.taskId}`}
                    </span>
                  </div>
                  <div className="truncate">
                    <div className="ticket__what truncate">{item.what}</div>
                    <div className="ticket__why truncate">{item.why}</div>
                  </div>
                  <span className="btn btn--sm" aria-hidden="true">
                    {item.action.label} →
                  </span>
                  <span className="ticket__since">{formatRelative(item.since, now)}</span>
                </a>
              ))}
            </div>
            {queue.length > QUEUE_FOLD ? (
              <button type="button" className="btn btn--ghost btn--sm" style={{ alignSelf: 'flex-start' }} onClick={() => setUnfolded((value) => !value)}>
                {unfolded ? 'Show the first six' : `Show all ${String(queue.length)}`}
              </button>
            ) : null}
          </>
        )}
      </section>

      <section className="section" aria-labelledby="projects">
        <div className="section__head">
          <h2 id="projects" className="eyebrow" style={{ margin: 0 }}>
            Projects
          </h2>
          <span className="section__count">
            {moving.length} of {rows.length} moving
          </span>
        </div>
        {workspace.error !== undefined ? (
          <Empty error>The workspace could not be read.</Empty>
        ) : workspace.loading ? (
          <Skeleton rows={4} />
        ) : (
          <div className="lanes">
            <div className="lanes__head" aria-hidden="true">
              <span>project</span>
              <span>feature</span>
              <span>runtime</span>
              <span>pipeline</span>
              <span>tasks</span>
              <span>attention</span>
              <span>seats · forge</span>
              <span>activity</span>
            </div>
            {ordered.map((row) => (
              <ProjectLane key={row.projectId} row={row} project={byId.get(row.projectId)} now={now} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function ProjectLane({ row, project, now }: { row: WorkspaceProjectView; project: ProjectView | undefined; now: number }) {
  const address = { projectId: row.projectId, runId: row.runId ?? '' };
  const stages = useResource<StageViewResponse[]>(row.runId === undefined ? null : keys.stages(address), () => api.stages(address));
  const idle = row.runId === undefined;
  const done = Math.round((row.progress / 100) * row.taskCount);

  const inner = (
    <>
      <div className="lane__name">
        <span className="lane__project">{project?.name ?? row.name}</span>
        <span className="lane__run">
          {row.runId ?? (project?.runCount === undefined ? 'no run' : `${String(project.runCount)} run${project.runCount === 1 ? '' : 's'} · none active`)}
          {project?.stack === undefined ? '' : ` · ${project.stack}`}
        </span>
      </div>
      <div className="lane__feature">
        {idle ? (
          <span className="lane__feature-text faint">{project?.lastRun === undefined ? 'Nothing has run here yet.' : `Last: ${project.lastRun.feature}`}</span>
        ) : (
          <span className="lane__feature-text">{row.feature ?? '—'}</span>
        )}
      </div>
      <div className="lane__cell">
        {idle ? (
          project?.lastRun === undefined ? (
            <Chip tone="ghost" plain>
              idle
            </Chip>
          ) : (
            <Chip tone={project.lastRun.status === 'completed' ? 'ok' : project.lastRun.status === 'failed' ? 'bad' : 'ghost'} plain>
              last {words(project.lastRun.status)}
            </Chip>
          )
        ) : (
          <Chip tone={runtimeTone(row.runtime)}>{words(row.runtime ?? row.status)}</Chip>
        )}
      </div>
      <div className="lane__cell">
        <Tape stages={idle ? undefined : stages.data} />
      </div>
      <div className="lane__cell">
        {idle ? (
          <span className="lane__v faint">—</span>
        ) : (
          <>
            <Meter done={done} total={row.taskCount} tone={row.blockedCount > 0 ? 'warn' : 'ok'} />
            <span className="lane__v">
              {done}/{row.taskCount}
              {row.blockedCount > 0 ? <span style={{ color: 'var(--warn)' }}>{` · ${String(row.blockedCount)} blocked`}</span> : null}
            </span>
          </>
        )}
      </div>
      <div className="lane__cell">
        {row.attentionCount > 0 && row.topPriority !== undefined ? (
          <span className="lane__attention">
            <Pri priority={row.topPriority} />
            <span style={{ color: `var(--${priorityTone(row.topPriority)})` }}>{row.attentionCount}</span>
          </span>
        ) : (
          <span className="lane__v faint">{idle ? '—' : 'none'}</span>
        )}
      </div>
      <div className="lane__cell">
        <span className="lane__v">{row.teamLoad === undefined ? '—' : `${String(row.teamLoad.running)}/${String(row.teamLoad.capacity)} seats`}</span>
        <span className="lane__v" data-tone={row.delivery === undefined ? undefined : deliveryTone(row.delivery)}>
          {row.delivery === undefined || row.delivery === 'disabled' ? 'no forge' : words(row.delivery)}
        </span>
      </div>
      <div className="lane__cell">
        <span className="lane__v">{formatRelative(row.lastActivityAt ?? project?.lastRun?.updatedAt, now)}</span>
      </div>
    </>
  );

  if (idle) {
    return (
      <a className="lane lane--idle" href={href({ name: 'runs', projectId: row.projectId })} onClick={onLinkClick} aria-label={`${project?.name ?? row.name}: no active run`}>
        {inner}
      </a>
    );
  }

  return (
    <a className="lane" href={href({ name: 'run', projectId: row.projectId, runId: row.runId ?? '' })} onClick={onLinkClick}>
      {inner}
    </a>
  );
}
