import { useMemo } from 'react';
import type { PipelineStage, StageViewResponse } from '@contracts/index.js';
import { formatClock, MINUTE } from '../../lib/time';
import { useT, word } from '../../lib/i18n';
import { stageTone } from '../../lib/tone';

export interface ExecutionProgressProps {
  readonly stages: StageViewResponse[] | undefined;
  readonly activeStage: string | undefined;
  readonly onOpenStageLog: (stage: string) => void;
  readonly domain: readonly [number, number];
  readonly t: number;
  readonly live: boolean;
  readonly finished: boolean;
  readonly onScrub: (t: number | null) => void;
  readonly tasksCount: {
    readonly total: number;
    readonly completed: number;
    readonly running: number;
    readonly attention: number;
    readonly queued: number;
  };
  readonly showTimeline: boolean;
  readonly onToggleTimeline: () => void;
}

const ORDERED_STAGES: readonly PipelineStage[] = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
  'verification',
  'e2e',
  'final-review',
];

export function ExecutionProgress({
  stages,
  activeStage,
  onOpenStageLog,
  domain,
  t,
  live,
  finished,
  onScrub,
  tasksCount,
  showTimeline,
  onToggleTimeline,
}: ExecutionProgressProps) {
  const dict = useT();
  const short: Readonly<Record<string, string | undefined>> = dict.stageShort;

  const stageMap = useMemo(() => {
    const map = new Map<string, StageViewResponse>();
    for (const s of stages ?? []) {
      map.set(s.stage, s);
    }
    return map;
  }, [stages]);

  const { total, completed, running, attention, queued } = tasksCount;
  const completedPct = total > 0 ? (completed / total) * 100 : 0;
  const runningPct = total > 0 ? (running / total) * 100 : 0;
  const attentionPct = total > 0 ? (attention / total) * 100 : 0;
  const queuedPct = total > 0 ? (queued / total) * 100 : 0;

  const stepBack = () => onScrub(Math.max(domain[0], t - MINUTE));
  const stepForward = () => {
    const next = t + MINUTE;
    if (next >= domain[1]) onScrub(null);
    else onScrub(next);
  };
  const jumpStart = () => onScrub(domain[0]);
  const jumpLive = () => onScrub(null);

  return (
    <div className="exec-progress">
      {/* 1. Pipeline Stage Stepper */}
      <div className="exec-progress__stepper-wrap">
        <div className="exec-progress__stepper" role="list" aria-label={dict.run.stepperStages}>
          {ORDERED_STAGES.map((stageName, index) => {
            const stg = stageMap.get(stageName);
            const status = stg?.status ?? (activeStage === stageName ? 'running' : 'pending');
            const tone = stageTone(status);
            const isCurrent = activeStage === stageName;
            return (
              <div key={stageName} className="exec-progress__step" role="listitem" data-status={status} data-current={isCurrent}>
                {index > 0 ? <div className="exec-progress__step-line" data-tone={stg?.status ? tone : 'idle'} /> : null}
                <button
                  type="button"
                  className="exec-progress__step-btn"
                  data-tone={tone}
                  onClick={() => onOpenStageLog(stageName)}
                  title={`${short[stageName] ?? stageName} · ${word(dict, status)} (clique para ver logs)`}
                >
                  <span className="exec-progress__step-dot">
                    {status === 'completed' ? '✓' : status === 'failed' ? '✕' : status === 'running' ? '⟳' : index + 1}
                  </span>
                  <span className="exec-progress__step-label">{short[stageName] ?? stageName}</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* 2. Tasks Progress Bar & Summary */}
      <div className="exec-progress__summary">
        <div className="exec-progress__bar-wrap">
          <div className="exec-progress__bar" role="progressbar" aria-valuenow={completed} aria-valuemin={0} aria-valuemax={total}>
            {completedPct > 0 ? <div className="exec-progress__bar-segment" data-tone="ok" style={{ width: `${completedPct}%` }} title={`Concluídas: ${completed}`} /> : null}
            {runningPct > 0 ? <div className="exec-progress__bar-segment" data-tone="live" style={{ width: `${runningPct}%` }} title={`Executando: ${running}`} /> : null}
            {attentionPct > 0 ? <div className="exec-progress__bar-segment" data-tone="warn" style={{ width: `${attentionPct}%` }} title={`Atenção/Falha: ${attention}`} /> : null}
            {queuedPct > 0 ? <div className="exec-progress__bar-segment" data-tone="idle" style={{ width: `${queuedPct}%` }} title={`Na fila: ${queued}`} /> : null}
          </div>
          <div className="exec-progress__stats">
            <span className="exec-progress__stat" data-tone="ok">
              <b>{completed}</b> de <b>{total}</b> tarefas concluídas ({Math.round(completedPct)}%)
            </span>
            {running > 0 ? (
              <span className="exec-progress__stat" data-tone="live">
                <b>{running}</b> executando
              </span>
            ) : null}
            {attention > 0 ? (
              <span className="exec-progress__stat" data-tone="warn">
                <b>{attention}</b> atenção / bloqueado
              </span>
            ) : null}
            {queued > 0 ? (
              <span className="exec-progress__stat" data-tone="idle">
                <b>{queued}</b> na fila
              </span>
            ) : null}
          </div>
        </div>

        {/* 3. Controls & Scrubber */}
        <div className="exec-progress__controls">
          <div className="exec-progress__playback">
            <button type="button" className="btn btn--sm btn--ghost" onClick={jumpStart} title="Ir para o início">
              ⏮ Início
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={stepBack} title="-1 minuto">
              ⏪ -1m
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={stepForward} title="+1 minuto" disabled={live}>
              +1m ⏩
            </button>
            <button
              type="button"
              className={live ? 'btn btn--sm btn--primary' : 'btn btn--sm btn--ghost'}
              onClick={jumpLive}
              title="Voltar para o feed ao vivo"
            >
              {live ? (finished ? dict.recorder.endCap : '● AO VIVO') : 'Ir ao vivo ⏭'}
            </button>
            <span className="exec-progress__time-badge" data-live={live}>
              {live ? formatClock(t) : `${formatClock(t)} (passado)`}
            </span>
          </div>

          <button
            type="button"
            className="btn btn--sm btn--ghost exec-progress__timeline-toggle"
            onClick={onToggleTimeline}
            aria-expanded={showTimeline}
          >
            {showTimeline ? '▲ Ocultar Linha do Tempo' : '▼ Expandir Linha do Tempo'}
          </button>
        </div>
      </div>
    </div>
  );
}
