import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ActionJobView, ApprovalGateView, AttentionItem, ControlSnapshotView, RunDagView, RunDetailView, RunEventLogView, StageViewResponse, TaskSummaryView } from '@contracts/index.js';
import { ApiError, api, keys } from '../../lib/api';
import { buildTimeline, stateAt } from '../../lib/replay';
import { invalidate, useResource } from '../../lib/store';
import { formatClock, formatDuration, formatRelative, formatStamp, ms } from '../../lib/time';
import { runtimeTone, words } from '../../lib/tone';
import { useNow } from '../../lib/use-now';
import { Chip, Empty, Notice, Pri, Skeleton, Tape } from '../../components/ui';
import { href, navigate, onLinkClick } from '../../app/router';
import { Recorder } from './Recorder';
import { Graph } from './Graph';
import { Inspector } from './Inspector';
import { Feed } from './Feed';
import { GateDialog } from './GateDialog';

/** Runtime statuses after which nothing moves, and the recorder's right edge stands still. */
const FINISHED = new Set(['complete', 'failed', 'cancelled']);

/**
 * One run, as a recording.
 *
 * Everything the server projects about the run is read here and passed down; nothing is
 * derived that the server already answers. The one piece of state this page owns is the
 * playhead — `null` for "now", an instant for "then" — and the selected task. Both live
 * in the address, so a link to a moment in a run is a link a person can send.
 */
