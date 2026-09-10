import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ActionJobView, ApprovalGateView, AttentionItem, ControlSnapshotView, PipelineStage, RunDagView, RunDetailView, RunEventLogView, RunStage, StageViewResponse, TaskSummaryView } from '@contracts/index.js';
import { ApiError, api, keys } from '../../lib/api';
import { buildTimeline, stateAt } from '../../lib/replay';
import { invalidate, useResource } from '../../lib/store';
import { formatClock, formatDuration, formatRelative, formatStamp, ms } from '../../lib/time';
import { runtimeTone } from '../../lib/tone';
import { useT, word } from '../../lib/i18n';
import { useNow } from '../../lib/use-now';
import { Chip, Empty, Notice, Pri, Skeleton, Tape } from '../../components/ui';
import { href, navigate, onLinkClick } from '../../app/router';
import { Recorder } from './Recorder';
import { Graph } from './Graph';
import { Inspector } from './Inspector';
import { Feed } from './Feed';
import { StageLog } from './StageLog';
import { ConfirmCancel } from './ConfirmCancel';
import { GateDialog } from './GateDialog';
import { Outcome, tabForFocus, type OutcomeTab } from './Outcome';

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
  const dict = useT();
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

  const start = (): Promise<void> => ask(() => api.start(address), dict.run.startedOk);
  const pause = (): Promise<void> => ask(() => api.pause(address), dict.run.pausedOk);
  const resume = (): Promise<void> => ask(() => api.resume(address), dict.run.resumedOk);
  /**
   * Terminal, and asked twice on purpose.
   *
   * Every other action on this page can be undone by doing the opposite. This one cannot,
   * and it sits beside buttons that can — so it is the one that stops and asks. The
   * evidence, the integration branch and the worktrees survive, which is what the
   * confirmation says rather than "are you sure".
   */
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [logTab, setLogTab] = useState<'events' | 'stage'>('events');
  const [selectedStage, setSelectedStage] = useState<PipelineStage>('planning');
  const [outcomeTab, setOutcomeTab] = useState<OutcomeTab>('review');

  const onOpenStageLog = (stg: string): void => {
    setSelectedStage(stg as PipelineStage);
    setLogTab('stage');
  };

  const cancelRun = (): Promise<void> => {
    setConfirmCancel(false);
    return ask(() => api.cancel(address), dict.run.cancelledOk);
  };
  // The last step, from the page a person is already on. Verification, the two reviewers
  // and the Definition of Done run as a job; the run's status moves when they are done.
  const finalReview = (): Promise<void> =>
    ask(() => api.review(address), dict.run.reviewAsked);

  const failedPlanningStage = useMemo<RunStage | undefined>(() => {
    if (run.data?.runtime.status !== 'failed') return undefined;
    if (run.data.taskCount > 0) return undefined;
    const events = log.data?.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev?.type === 'stage_failed' && typeof ev.detail['stage'] === 'string') {
        return ev.detail['stage'] as RunStage;
      }
    }
    return (run.data.stage as RunStage) ?? 'planning';
  }, [run.data, log.data]);

  const retryPlanning = (stg?: RunStage): Promise<void> =>
    ask(() => api.resumePlanning(address, stg), dict.run.retryingPlanning(stg === undefined ? dict.run.stageWord : word(dict, stg)));

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
      default: {
        // Where the projection said to look. `undefined` means the answer is above this
        // panel, so the selection below is the whole move.
        const tab = tabForFocus(item.focus);
        if (tab !== undefined) setOutcomeTab(tab);
        if (item.scope.taskId !== undefined) setSelected(item.scope.taskId);
        setScrub(null);
        break;
      }
    }
  };

  if (run.error !== undefined) {
    return (
      <main className="page">
        <Empty
          error
          hint={
            <a href={href({ name: 'runs', projectId })} onClick={onLinkClick} style={{ textDecoration: 'underline' }}>
              {dict.run.runsInThisProject}
            </a>
          }
        >
          {run.error instanceof ApiError && run.error.status === 404 ? dict.run.doesNotExist(runId, projectId) : dict.run.couldNotRead(runId)}
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
  // Offered while the run can still do something, which is the only state in which either
  // is anything but a refusal. A paused run is still unfinished: it can be cancelled.
  const unfinished = rt !== undefined && !FINISHED.has(rt.status);

  return (
    <main className="page">
      <header className="run-head">
        <div style={{ minWidth: 0 }}>
          <div className="run-head__crumbs">
            <a href={href({ name: 'deck' })} onClick={onLinkClick}>
              {dict.nav.deck.toLowerCase()}
            </a>
            <span aria-hidden="true">/</span>
            <a href={href({ name: 'runs', projectId })} onClick={onLinkClick}>
              {projectName}
            </a>
            <span aria-hidden="true">/</span>
            <span>{detail?.workflow === undefined ? dict.run.runWord : word(dict, detail.workflow)}</span>
            {detail?.isolation.mode === 'worktree' ? (
              <>
                <span aria-hidden="true">/</span>
                <span title={detail.isolation.integrationBranch}>
                  {dict.run.worktreesAtOnce(detail.isolation.parallelism.effective)}
                  {detail.isolation.parallelism.clamped ? dict.run.ofRequested(detail.isolation.parallelism.requested) : ''}
                </span>
              </>
            ) : null}
          </div>
          <h1 className="run-head__id">
            <span>{runId}</span>
            {rt === undefined ? null : <Chip tone={runtimeTone(rt.status)}>{word(dict, rt.status)}</Chip>}
            {rt?.paused === true ? (
              <Chip tone="warn" plain title={dict.run.pausedTitle}>
                {dict.run.paused}
              </Chip>
            ) : null}
            {detail !== undefined && detail.revisionCount !== undefined && detail.revisionCount > 0 ? (
              <Chip tone="idle" plain>
                {dict.run.revisionN(detail.revisionCount)}
              </Chip>
            ) : null}
            {detail !== undefined && detail.degradationDetail.length > 0 ? (
              <Chip tone="warn" plain title={detail.degradationDetail.map((degradation) => degradation.reason).join('\n')}>
                {dict.run.degraded(detail.degradationDetail.length)}
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
                  {featureOpen ? dict.feed.less : dict.run.readWholeRequest}
                </button>
              ) : null}
              <div className="facts" style={{ marginTop: 12 }}>
                <span>
                  {dict.run.created} <b>{formatStamp(Date.parse(detail.createdAt), dict.time)}</b>
                </span>
                <span>
                  {dict.run.updated} <b>{formatRelative(detail.updatedAt, now, dict.time)}</b>
                </span>
                <span>
                  {dict.run.elapsed} <b>{formatDuration(detail.durationMs)}</b>
                </span>
                {detail.isolation.integrationHead === undefined ? null : (
                  <span>
                    {dict.run.head} <b>{detail.isolation.integrationHead.slice(0, 10)}</b>
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
              <span className="job">{job.data.kind === 'start' ? dict.run.jobExecuting : job.data.kind === 'review' ? dict.run.jobReviewing : job.data.kind === 'revise' ? dict.run.jobReplanning : job.data.kind === 'plan' ? dict.run.jobPlanning : word(dict, job.data.kind)}…</span>
            ) : null}
            {failedPlanningStage !== undefined && idle ? (
              <button type="button" className="btn btn--primary" onClick={() => void retryPlanning(failedPlanningStage)}>
                {dict.run.retryStage(word(dict, failedPlanningStage))}
              </button>
            ) : null}
            {showReview ? (
              <button type="button" className="btn btn--primary" onClick={() => void finalReview()}>
                {dict.run.runFinalReview}
              </button>
            ) : null}
            {gateOffered ? (
              <button type="button" className="btn btn--primary" onClick={() => openGate('decide')}>
                {dict.run.reviewThePlan}
              </button>
            ) : null}
            {detail !== undefined && !detail.approved && !FINISHED.has(detail.runtime.status) && gate.data !== undefined ? (
              <button type="button" className="btn" onClick={() => openGate('revise')}>
                {dict.gate.askRevision}
              </button>
            ) : null}
            {showStart ? (
              <button type="button" className="btn btn--primary" onClick={() => void start()}>
                {detail !== undefined && detail.completedTasks > 0 ? dict.run.resume : dict.run.startExecution}
              </button>
            ) : null}
            {rt?.paused === true ? (
              <button type="button" className="btn btn--primary" onClick={() => void resume()}>
                {dict.run.resumeRun}
              </button>
            ) : null}
            {unfinished && rt.paused !== true ? (
              <button type="button" className="btn" onClick={() => void pause()}>
                {dict.run.pause}
              </button>
            ) : null}
            {unfinished ? (
              <button type="button" className="btn btn--danger" onClick={() => setConfirmCancel(true)}>
                {dict.run.cancelRun}
              </button>
            ) : null}
            <a className="btn btn--ghost" href={href({ name: 'runs', projectId })} onClick={onLinkClick}>
              {dict.run.allRuns}
            </a>
          </div>
          {rt === undefined ? null : (
            <div className="axes" aria-label={dict.run.progress}>
              <Axis label={dict.run.axisWorkflow} done={rt.progress.workflow.done} total={rt.progress.workflow.total} tone={runtimeTone(rt.status) === 'bad' ? 'bad' : 'live'} />
              <Axis label={dict.run.axisTasks} done={rt.progress.implementation.done} total={rt.progress.implementation.total} tone="ok" />
              {rt.progress.corrective === undefined ? null : <Axis label={dict.run.axisCorrective} done={rt.progress.corrective.done} total={rt.progress.corrective.total} tone="warn" />}
            </div>
          )}
          <div style={{ width: 'min(100%, 420px)', alignSelf: 'stretch' }}>
            <Tape stages={stages.data} tall />
          </div>
        </div>
      </header>

      {failedPlanningStage !== undefined ? (
        <Notice tone="bad" k={dict.run.planningFailedKey}>
          {dict.run.planningStoppedBefore} <b>{word(dict, failedPlanningStage)}</b>{dict.run.planningStoppedAfter(word(dict, failedPlanningStage))}
        </Notice>
      ) : null}

      {actionNote === undefined ? null : (
        <Notice tone={actionNote.tone} k={actionNote.tone === 'ok' ? dict.run.asked : dict.common.refused}>
          {actionNote.text}
        </Notice>
      )}

      {rt?.gate !== undefined ? (
        <Notice tone="warn" k={word(dict, rt.gate.gate)}>
          {rt.gate.action}
          {rt.gate.tasks.length > 0 ? ` — ${rt.gate.tasks.join(', ')}` : ''}
        </Notice>
      ) : null}
      {rt?.escalation !== undefined ? (
        <Notice tone="bad" k={word(dict, 'recovery_exhausted')}>
          <b>{rt.escalation.task}</b> · {word(dict, rt.escalation.failureClass)} — {rt.escalation.humanAction}
        </Notice>
      ) : null}

      {control.error !== undefined ? (
        <Notice tone="ghost" k={dict.run.attentionKey}>
          {dict.run.attentionCouldNotRead}
        </Notice>
      ) : attention.length === 0 ? null : (
        <div className="queue" role="list" aria-label={dict.run.queueAria}>
          {attention.map((item) => (
            <div key={`${item.id}|${item.since}`} className="ticket" role="listitem">
              <Pri priority={item.priority} />
              <div className="ticket__scope">
                <span className="ticket__project">{word(dict, item.kind)}</span>
                <span className="ticket__run">{item.scope.taskId ?? item.scope.runId}</span>
              </div>
              <div className="truncate">
                <div className="ticket__what truncate">{item.what}</div>
                <div className="ticket__why truncate">{item.why}</div>
              </div>
              <button type="button" className={item.action.destructive ? 'btn btn--sm btn--danger' : 'btn btn--sm'} onClick={() => onAttentionAction(item)}>
                {item.action.label}
              </button>
              <span className="ticket__since">{formatRelative(item.since, now, dict.time)}</span>
            </div>
          ))}
        </div>
      )}

      {timeline === undefined ? (
        log.error !== undefined ? (
          <Empty error>{dict.run.logCouldNotRead}</Empty>
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
              {dict.run.graph}{past === undefined ? '' : ` · ${dict.run.asOf(formatClock(t))}`}
            </span>
            <span className="section__count">
              {dict.run.tasksAndEdges(dag.data?.nodes.length ?? 0, dag.data?.edges.length ?? 0)}
            </span>
          </div>
          <div className="panel__body">
            <Graph dag={dag.data} rows={rows} stateOf={stateOf} selected={selected} onSelect={onSelect} {...(dag.error === undefined ? {} : { error: dag.error })} />
          </div>
        </section>

        <section className="panel" aria-labelledby="task-h">
          <div className="panel__head">
            <span id="task-h" className="eyebrow">
              {dict.run.task}
            </span>
            {selected === undefined ? null : (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSelected(undefined)}>
                {dict.common.clear}
              </button>
            )}
          </div>
          <div className="panel__body">
            <Inspector address={address} taskId={selected} card={selected === undefined ? undefined : cards.get(selected)} attention={attentionFor(selected)} past={past} liveState={selected === undefined ? undefined : liveStates.get(selected)} />
          </div>
        </section>

        <section className="panel" aria-labelledby="feed-h">
          <div className="panel__head">
            {/*
              Two logs, and they answer different questions: the tape of facts this run
              recorded, and what a runner actually said inside one stage. The event feed
              carries two kilobytes of the second on a failure and none of it otherwise.
            */}
            <div className="panel__tabs" role="tablist" aria-labelledby="feed-h">
              <span id="feed-h" className="visually-hidden">{dict.inspector.log}</span>
              <button type="button" role="tab" aria-selected={logTab === 'events'} onClick={() => setLogTab('events')}>{dict.run.events}</button>
              <button type="button" role="tab" aria-selected={logTab === 'stage'} onClick={() => setLogTab('stage')}>{dict.run.stageOutput}</button>
            </div>
            <span className="section__count">
              {logTab === 'stage' ? '' : log.data === undefined ? '' : dict.inspector.lines(log.data.total)}
              {logTab === 'stage' ? '' : log.data?.truncated ? ` · ${dict.run.originCut}` : ''}
            </span>
          </div>
          <div className="panel__body">
            {logTab === 'events'
              ? <Feed timeline={timeline ?? buildTimeline([], now)} t={t} live={live} onJump={onJump} selected={selected} runId={runId} onOpenStageLog={onOpenStageLog} />
              : <StageLog address={address} stage={selectedStage} onStageChange={setSelectedStage} />}
          </div>
        </section>
      </div>

      <Outcome address={address} tab={outcomeTab} onTab={setOutcomeTab} reviewFreshness={rt?.reviewFreshness} />

      <GateDialog address={address} gate={gate.data} open={gateOpen} onClose={() => setGateOpen(false)} initialTab={gateTab} />
      <ConfirmCancel runId={runId} open={confirmCancel} onDismiss={() => setConfirmCancel(false)} onConfirm={() => void cancelRun()} />
    </main>
  );
}

function Axis({ label, done, total, tone }: { label: string; done: number; total: number; tone: 'ok' | 'live' | 'warn' | 'bad' }) {
  const dict = useT();
  const pct = total <= 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="axis" role="img" aria-label={dict.common.progressOf(label, done, total)}>
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
