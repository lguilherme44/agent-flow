import { useState } from 'react';
import type { AttentionItem, BoardCardView, TaskDetailView } from '@contracts/index.js';
import { ApiError, api, keys, type RunAddress } from '../../lib/api';
import type { StateAt } from '../../lib/replay';
import { invalidate, useResource } from '../../lib/store';
import { formatClock, formatDuration } from '../../lib/time';
import { taskTone, words } from '../../lib/tone';
import { Chip, Empty, Notice, Skeleton } from '../../components/ui';

/**
 * One task, as the server describes it.
 *
 * The facts are live, always: `/tasks/:id` and the board card from `/control`. When the
 * playhead is in the past, a notice says what the log said the task was doing *then*, and
 * the facts below stay the present — two instants on one panel, labelled, rather than one
 * panel quietly mixing them.
 *
 * The one action here is the one the attention queue recommends for this task. There is
 * no button whose only outcome is a refusal.
 */
export function Inspector({ address, taskId, card, attention, past, liveState }: { address: RunAddress; taskId: string | undefined; card: BoardCardView | undefined; attention: AttentionItem | undefined; past: StateAt | undefined; liveState: string | undefined }) {
  const detail = useResource<TaskDetailView>(taskId === undefined ? null : keys.task(address, taskId), () => api.task(address, taskId ?? ''));
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ApiError | undefined>(undefined);
  const [attemptShown, setAttemptShown] = useState<number | undefined>(undefined);

  if (taskId === undefined) {
    return <Empty hint="Click a lane on the recorder, a node on the graph, or a line in the feed.">No task selected.</Empty>;
  }

  const then = past?.tasks.get(taskId);
  const data = detail.data;

  const retry = async (force: boolean): Promise<void> => {
    setBusy(true);
    setRefusal(undefined);
    try {
      await api.retry(address, taskId, force);
      invalidate((key) => key.includes(`/runs/${address.runId}`));
    } catch (error) {
      if (error instanceof ApiError) setRefusal(error);
    } finally {
      setBusy(false);
    }
  };

  const logs = data?.attemptLogs !== undefined && data.attemptLogs.length > 0 ? data.attemptLogs : undefined;
  const shown = logs === undefined ? data?.log ?? [] : (logs.find((entry) => entry.attempt === attemptShown) ?? logs[logs.length - 1])?.lines ?? [];
  const tail = shown.slice(-80);

  return (
    <div>
      <div className="inspector__title">
        <span className="inspector__id" style={taskId.startsWith('FIX') ? { color: 'var(--warn)' } : undefined}>
          {taskId}
        </span>
        <Chip tone={taskTone(liveState ?? data?.state)}>{words(liveState ?? data?.state)}</Chip>
        {data?.awaitingIntegration ? (
          <Chip tone="idle" plain>
            awaiting integration
          </Chip>
        ) : null}
        {data?.workspaceActive ? (
          <Chip tone="live" plain>
            in worktree
          </Chip>
        ) : null}
      </div>
      {data === undefined ? null : <p className="inspector__name">{data.title}</p>}

      {past !== undefined ? (
        <div style={{ marginTop: 12 }}>
          <Notice tone="warn" k={`at ${formatClock(past.at)}`}>
            {then === undefined ? (
              <>The log had not mentioned this task yet.</>
            ) : (
              <>
                <b style={{ color: `var(--${taskTone(then.state)})` }}>{words(then.state)}</b>
                {then.attempt > 0 ? ` · attempt ${String(then.attempt)}` : ''}
                {then.agent === undefined ? '' : ` · ${then.agent}`}
                <span className="faint"> — the facts below are the present.</span>
              </>
            )}
          </Notice>
        </div>
      ) : null}

      {detail.error !== undefined ? (
        <Empty error>This task could not be read.</Empty>
      ) : data === undefined ? (
        <Skeleton rows={4} />
      ) : (
        <>
          <div className="facts-grid">
            <Fact k="complexity" v={data.complexity} />
            <Fact k="risk" v={data.risk} tone={data.risk === 'high' ? 'bad' : data.risk === 'medium' ? 'warn' : undefined} />
            <Fact k="attempts" v={String(data.attempts)} />
            <Fact k="runner" v={data.runner ?? '—'} />
            <Fact k="model" v={data.model ?? 'not recorded'} tone={data.model === undefined ? 'ghost' : undefined} />
            <Fact k="reasoning" v={data.reasoning === undefined ? '—' : `${words(data.reasoning)}${data.reasoningClamped ? ' · clamped' : ''}`} />
            <Fact k="duration" v={formatDuration(data.durationMs)} />
            <Fact k="validation" v={data.validationPassed === undefined ? '—' : data.validationPassed ? 'passed' : 'failed'} tone={data.validationPassed === undefined ? undefined : data.validationPassed ? 'ok' : 'bad'} />
            {data.blockReason === undefined ? null : <Fact k="blocked by" v={data.blockReason === 'agent' ? 'the agent' : 'a dependency'} tone="warn" />}
            {data.correctiveFor === undefined ? null : <Fact k="corrects" v={`${data.correctiveFor.findingType} · ${data.correctiveFor.stage}`} tone="warn" />}
            {data.fallback === undefined ? null : <Fact k="fallback" v={`from ${data.fallback.from} · ${words(data.fallback.errorCode)}`} tone="warn" />}
            {data.errorCode === undefined ? null : <Fact k="error" v={words(data.errorCode)} tone="bad" />}
            {data.integration === undefined ? null : <Fact k="integrated" v={`${data.integration.mergeCommit.slice(0, 10)} · attempt ${String(data.integration.attempt)}`} tone="ok" />}
          </div>

          {card === undefined ? null : (
            <div className="reason" data-tone={card.reason.cause === 'none' ? 'ok' : card.reason.cause === 'failure' || card.reason.cause === 'integration' ? 'bad' : 'warn'}>
              <span className="reason__k">
                {words(card.lane)}
                {card.reason.cause === 'none' ? '' : ` · ${words(card.reason.cause)}`}
                {card.agentName === undefined ? '' : ` · ${card.agentName}`}
                {card.blockingFindings > 0 ? ` · ${String(card.blockingFindings)} blocking finding${card.blockingFindings === 1 ? '' : 's'}` : ''}
              </span>
              {card.reason.text}
            </div>
          )}

          {attention === undefined ? null : (
            <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {attention.action.kind === 'retry' ? (
                <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void retry(false)}>
                  {attention.action.label}
                </button>
              ) : null}
              <span className="faint" style={{ fontSize: 12 }}>
                {attention.priority} · {attention.what}
              </span>
            </div>
          )}
          {refusal === undefined ? null : (
            <div style={{ marginTop: 8 }}>
              <Notice tone={refusal.forcible ? 'warn' : 'bad'} k={refusal.code ?? 'refused'}>
                {refusal.message}
                {refusal.action === undefined ? '' : ` ${refusal.action}`}
                {refusal.forcible ? (
                  <>
                    {' '}
                    <button type="button" className="btn btn--sm btn--danger" disabled={busy} onClick={() => void retry(true)} style={{ marginLeft: 8 }}>
                      Retry anyway
                    </button>
                  </>
                ) : null}
              </Notice>
            </div>
          )}

          {data.attemptHistory !== undefined && data.attemptHistory.length > 0 ? (
            <>
              <div className="sub">
                <span className="eyebrow">Attempts</span>
                <span className="section__count">{data.attemptHistory.length}</span>
              </div>
              <div className="attempts">
                {data.attemptHistory.map((attempt) => (
                  <div key={attempt.attempt} className="attempt" data-tone={attempt.outcome === 'succeeded' ? 'ok' : 'bad'}>
                    <span className="attempt__n">#{attempt.attempt}</span>
                    <span className="attempt__what">
                      <b>{attempt.outcome}</b>
                      {attempt.failureClass === undefined ? '' : ` · ${words(attempt.failureClass)}`}
                      {attempt.consumedAttempt === false ? ' · did not spend an attempt' : ''}
                      {attempt.failedCommands.length > 0 ? ` · failed: ${attempt.failedCommands.join(', ')}` : ''}
                    </span>
                    <span className="attempt__meta">
                      {attempt.runner}
                      {attempt.model === undefined ? '' : ` · ${attempt.model}`} · {formatDuration(Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt))}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {data.acceptanceCriteria.length > 0 ? (
            <>
              <div className="sub">
                <span className="eyebrow">Acceptance</span>
              </div>
              <ul className="warnlist">
                {data.acceptanceCriteria.map((criterion, index) => (
                  <li key={index}>{criterion}</li>
                ))}
              </ul>
            </>
          ) : null}

          {data.filesChanged.length > 0 ? (
            <>
              <div className="sub">
                <span className="eyebrow">Files changed</span>
                <span className="section__count">{data.filesChanged.length}</span>
              </div>
              <div className="pick">
                {data.filesChanged.slice(0, 24).map((file) => (
                  <span key={file} className="pick__item" title={file}>
                    {file.length > 40 ? `…${file.slice(-39)}` : file}
                  </span>
                ))}
              </div>
            </>
          ) : null}

          <div className="sub">
            <span className="eyebrow">Log</span>
            {logs === undefined ? (
              <span className="section__count">{shown.length} lines</span>
            ) : (
              <div className="pick">
                {logs.map((entry) => (
                  <button key={entry.attempt} type="button" className="pick__item" aria-pressed={(attemptShown ?? logs[logs.length - 1]?.attempt) === entry.attempt} onClick={() => setAttemptShown(entry.attempt)}>
                    attempt {entry.attempt}
                  </button>
                ))}
              </div>
            )}
          </div>
          {tail.length === 0 ? <Empty>No log lines.</Empty> : <pre className="log">{tail.join('\n')}</pre>}
        </>
      )}
    </div>
  );
}

function Fact({ k, v, tone }: { k: string; v: string; tone?: 'ok' | 'live' | 'warn' | 'bad' | 'idle' | 'ghost' | undefined }) {
  return (
    <div className="fact">
      <span className="fact__k">{k}</span>
      <span className="fact__v" data-tone={tone}>
        {v}
      </span>
    </div>
  );
}
