import { useMemo, useState } from 'react';
import type { StageViewResponse } from '@contracts/index.js';
import { formatClock, formatDuration, MINUTE } from '../../lib/time';
import { useT, word } from '../../lib/i18n';
import { stageTone } from '../../lib/tone';
import { phasesOf, type PhaseId } from '../../lib/phases';

export interface ExecutionProgressProps {
  readonly stages: StageViewResponse[] | undefined;
  readonly activeStage: string | undefined;
  /** The gate the run is held at for a person, when it is. */
  readonly awaiting?: string | undefined;
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

export function ExecutionProgress({
  stages,
  activeStage,
  awaiting,
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
  const long: Readonly<Record<string, string | undefined>> = dict.stageLong;
  const [picked, setPicked] = useState<PhaseId | undefined>(undefined);

  const phases = useMemo(() => phasesOf(stages, activeStage, finished, awaiting), [stages, activeStage, finished, awaiting]);

  // The phase that is moving or holding the run, else the last one that happened.
  const current =
    phases.find((phase) => ['running', 'waiting_approval', 'blocked', 'failed'].includes(phase.status)) ??
    [...phases].reverse().find((phase) => phase.status !== 'pending') ??
    phases[0];
  const selected = phases.find((phase) => phase.id === picked) ?? current;

  const { total, completed, running, attention, queued } = tasksCount;

  const subline = (phase: (typeof phases)[number]): string => {
    if (phase.status === 'failed') return dict.run.phaseFailed;
    if (phase.status === 'waiting_approval') return dict.run.phaseWaiting;
    if (phase.id === 'approve' && phase.status === 'completed') return dict.run.phaseApproved;
    if (phase.id === 'build' && total > 0) return dict.run.phaseTasks(completed, total);
    if (phase.status === 'running' && phase.current !== undefined) return long[phase.current] ?? phase.current;
    if (phase.status === 'completed') return phase.durationMs > 0 ? formatDuration(phase.durationMs) : word(dict, 'completed');
    return dict.run.phaseNotStarted;
  };

  const stepBack = () => onScrub(Math.max(domain[0], t - MINUTE));
  const stepForward = () => {
    const next = t + MINUTE;
    if (next >= domain[1]) onScrub(null);
    else onScrub(next);
  };

  return (
    <section className="phases" aria-label={dict.run.stepperStages}>
      <ol className="phases__track" style={{ ['--phases' as string]: String(phases.length) }}>
        {phases.map((phase, index) => {
          const tone = stageTone(phase.status);
          const isSelected = selected?.id === phase.id;
          return (
            <li key={phase.id} className="phase" data-tone={tone} data-status={phase.status}>
              <button type="button" className="phase__btn" aria-pressed={isSelected} onClick={() => setPicked(phase.id)}>
                <span className="phase__mark" aria-hidden="true">
                  {phase.status === 'completed' ? '✓' : phase.status === 'failed' ? '✕' : phase.status === 'waiting_approval' || phase.status === 'blocked' ? '!' : index + 1}
                </span>
                <span className="phase__text">
                  <span className="phase__name">{dict.run.phase[phase.id]}</span>
                  <span className="phase__sub">{subline(phase)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {selected === undefined ? null : (
        <div className="phases__detail">
          <span className="eyebrow">{dict.run.phaseStagesOf(dict.run.phase[selected.id])}</span>
          <ul className="phases__stages">
            {selected.stages.map(({ stage, status, view }) => (
              <li key={stage}>
                <button
                  type="button"
                  className="phase-stage"
                  data-tone={stageTone(status)}
                  onClick={() => onOpenStageLog(stage)}
                  title={dict.run.stageOpenLog}
                >
                  <span className="phase-stage__dot" aria-hidden="true" />
                  <span className="phase-stage__name">{long[stage] ?? stage}</span>
                  <span className="phase-stage__meta">
                    {word(dict, status)}
                    {view?.durationMs === undefined ? '' : ` · ${formatDuration(view.durationMs)}`}
                    {view?.model === undefined ? '' : ` · ${view.model}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {selected.id === 'build' && total > 0 ? (
            <div className="phases__tasks">
              <div className="phases__bar" role="progressbar" aria-valuenow={completed} aria-valuemin={0} aria-valuemax={total}>
                {[
                  ['ok', completed],
                  ['live', running],
                  ['warn', attention],
                  ['idle', queued],
                ].map(([tone, count]) =>
                  Number(count) > 0 ? <span key={String(tone)} data-tone={tone} style={{ flexGrow: Number(count) }} /> : null,
                )}
              </div>
              <span className="phases__task-stats">
                {dict.run.phaseTasks(completed, total)}
                {running > 0 ? ` · ${dict.run.tasksRunning(running)}` : ''}
                {attention > 0 ? ` · ${dict.run.tasksAttention(attention)}` : ''}
                {queued > 0 ? ` · ${dict.run.tasksQueued(queued)}` : ''}
              </span>
            </div>
          ) : null}
        </div>
      )}

      <div className="phases__foot">
        {showTimeline ? (
          <div className="phases__replay">
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onScrub(domain[0])}>
              {dict.run.replayStart}
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={stepBack}>
              {dict.run.replayBack}
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={stepForward} disabled={live}>
              {dict.run.replayForward}
            </button>
            <button type="button" className={live ? 'btn btn--sm btn--primary' : 'btn btn--sm btn--ghost'} onClick={() => onScrub(null)}>
              {live && finished ? dict.recorder.endCap : dict.run.replayLive}
            </button>
            <span className="phases__clock" data-live={live}>
              {live ? formatClock(t) : `${formatClock(t)} · ${dict.run.replayPast}`}
            </span>
          </div>
        ) : (
          <span />
        )}
        <button type="button" className="btn btn--sm btn--ghost" onClick={onToggleTimeline} aria-expanded={showTimeline}>
          {dict.run.timelineToggle} {showTimeline ? '▴' : '▾'}
        </button>
      </div>
    </section>
  );
}
