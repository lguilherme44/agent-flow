import { useMemo, useState } from 'react';
import type { AttentionItem, ControlSnapshotView, ProjectView, StageViewResponse, WorkspaceProjectView } from '@contracts/index.js';
import { api, keys } from '../../lib/api';
import { useResource, useResources } from '../../lib/store';
import { formatRelative } from '../../lib/time';
import { deliveryTone, priorityTone, runtimeTone } from '../../lib/tone';
import { useT, word, type Dictionary } from '../../lib/i18n';
import { useNow } from '../../lib/use-now';
import { Chip, Empty, Meter, Pri, Skeleton, Tape } from '../../components/ui';
import { href, onLinkClick } from '../../app/router';
import { NewFeatureDialog } from './NewFeatureDialog';
import { RegisterProjectDialog } from './RegisterProjectDialog';

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
  const t = useT();
  const workspace = useResource(keys.workspace(), api.workspace, { refreshMs: 30_000 });
  const projects = useResource(keys.projects(), api.projects, { refreshMs: 60_000 });
  const now = useNow(true, 15_000);
  const [unfolded, setUnfolded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [registering, setRegistering] = useState(false);

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
          <span className="eyebrow">{t.deck.workspace}</span>
          <h1 className="page-head__title">
            {t.deck.projectCount(rows.length)}
          </h1>
          <p className="page-head__sub">
            {workspace.data === undefined
              ? t.deck.readingWorkspace
              : t.deck.observed(formatRelative(workspace.data.observedAt, now, t.time), moving.length, totalAttention)}
          </p>
        </div>
        <div className="deck-summary" aria-label={t.deck.summaryAria}>
          <button type="button" className="btn btn--primary" onClick={() => setCreating(true)} disabled={(projects.data?.length ?? 0) === 0} style={{ alignSelf: 'center' }}>
            {t.deck.newFeature}
          </button>
          {/*
            Enabled, at last (7.6). It was a disabled button for two milestones because
            "adding one means writing to the registry, and no route does" — the obstacle
            was really that a directory with no `.agent-flow/` had no id for a request to
            name, and the workspace walk now issues one.
          */}
          <button type="button" className="btn btn--ghost" onClick={() => setRegistering(true)} style={{ alignSelf: 'center' }}>
            {t.common.noProjectsHintAction}
          </button>
          <div className="stat">
            <span className="stat__value" data-tone={moving.length > 0 ? 'live' : undefined}>
              {moving.length}
            </span>
            <span className="stat__label">{t.deck.moving}</span>
          </div>
          <div className="stat">
            <span className="stat__value" data-tone={totalAttention > 0 ? 'warn' : 'ok'}>
              {totalAttention}
            </span>
            <span className="stat__label">{t.deck.needYou}</span>
          </div>
          <div className="stat">
            <span className="stat__value" data-tone="ghost">
              {idle.length}
            </span>
            <span className="stat__label">{t.deck.idle}</span>
          </div>
        </div>
      </div>

      <section className="section" aria-labelledby="needs-you">
        <div className="section__head">
          <h2 id="needs-you" className="eyebrow" style={{ margin: 0 }}>
            {t.deck.needsYou}
          </h2>
          <span className="section__count">
            {t.deck.itemCount(totalAttention)}
            {wanting.length > 1 ? ` · ${t.deck.projectsCount(wanting.length)}` : ''}
          </span>
        </div>
        {workspace.error !== undefined ? (
          <Empty error hint={t.deck.queueHint}>
            {t.deck.queueCouldNotRead}
          </Empty>
        ) : workspace.loading || (queue.length === 0 && queueLoading) ? (
          <Skeleton rows={2} />
        ) : queue.length === 0 ? (
          <div className="queue">
            <div className="ticket--quiet">
              <span className="ticket__mark" aria-hidden="true">
                ●
              </span>
              {t.deck.nothingNeedsYou}
            </div>
          </div>
        ) : (
          <>
            <div className="queue" role="list" aria-label={t.deck.queueAria}>
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
                  <span className="ticket__since">{formatRelative(item.since, now, t.time)}</span>
                </a>
              ))}
            </div>
            {queue.length > QUEUE_FOLD ? (
              <button type="button" className="btn btn--ghost btn--sm" style={{ alignSelf: 'flex-start' }} onClick={() => setUnfolded((value) => !value)}>
                {unfolded ? t.deck.showFirstSix : t.deck.showAll(queue.length)}
              </button>
            ) : null}
          </>
        )}
      </section>

      <section className="section" aria-labelledby="projects">
        <div className="section__head">
          <h2 id="projects" className="eyebrow" style={{ margin: 0 }}>
            {t.common.projects}
          </h2>
          <span className="section__count">
            {t.deck.movingOf(moving.length, rows.length)}
          </span>
        </div>
        {workspace.error !== undefined ? (
          <Empty error>{t.deck.workspaceCouldNotRead}</Empty>
        ) : workspace.loading ? (
          <Skeleton rows={4} />
        ) : (
          <div className="lanes">
            <div className="lanes__head" aria-hidden="true">
              <span>{t.deck.colProject}</span>
              <span>{t.deck.colFeature}</span>
              <span>{t.deck.colRuntime}</span>
              <span>{t.deck.colPipeline}</span>
              <span>{t.deck.colTasks}</span>
              <span>{t.deck.colAttention}</span>
              <span>{t.deck.colSeats}</span>
              <span>{t.deck.colActivity}</span>
            </div>
            {ordered.map((row) => (
              <ProjectLane key={row.projectId} row={row} project={byId.get(row.projectId)} now={now} t={t} />
            ))}
          </div>
        )}
      </section>

      <NewFeatureDialog open={creating} onClose={() => setCreating(false)} projects={projects.data ?? []} rows={rows} />
      <RegisterProjectDialog open={registering} onClose={() => setRegistering(false)} />
    </main>
  );
}

