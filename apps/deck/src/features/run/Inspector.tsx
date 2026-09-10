import { useState } from 'react';
import type { AttentionItem, BoardCardView, TaskDetailView } from '@contracts/index.js';
import { ApiError, api, keys, type RunAddress } from '../../lib/api';
import type { StateAt } from '../../lib/replay';
import { invalidate, useResource } from '../../lib/store';
import { formatClock, formatDuration } from '../../lib/time';
import { taskTone } from '../../lib/tone';
import { level, useT, word } from '../../lib/i18n';
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
  const t = useT();
  const detail = useResource<TaskDetailView>(taskId === undefined ? null : keys.task(address, taskId), () => api.task(address, taskId ?? ''));
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ApiError | undefined>(undefined);
  const [attemptShown, setAttemptShown] = useState<number | undefined>(undefined);

  if (taskId === undefined) {
    return <Empty hint={t.inspector.pickHint}>{t.inspector.noTask}</Empty>;
  }

  const then = past?.tasks.get(taskId);
  const data = detail.data;

  const retry = async (force: boolean, expectNoChange = false): Promise<void> => {
    setBusy(true);
    setRefusal(undefined);
    try {
      await api.retry(address, taskId, force, expectNoChange);
      invalidate((key) => key.includes(`/runs/${address.runId}`));
    } catch (error) {
      if (error instanceof ApiError) setRefusal(error);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Whether this task died because its diff was empty (PRI-20).
   *
   * Read off the newest attempt rather than the task state, because the class is what the
   * attempt artifact recorded and the state keeps only the last outcome. When it is this,
   * an ordinary retry runs the same work to the same empty tree and fails identically —
   * two runs in the evidence set spent every attempt that way and ended somewhere a person
   * could only cancel. The second button is the only thing that changes the outcome.
   */
  const emptyDiff =
    data?.attemptHistory?.[data.attemptHistory.length - 1]?.failureClass === 'acceptance_evidence_missing';

  const logs = data?.attemptLogs !== undefined && data.attemptLogs.length > 0 ? data.attemptLogs : undefined;
  const shown = logs === undefined ? data?.log ?? [] : (logs.find((entry) => entry.attempt === attemptShown) ?? logs[logs.length - 1])?.lines ?? [];
  const tail = shown.slice(-80);

  return (
    <div>
      <div className="inspector__title">
        <span className="inspector__id" style={taskId.startsWith('FIX') ? { color: 'var(--warn)' } : undefined}>
          {taskId}
        </span>
        <Chip tone={taskTone(liveState ?? data?.state)}>{word(t, liveState ?? data?.state)}</Chip>
        {data?.awaitingIntegration ? (
          <Chip tone="idle" plain>
            {t.inspector.awaitingIntegration}
          </Chip>
        ) : null}
        {data?.workspaceActive ? (
          <Chip tone="live" plain>
            {t.inspector.inWorktree}
          </Chip>
        ) : null}
      </div>
      {data === undefined ? null : <p className="inspector__name">{data.title}</p>}

      {past !== undefined ? (
        <div style={{ marginTop: 12 }}>
          <Notice tone="warn" k={t.inspector.at(formatClock(past.at))}>
            {then === undefined ? (
              <>{t.inspector.notMentionedYet}</>
            ) : (
              <>
                <b style={{ color: `var(--${taskTone(then.state)})` }}>{word(t, then.state)}</b>
                {then.attempt > 0 ? ` · ${t.events.attemptN(then.attempt)}` : ''}
                {then.agent === undefined ? '' : ` · ${then.agent}`}
                <span className="faint"> {t.inspector.factsArePresent}</span>
              </>
            )}
          </Notice>
        </div>
      ) : null}

      {detail.error !== undefined ? (
        <Empty error>{t.inspector.couldNotRead}</Empty>
      ) : data === undefined ? (
        <Skeleton rows={4} />
      ) : (
        <>
          <div className="facts-grid">
            <Fact k={t.inspector.complexity} v={word(t, data.complexity)} />
            <Fact k={t.inspector.risk} v={level(t, data.risk)} tone={data.risk === 'high' ? 'bad' : data.risk === 'medium' ? 'warn' : undefined} />
            <Fact k={t.inspector.attempts} v={String(data.attempts)} />
            <Fact k={t.inspector.runner} v={data.runner ?? t.common.none} />
            <Fact k={t.inspector.model} v={data.model ?? t.inspector.notRecorded} tone={data.model === undefined ? 'ghost' : undefined} />
            <Fact k={t.inspector.reasoning} v={data.reasoning === undefined ? t.common.none : `${level(t, data.reasoning)}${data.reasoningClamped ? ` · ${t.inspector.clamped}` : ''}`} />
            <Fact k={t.inspector.duration} v={formatDuration(data.durationMs)} />
            <Fact k={t.inspector.validation} v={data.validationPassed === undefined ? t.common.none : data.validationPassed ? word(t, 'passed') : word(t, 'failed')} tone={data.validationPassed === undefined ? undefined : data.validationPassed ? 'ok' : 'bad'} />
            {data.blockReason === undefined ? null : <Fact k={t.inspector.blockedBy} v={data.blockReason === 'agent' ? t.inspector.theAgent : t.inspector.aDependency} tone="warn" />}
            {data.correctiveFor === undefined ? null : <Fact k={t.inspector.corrects} v={`${data.correctiveFor.findingType} · ${word(t, data.correctiveFor.stage)}`} tone="warn" />}
            {data.fallback === undefined ? null : <Fact k={t.inspector.fallback} v={t.inspector.fallbackFrom(data.fallback.from, word(t, data.fallback.errorCode))} tone="warn" />}
            {data.errorCode === undefined ? null : <Fact k={t.inspector.error} v={word(t, data.errorCode)} tone="bad" />}
            {data.integration === undefined ? null : <Fact k={t.inspector.integrated} v={`${data.integration.mergeCommit.slice(0, 10)} · ${t.events.attemptN(data.integration.attempt)}`} tone="ok" />}
          </div>

          {card === undefined ? null : (
            <div className="reason" data-tone={card.reason.cause === 'none' ? 'ok' : card.reason.cause === 'failure' || card.reason.cause === 'integration' ? 'bad' : 'warn'}>
              <span className="reason__k">
                {word(t, card.lane)}
                {card.reason.cause === 'none' ? '' : ` · ${word(t, card.reason.cause)}`}
                {card.agentName === undefined ? '' : ` · ${card.agentName}`}
                {card.blockingFindings > 0 ? ` · ${t.inspector.blockingFindings(card.blockingFindings)}` : ''}
              </span>
              {card.reason.text}
            </div>
          )}

          {attention === undefined && !emptyDiff ? null : (
            <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {attention?.action.kind === 'retry' ? (
                <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void retry(false)}>
                  {attention.action.label}
                </button>
              ) : null}
              {emptyDiff ? (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void retry(false, true)}
                  title={t.inspector.changesNothingTitle}
                >
                  {t.inspector.changesNothing}
                </button>
              ) : null}
              <span className="faint" style={{ fontSize: 12 }}>
                {attention === undefined
                  ? t.inspector.identicalTree
                  : `${attention.priority} · ${attention.what}`}
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
                      {t.inspector.retryAnyway}
                    </button>
                  </>
                ) : null}
              </Notice>
            </div>
          )}

          {data.attemptHistory !== undefined && data.attemptHistory.length > 0 ? (
            <>
              <div className="sub">
                <span className="eyebrow">{t.inspector.attemptsHeading}</span>
                <span className="section__count">{data.attemptHistory.length}</span>
              </div>
              <div className="attempts">
                {data.attemptHistory.map((attempt) => (
                  <div key={attempt.attempt} className="attempt" data-tone={attempt.outcome === 'succeeded' ? 'ok' : 'bad'}>
                    <span className="attempt__n">#{attempt.attempt}</span>
                    <span className="attempt__what">
                      <b>{word(t, attempt.outcome)}</b>
                      {attempt.failureClass === undefined ? '' : ` · ${word(t, attempt.failureClass)}`}
                      {attempt.consumedAttempt === false ? ` · ${t.inspector.didNotSpend}` : ''}
                      {attempt.failedCommands.length > 0 ? ` · ${t.inspector.failedCommands(attempt.failedCommands.join(', '))}` : ''}
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
                <span className="eyebrow">{t.inspector.acceptance}</span>
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
                <span className="eyebrow">{t.inspector.filesChanged}</span>
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
            <span className="eyebrow">{t.inspector.log}</span>
            {logs === undefined ? (
              <span className="section__count">{t.inspector.lines(shown.length)}</span>
            ) : (
              <div className="pick">
                {logs.map((entry) => (
                  <button key={entry.attempt} type="button" className="pick__item" aria-pressed={(attemptShown ?? logs[logs.length - 1]?.attempt) === entry.attempt} onClick={() => setAttemptShown(entry.attempt)}>
                    {t.events.attemptN(entry.attempt)}
                  </button>
                ))}
              </div>
            )}
          </div>
          {tail.length === 0 ? <Empty>{t.inspector.noLogLines}</Empty> : <pre className="log">{tail.join('\n')}</pre>}
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