export function RunPage({ projectId, runId, task, at }: { projectId: string; runId: string; task?: string; at?: string }) {
  const address = useMemo(() => ({ projectId, runId }), [projectId, runId]);

  const run = useResource<RunDetailView>(keys.run(address), () => api.run(address));
  const stages = useResource<StageViewResponse[]>(keys.stages(address), () => api.stages(address));
  const tasks = useResource<TaskSummaryView[]>(keys.tasks(address), () => api.tasks(address));
  const dag = useResource<RunDagView>(keys.dag(address), () => api.dag(address));
  const control = useResource<ControlSnapshotView>(keys.control(address), () => api.control(address));
  const log = useResource<RunEventLogView>(keys.eventLog(address), () => api.eventLog(address));
  // The gate is about a plan. Before one exists the endpoint answers 409 `no_plan`, which
  // is a correct answer and not one worth a console error on every planning run.
  const gate = useResource<ApprovalGateView>(run.data !== undefined && run.data.taskCount > 0 ? keys.approval(address) : null, () => api.approval(address));
  const projects = useResource(keys.projects(), api.projects);

  const finished = run.data === undefined ? false : FINISHED.has(run.data.runtime.status);
  const job = useResource<ActionJobView | null>(keys.job(address), () => api.job(address), { refreshMs: 3_000 });
  const now = useNow(!finished);

  const [scrub, setScrub] = useState<number | null>(() => ms(at) ?? null);
  const [selected, setSelected] = useState<string | undefined>(task);
  const [gateOpen, setGateOpen] = useState(false);
  const [gateTab, setGateTab] = useState<'decide' | 'revise'>('decide');
  const [featureOpen, setFeatureOpen] = useState(false);
  const [actionNote, setActionNote] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | undefined>(undefined);

  // The address carries the moment and the task, so a reload lands where you were.
  useEffect(() => {
    navigate(
      href({
        name: 'run',
        projectId,
        runId,
        ...(selected === undefined ? {} : { task: selected }),
        ...(scrub === null ? {} : { at: new Date(scrub).toISOString() }),
      }),
      { replace: true },
    );
  }, [projectId, runId, selected, scrub]);

  const timeline = useMemo(() => (log.data === undefined ? undefined : buildTimeline(log.data.events, Date.now())), [log.data]);

  const domain = useMemo<readonly [number, number]>(() => {
    const start = ms(run.data?.createdAt) ?? timeline?.start ?? now;
    const lastLine = timeline?.end ?? start;
    const end = finished ? Math.max(lastLine, ms(run.data?.updatedAt) ?? lastLine) : Math.max(lastLine, now);
    return [Math.min(start, lastLine), Math.max(end, start + 1_000)];
  }, [run.data, timeline, finished, now]);

  const live = scrub === null;
  const t = live ? domain[1] : Math.min(Math.max(scrub, domain[0]), domain[1]);
  const past = useMemo(() => (timeline === undefined || live ? undefined : stateAt(timeline, t)), [timeline, live, t]);

  const rows = useMemo(() => {
    const list = tasks.data ?? [];
    const byId = new Map(list.map((item) => [item.id, item]));
    const ordered: { id: string; title: string }[] = [];
    // Plan order first — it is the order the DAG was written in — then anything the log
    // names that the plan does not (a corrective task the plan has not been re-read for).
    for (const item of list) ordered.push({ id: item.id, title: item.title });
    for (const id of timeline?.tasks ?? []) if (!byId.has(id)) ordered.push({ id, title: '' });
    return ordered;
  }, [tasks.data, timeline]);

  const liveStates = useMemo(() => new Map((tasks.data ?? []).map((item) => [item.id, item.state])), [tasks.data]);
  const stateOf = useCallback((id: string): string | undefined => (past === undefined ? liveStates.get(id) : past.tasks.get(id)?.state), [past, liveStates]);

  const cards = useMemo(() => new Map((control.data?.cards ?? []).map((card) => [card.task.id, card])), [control.data]);
  const attention: readonly AttentionItem[] = control.data?.attention ?? [];
  const attentionFor = (id: string | undefined): AttentionItem | undefined => (id === undefined ? undefined : attention.find((item) => item.scope.taskId === id));

  const onScrub = useCallback((next: number | null) => setScrub(next), []);
  const onSelect = useCallback((id: string | undefined) => setSelected(id), []);
  const onJump = useCallback((instant: number, id?: string) => {
    setScrub(instant);
    if (id !== undefined) setSelected(id);
  }, []);

  const refreshRun = (): void => invalidate((key) => key.includes(`/runs/${runId}`) || key.includes('/workspace'));

  const ask = async (call: () => Promise<unknown>, asked: string): Promise<void> => {
    setActionNote(undefined);
    try {
      await call();
      setActionNote({ tone: 'ok', text: asked });
      refreshRun();
    } catch (error) {
      setActionNote({ tone: 'bad', text: error instanceof ApiError ? `${error.message}${error.action === undefined ? '' : ` ${error.action}`}` : String(error) });
    }
  };

  const start = (): Promise<void> => ask(() => api.start(address), 'Asked. Execution runs as a job; progress arrives on the recorder.');
  // The last step, from the page a person is already on. Verification, the two reviewers
  // and the Definition of Done run as a job; the run's status moves when they are done.
  const finalReview = (): Promise<void> =>
    ask(() => api.review(address), 'Asked. Verification and the final review run as a job; the run closes when the Definition of Done holds.');

  const openGate = (tab: 'decide' | 'revise'): void => {
    setGateTab(tab);
    setGateOpen(true);
  };

  const onAttentionAction = (item: AttentionItem): void => {
    switch (item.action.kind) {
      case 'approve':
        openGate('decide');
        break;
      case 'revise':
        openGate('revise');
        break;
      case 'start':
      case 'resume':
        void start();
        break;
      case 'retry':
      case 'inspect':
      default:
        if (item.scope.taskId !== undefined) setSelected(item.scope.taskId);
        setScrub(null);
        break;
    }
  };

  if (run.error !== undefined) {
    return (
      <main className="page">
        <Empty
          error
          hint={
            <a href={href({ name: 'runs', projectId })} onClick={onLinkClick} style={{ textDecoration: 'underline' }}>
              Runs in this project
            </a>
          }
        >
          {run.error instanceof ApiError && run.error.status === 404 ? `${runId} does not exist in ${projectId}.` : `${runId} could not be read.`}
        </Empty>
      </main>
    );
  }

  const detail = run.data;
  const projectName = projects.data?.find((project) => project.id === projectId)?.name ?? projectId;
  const rt = detail?.runtime;
  const gateOffered = gate.data !== undefined && !gate.data.approved && (gate.data.canApprove || gate.data.refusal?.forcible === true);
  const idle = job.data === null || job.data === undefined;
  const showStart = rt?.resumable === true && idle;
  // Offered exactly when the server says the run is held at final acceptance — never as a
  // button whose only outcome is a refusal.
  const showReview = rt?.gate?.gate === 'final_acceptance' && idle;

  return (
    <main className="page">
      <header className="run-head">
        <div style={{ minWidth: 0 }}>
          <div className="run-head__crumbs">
            <a href={href({ name: 'deck' })} onClick={onLinkClick}>
              deck
            </a>
            <span aria-hidden="true">/</span>
            <a href={href({ name: 'runs', projectId })} onClick={onLinkClick}>
              {projectName}
            </a>
            <span aria-hidden="true">/</span>
            <span>{detail?.workflow ?? 'run'}</span>
            {detail?.isolation.mode === 'worktree' ? (
              <>
                <span aria-hidden="true">/</span>
                <span title={detail.isolation.integrationBranch}>
                  worktrees · {detail.isolation.parallelism.effective} at once
                  {detail.isolation.parallelism.clamped ? ` of ${String(detail.isolation.parallelism.requested)}` : ''}
                </span>
              </>
            ) : null}
          </div>
          <h1 className="run-head__id">
            <span>{runId}</span>
            {rt === undefined ? null : <Chip tone={runtimeTone(rt.status)}>{words(rt.status)}</Chip>}
            {detail !== undefined && detail.revisionCount !== undefined && detail.revisionCount > 0 ? (
              <Chip tone="idle" plain>
                revision {detail.revisionCount}
              </Chip>
            ) : null}
            {detail !== undefined && detail.degradationDetail.length > 0 ? (
              <Chip tone="warn" plain title={detail.degradationDetail.map((degradation) => degradation.reason).join('\n')}>
                {detail.degradationDetail.length} degraded
              </Chip>
            ) : null}
          </h1>
          {detail === undefined ? (
            <Skeleton rows={2} />
          ) : (
            <>
              <p className="run-head__feature" data-open={featureOpen} title={featureOpen ? undefined : detail.feature}>
                {detail.feature}
              </p>
              {detail.feature.length > 180 ? (
                <button type="button" className="run-head__more" onClick={() => setFeatureOpen((value) => !value)}>
                  {featureOpen ? 'less' : 'read the whole request'}
                </button>
              ) : null}
              <div className="facts" style={{ marginTop: 12 }}>
                <span>
                  created <b>{formatStamp(Date.parse(detail.createdAt))}</b>
                </span>
                <span>
                  updated <b>{formatRelative(detail.updatedAt, now)}</b>
                </span>
                <span>
                  elapsed <b>{formatDuration(detail.durationMs)}</b>
                </span>
                {detail.isolation.integrationHead === undefined ? null : (
                  <span>
                    head <b>{detail.isolation.integrationHead.slice(0, 10)}</b>
                  </span>
                )}
              </div>
              {detail.isolation.note === undefined ? null : (
                <p className="faint" style={{ margin: '8px 0 0', fontSize: 12, maxWidth: '88ch' }}>
                  {detail.isolation.note}
                </p>
              )}
            </>
          )}
        </div>

        <div className="run-head__side">
          <div className="run-head__actions">
            {job.data !== null && job.data !== undefined ? (
              <span className="job">{job.data.kind === 'start' ? 'executing' : job.data.kind === 'review' ? 'reviewing' : job.data.kind === 'revise' ? 're-planning' : job.data.kind === 'plan' ? 'planning' : job.data.kind}…</span>
            ) : null}
            {showReview ? (
              <button type="button" className="btn btn--primary" onClick={() => void finalReview()}>
                Run the final review
              </button>
            ) : null}
            {gateOffered ? (
              <button type="button" className="btn btn--primary" onClick={() => openGate('decide')}>
                Review the plan
              </button>
            ) : null}
            {detail !== undefined && !detail.approved && !FINISHED.has(detail.runtime.status) && gate.data !== undefined ? (
              <button type="button" className="btn" onClick={() => openGate('revise')}>
                Ask for a revision
              </button>
            ) : null}
            {showStart ? (
              <button type="button" className="btn btn--primary" onClick={() => void start()}>
                {detail !== undefined && detail.completedTasks > 0 ? 'Resume' : 'Start execution'}
              </button>
            ) : null}
            <a className="btn btn--ghost" href={href({ name: 'runs', projectId })} onClick={onLinkClick}>
              all runs
            </a>
          </div>
          {rt === undefined ? null : (
            <div className="axes" aria-label="Progress">
              <Axis label="workflow" done={rt.progress.workflow.done} total={rt.progress.workflow.total} tone={runtimeTone(rt.status) === 'bad' ? 'bad' : 'live'} />
              <Axis label="tasks" done={rt.progress.implementation.done} total={rt.progress.implementation.total} tone="ok" />
              {rt.progress.corrective === undefined ? null : <Axis label="corrective" done={rt.progress.corrective.done} total={rt.progress.corrective.total} tone="warn" />}
            </div>
          )}
          <div style={{ width: 'min(100%, 420px)', alignSelf: 'stretch' }}>
            <Tape stages={stages.data} tall />
          </div>
        </div>
      </header>

      {actionNote === undefined ? null : (
        <Notice tone={actionNote.tone} k={actionNote.tone === 'ok' ? 'asked' : 'refused'}>
          {actionNote.text}
        </Notice>
      )}

      {rt?.gate !== undefined ? (
        <Notice tone="warn" k={words(rt.gate.gate)}>
          {rt.gate.action}
          {rt.gate.tasks.length > 0 ? ` — ${rt.gate.tasks.join(', ')}` : ''}
        </Notice>
      ) : null}
      {rt?.escalation !== undefined ? (
        <Notice tone="bad" k="recovery exhausted">
          <b>{rt.escalation.task}</b> · {words(rt.escalation.failureClass)} — {rt.escalation.humanAction}
        </Notice>
      ) : null}

      {control.error !== undefined ? (
        <Notice tone="ghost" k="attention">
          The attention queue could not be read for this run.
        </Notice>
      ) : attention.length === 0 ? null : (
        <div className="queue" role="list" aria-label="What needs a person on this run">
          {attention.map((item) => (
            <div key={`${item.id}|${item.since}`} className="ticket" role="listitem">
              <Pri priority={item.priority} />
              <div className="ticket__scope">
                <span className="ticket__project">{words(item.kind)}</span>
                <span className="ticket__run">{item.scope.taskId ?? item.scope.runId}</span>
              </div>
              <div className="truncate">
                <div className="ticket__what truncate">{item.what}</div>
                <div className="ticket__why truncate">{item.why}</div>
              </div>
              <button type="button" className={item.action.destructive ? 'btn btn--sm btn--danger' : 'btn btn--sm'} onClick={() => onAttentionAction(item)}>
                {item.action.label}
              </button>
              <span className="ticket__since">{formatRelative(item.since, now)}</span>
            </div>
          ))}
        </div>
      )}

      {timeline === undefined ? (
        log.error !== undefined ? (
          <Empty error>The audit log could not be read, so there is nothing to record.</Empty>
        ) : (
          <div className="panel">
            <Skeleton rows={4} />
          </div>
        )
      ) : (
        <Recorder
          timeline={timeline}
          domain={domain}
          t={t}
          live={live}
          finished={finished}
          truncated={log.data?.truncated === true}
          onScrub={onScrub}
          selected={selected}
          onSelect={onSelect}
          rows={rows}
          liveStates={liveStates}
          past={past}
        />
      )}

      <div className="run-grid">
        <section className="panel" aria-labelledby="graph-h">
          <div className="panel__head">
            <span id="graph-h" className="eyebrow">
              Graph{past === undefined ? '' : ` · as of ${formatClock(t)}`}
            </span>
            <span className="section__count">
              {dag.data?.nodes.length ?? 0} tasks · {dag.data?.edges.length ?? 0} edges
            </span>
          </div>
          <div className="panel__body">
            <Graph dag={dag.data} rows={rows} stateOf={stateOf} selected={selected} onSelect={onSelect} {...(dag.error === undefined ? {} : { error: dag.error })} />
          </div>
        </section>

        <section className="panel" aria-labelledby="task-h">
          <div className="panel__head">
            <span id="task-h" className="eyebrow">
              Task
            </span>
            {selected === undefined ? null : (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSelected(undefined)}>
                clear
              </button>
            )}
          </div>
          <div className="panel__body">
            <Inspector address={address} taskId={selected} card={selected === undefined ? undefined : cards.get(selected)} attention={attentionFor(selected)} past={past} liveState={selected === undefined ? undefined : liveStates.get(selected)} />
          </div>
        </section>

        <section className="panel" aria-labelledby="feed-h">
          <div className="panel__head">
            <span id="feed-h" className="eyebrow">
              Log
            </span>
            <span className="section__count">
              {log.data === undefined ? '' : `${String(log.data.total)} lines`}
              {log.data?.truncated ? ' · origin cut' : ''}
            </span>
          </div>
          <div className="panel__body">
            <Feed timeline={timeline ?? buildTimeline([], now)} t={t} live={live} onJump={onJump} selected={selected} />
          </div>
        </section>
      </div>

      <GateDialog address={address} gate={gate.data} open={gateOpen} onClose={() => setGateOpen(false)} initialTab={gateTab} />
    </main>
  );
}

function Axis({ label, done, total, tone }: { label: string; done: number; total: number; tone: 'ok' | 'live' | 'warn' | 'bad' }) {
  const pct = total <= 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="axis" role="img" aria-label={`${label} ${String(done)} of ${String(total)}`}>
      <span className="axis__k">
        <span>{label}</span>
        <b>
          {done}/{total}
        </b>
      </span>
      <span className="axis__track" data-tone={tone}>
        <span className="axis__fill" style={{ width: `${String(pct)}%` }} />
      </span>
    </div>
  );
}