function ProjectLane({ row, project, now, t }: { row: WorkspaceProjectView; project: ProjectView | undefined; now: number; t: Dictionary }) {
  const address = { projectId: row.projectId, runId: row.runId ?? '' };
  const stages = useResource<StageViewResponse[]>(row.runId === undefined ? null : keys.stages(address), () => api.stages(address));
  const idle = row.runId === undefined;
  const done = Math.round((row.progress / 100) * row.taskCount);

  const inner = (
    <>
      <div className="lane__name">
        <span className="lane__project">{project?.name ?? row.name}</span>
        <span className="lane__run">
          {row.runId ?? (project?.runCount === undefined ? t.deck.noRun : t.deck.runsNoneActive(project.runCount))}
          {project?.stack === undefined ? '' : ` · ${project.stack}`}
        </span>
      </div>
      <div className="lane__feature">
        {idle ? (
          <span className="lane__feature-text faint">{project?.lastRun === undefined ? t.deck.nothingRanHere : t.deck.last(project.lastRun.feature)}</span>
        ) : (
          <span className="lane__feature-text">{row.feature ?? t.common.none}</span>
        )}
      </div>
      <div className="lane__cell">
        {idle ? (
          project?.lastRun === undefined ? (
            <Chip tone="ghost" plain>
              {word(t, 'idle')}
            </Chip>
          ) : (
            <Chip tone={project.lastRun.status === 'completed' ? 'ok' : project.lastRun.status === 'failed' ? 'bad' : 'ghost'} plain>
              {t.deck.lastStatus(word(t, project.lastRun.status))}
            </Chip>
          )
        ) : (
          <Chip tone={runtimeTone(row.runtime)}>{word(t, row.runtime ?? row.status)}</Chip>
        )}
      </div>
      <div className="lane__cell">
        <Tape stages={idle ? undefined : stages.data} />
      </div>
      <div className="lane__cell">
        {idle ? (
          <span className="lane__v faint">{t.common.none}</span>
        ) : (
          <>
            <Meter done={done} total={row.taskCount} tone={row.blockedCount > 0 ? 'warn' : 'ok'} />
            <span className="lane__v">
              {done}/{row.taskCount}
              {row.blockedCount > 0 ? <span style={{ color: 'var(--warn)' }}>{` · ${t.deck.blockedCount(row.blockedCount)}`}</span> : null}
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
          <span className="lane__v faint">{idle ? t.common.none : word(t, 'none')}</span>
        )}
      </div>
      <div className="lane__cell">
        <span className="lane__v">{row.teamLoad === undefined ? t.common.none : t.deck.seats(row.teamLoad.running, row.teamLoad.capacity)}</span>
        <span className="lane__v" data-tone={row.delivery === undefined ? undefined : deliveryTone(row.delivery)}>
          {row.delivery === undefined || row.delivery === 'disabled' ? t.deck.noForge : word(t, row.delivery)}
        </span>
      </div>
      <div className="lane__cell">
        <span className="lane__v">{formatRelative(row.lastActivityAt ?? project?.lastRun?.updatedAt, now, t.time)}</span>
      </div>
    </>
  );

  if (idle) {
    return (
      <a className="lane lane--idle" href={href({ name: 'runs', projectId: row.projectId })} onClick={onLinkClick} aria-label={t.deck.noActiveRun(project?.name ?? row.name)}>
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
