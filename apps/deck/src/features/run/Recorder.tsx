import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Marker, StateAt, Timeline } from '../../lib/replay';
import { neighbour } from '../../lib/replay';
import { describe } from '../../lib/sentence';
import { MINUTE, formatClock, formatDay, formatOffset, scaleTime, stepOf, tickLabel, ticks } from '../../lib/time';
import { stageTone, taskTone, type Tone } from '../../lib/tone';

/**
 * The recorder: the run as a strip of time you can drag through.
 *
 * Top to bottom — the clock, the ten-stage tape drawn to true duration, the run's own
 * marks (approval, revision, degradation, findings), one lane per task with a bar per
 * attempt and its marks, and a playhead. Drag the playhead and the page below shows what
 * the log said was true at that instant; let it go at the right edge, or press LIVE, and
 * the server's answer takes over again.
 *
 * Draws the fold in `lib/replay.ts` and decides nothing itself. Every bar is a line of the
 * log with its `at` read off.
 */

export const STAGE_SHORT: Record<string, string> = {
  discovery: 'discovery',
  'architecture-impact': 'architecture',
  sdd: 'sdd',
  planning: 'planning',
  'plan-review': 'plan review',
  approval: 'approval',
  implementation: 'implementation',
  'code-review': 'code review',
  verification: 'verification',
  'final-review': 'final review',
};

const AXIS_H = 34;
const TAPE_Y = AXIS_H + 6;
const TAPE_H = 18;
const RUNROW_Y = TAPE_Y + TAPE_H + 8;
const RUNROW_H = 16;
const HEAD_H = RUNROW_Y + RUNROW_H + 6;
const ROW_H = 22;
const RIGHT_PAD = 16;

export interface RecorderProps {
  readonly timeline: Timeline;
  readonly domain: readonly [number, number];
  readonly t: number;
  readonly live: boolean;
  readonly finished: boolean;
  readonly truncated: boolean;
  readonly onScrub: (t: number | null) => void;
  readonly selected: string | undefined;
  readonly onSelect: (task: string | undefined) => void;
  /** Every task the plan names, in the order to draw them. */
  readonly rows: readonly { readonly id: string; readonly title: string }[];
  /** Live task states from the server, by id. */
  readonly liveStates: ReadonlyMap<string, string>;
  readonly past: StateAt | undefined;
}

function markerGlyph(kind: Marker['kind']): { tone: Tone; shape: 'diamond' | 'circle' | 'square' | 'x' | 'tri' | 'tick' } {
  switch (kind) {
    case 'approved':
      return { tone: 'warn', shape: 'diamond' };
    case 'rejected':
      return { tone: 'bad', shape: 'diamond' };
    case 'revision':
      return { tone: 'warn', shape: 'tri' };
    case 'validated':
      return { tone: 'ok', shape: 'tick' };
    case 'integrated':
      return { tone: 'ok', shape: 'square' };
    case 'recovery':
      return { tone: 'warn', shape: 'circle' };
    case 'exhausted':
      return { tone: 'bad', shape: 'x' };
    case 'finding':
      return { tone: 'warn', shape: 'circle' };
    case 'gate':
      return { tone: 'idle', shape: 'square' };
    case 'degradation':
      return { tone: 'warn', shape: 'circle' };
    case 'corrective':
      return { tone: 'warn', shape: 'tri' };
    case 'requeued':
    case 'unblocked':
      return { tone: 'idle', shape: 'tri' };
    case 'assigned':
      return { tone: 'idle', shape: 'tick' };
    case 'forge':
      return { tone: 'live', shape: 'square' };
    case 'created':
      return { tone: 'idle', shape: 'circle' };
    case 'lock':
    case 'other':
    default:
      return { tone: 'ghost', shape: 'tick' };
  }
}

function Glyph({ x, y, marker, onClick }: { x: number; y: number; marker: Marker; onClick: () => void }) {
  const { tone, shape } = markerGlyph(marker.kind);
  const said = describe(marker.event);
  const title = `${formatClock(marker.at)} · ${said.title}${said.detail === undefined ? '' : ` — ${said.detail}`}`;
  const s = 4;
  const common = { className: 'svg-marker', 'data-tone': tone, onClick, style: { cursor: 'pointer' } } as const;
  let body: JSX.Element;
  switch (shape) {
    case 'diamond':
      body = <path {...common} d={`M${x} ${y - s - 1} L${x + s + 1} ${y} L${x} ${y + s + 1} L${x - s - 1} ${y} Z`} />;
      break;
    case 'square':
      body = <rect {...common} x={x - s} y={y - s} width={s * 2} height={s * 2} />;
      break;
    case 'x':
      body = (
        <g className="svg-marker" data-tone={tone} onClick={onClick} style={{ cursor: 'pointer' }}>
          <circle cx={x} cy={y} r={s + 1} className="svg-marker" data-tone={tone} />
          <path d={`M${x - 2.5} ${y - 2.5} L${x + 2.5} ${y + 2.5} M${x + 2.5} ${y - 2.5} L${x - 2.5} ${y + 2.5}`} stroke="var(--bg)" strokeWidth={1.5} />
        </g>
      );
      break;
    case 'tri':
      body = <path {...common} d={`M${x} ${y - s - 1} L${x + s + 1} ${y + s} L${x - s - 1} ${y + s} Z`} />;
      break;
    case 'tick':
      body = <rect {...common} x={x - 1} y={y - s - 1} width={2} height={s * 2 + 2} />;
      break;
    case 'circle':
    default:
      body = <circle {...common} cx={x} cy={y} r={s} />;
  }
  return (
    <g>
      <title>{title}</title>
      {body}
    </g>
  );
}

export function Recorder(props: RecorderProps) {
  const { timeline, domain, t, live, finished, truncated, onScrub, selected, onSelect, rows, liveStates, past } = props;
  const plotRef = useRef<HTMLDivElement>(null);
  const grabRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gutter = width < 760 ? 84 : 132;

  useEffect(() => {
    const element = plotRef.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    setWidth(Math.floor(element.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);

  const x0 = gutter;
  const x1 = Math.max(gutter + 40, width - RIGHT_PAD);
  const scale = useMemo(() => scaleTime(domain, [x0, x1]), [domain, x0, x1]);
  const axisTicks = useMemo(() => ticks(domain, x1 - x0), [domain, x0, x1]);
  const step = stepOf(axisTicks);

  const lanesH = rows.length * ROW_H + 8;
  const playX = scale(t);

  const scrubTo = useCallback(
    (clientX: number) => {
      const plot = plotRef.current;
      if (plot === null) return;
      const rect = plot.getBoundingClientRect();
      const x = clientX - rect.left;
      const instant = scale.invert(x);
      // Let go at the right edge on a moving run and you are back on the live feed.
      if (!finished && instant >= domain[1] - 250) onScrub(null);
      else onScrub(Math.round(instant));
    },
    [scale, domain, finished, onScrub],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    scrubTo(event.clientX);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return;
    scrubTo(event.clientX);
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    setDragging(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const fine = event.shiftKey ? MINUTE : undefined;
    switch (event.key) {
      case 'ArrowLeft': {
        event.preventDefault();
        const next = fine === undefined ? neighbour(timeline, t, -1) : Math.max(domain[0], t - fine);
        if (next !== undefined) onScrub(next);
        else onScrub(domain[0]);
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        const next = fine === undefined ? neighbour(timeline, t, 1) : Math.min(domain[1], t + fine);
        if (next === undefined || (!finished && next >= domain[1] - 250)) onScrub(null);
        else onScrub(next);
        break;
      }
      case 'Home':
        event.preventDefault();
        onScrub(domain[0]);
        break;
      case 'End':
      case 'Escape':
        event.preventDefault();
        onScrub(null);
        break;
      default:
        break;
    }
  };

  const runMarkers = timeline.markers.filter((marker) => marker.task === undefined);
  const taskMarkers = new Map<string, Marker[]>();
  for (const marker of timeline.markers) {
    if (marker.task === undefined) continue;
    const list = taskMarkers.get(marker.task) ?? [];
    list.push(marker);
    taskMarkers.set(marker.task, list);
  }

  const stateOf = (id: string): string | undefined => (past === undefined ? liveStates.get(id) : past.tasks.get(id)?.state);
  const jump = (marker: Marker): void => {
    onScrub(marker.at);
    if (marker.task !== undefined) onSelect(marker.task);
  };

  const tone: Tone = live ? 'live' : 'warn';
  const readout = live
    ? finished
      ? `${formatClock(domain[1])} · end of the log`
      : `${formatClock(t)} · now`
    : `${formatClock(t)} · ${formatOffset(t - domain[0])} from start`;

  return (
    <section className="panel recorder" aria-label="Run recorder">
      <div className="recorder__bar">
        <div className="recorder__mode" data-tone={tone}>
          <b>{live ? (finished ? 'RECORDED' : 'LIVE') : 'REPLAY'}</b>
          <span className="recorder__readout">
            {readout}
            {past === undefined ? null : (
              <small>
                {past.seen}/{timeline.events.length} lines
              </small>
            )}
            {truncated ? <small style={{ color: 'var(--warn)' }}>origin cut by the log cap</small> : null}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="recorder__keys" aria-hidden="true">
            <kbd>←</kbd>
            <kbd>→</kbd> step · <kbd>⇧</kbd> minute · <kbd>End</kbd> live
          </span>
          {live ? null : (
            <button type="button" className="btn btn--sm btn--primary" onClick={() => onScrub(null)}>
              ● {finished ? 'End' : 'Live'}
            </button>
          )}
        </div>
      </div>

      <div className="recorder__plot" ref={plotRef}>
        <svg className="recorder__svg" height={HEAD_H} width={width || undefined} role="img" aria-label="Stages and run marks over time">
          <defs>
            <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="var(--ghost-dim)" />
              <rect width="2" height="6" fill="var(--ink-4)" />
            </pattern>
          </defs>
          {/* axis */}
          {axisTicks.map((at, index) => {
            const date = new Date(at);
            const midnight = date.getHours() === 0 && date.getMinutes() === 0;
            // At a step of a day or more the tick itself reads as a date; a second line
            // would say the same thing twice.
            const dayLabel = step < 24 * 60 * MINUTE && (index === 0 || midnight) ? formatDay(at) : undefined;
            return (
              <g key={at}>
                <line className="svg-tick" x1={scale(at)} x2={scale(at)} y1={AXIS_H - 6} y2={AXIS_H} />
                <text className="svg-axis-label" x={scale(at)} y={AXIS_H - 10} textAnchor="middle">
                  {tickLabel(at, step)}
                </text>
                {dayLabel === undefined ? null : (
                  <text className="svg-axis-label" x={scale(at)} y={AXIS_H - 19} textAnchor="middle" style={{ fill: midnight ? 'var(--ink-2)' : undefined, fontWeight: midnight ? 700 : undefined }}>
                    {dayLabel}
                  </text>
                )}
              </g>
            );
          })}
          <line className="svg-grid" x1={x0} x2={x1} y1={AXIS_H} y2={AXIS_H} />
          <text className="svg-stage-name" x={8} y={TAPE_Y + TAPE_H / 2 + 3.5}>
            STAGES
          </text>
          <text className="svg-stage-name" x={8} y={RUNROW_Y + RUNROW_H / 2 + 3.5}>
            RUN
          </text>
          {/* stage tape */}
          {timeline.stages.map((span, index) => {
            const sx = scale(span.startedAt);
            const ex = span.endedAt === undefined ? scale(domain[1]) : scale(span.endedAt);
            const w = Math.max(3, ex - sx);
            const label = STAGE_SHORT[span.stage] ?? span.stage;
            const outcome = span.outcome === 'reused' ? 'cached' : span.outcome;
            return (
              <g key={`${span.stage}-${String(index)}`} data-tone={stageTone(outcome)}>
                <title>{`${label} · ${span.outcome}${span.runner === undefined ? '' : ` · ${span.runner}`}${span.model === undefined ? '' : ` · ${span.model}`}`}</title>
                <rect className="svg-attempt" data-outcome={span.outcome} x={sx} y={TAPE_Y} width={w} height={TAPE_H} rx={2} />
                {w > label.length * 6.4 + 10 ? (
                  <text className="svg-tape-label" x={sx + 5} y={TAPE_Y + TAPE_H / 2 + 3.5}>
                    {label}
                  </text>
                ) : null}
              </g>
            );
          })}
          {/* run-level markers */}
          {runMarkers.map((marker) => (
            <Glyph key={`${String(marker.index)}`} x={scale(marker.at)} y={RUNROW_Y + RUNROW_H / 2} marker={marker} onClick={() => jump(marker)} />
          ))}
          {/* now */}
          {finished ? null : <line className="svg-now" x1={scale(domain[1])} x2={scale(domain[1])} y1={AXIS_H} y2={HEAD_H} />}
          {live ? null : <rect className="svg-future" x={playX} y={AXIS_H} width={Math.max(0, x1 - playX)} height={HEAD_H - AXIS_H} />}
        </svg>

        <div className="recorder__lanes">
          <svg className="recorder__svg" height={lanesH} width={width || undefined} role="img" aria-label="Task attempts over time">
            {axisTicks.map((at) => (
              <line key={at} className="svg-grid" x1={scale(at)} x2={scale(at)} y1={0} y2={lanesH} />
            ))}
            {rows.map((row, index) => {
              const y = index * ROW_H + 4;
              const state = stateOf(row.id);
              const isSelected = selected === row.id;
              const attempts = timeline.attempts.filter((span) => span.task === row.id);
              return (
                <g key={row.id}>
                  <rect
                    className="svg-row-band"
                    data-selected={isSelected}
                    x={0}
                    y={y}
                    width={Math.max(width, x1)}
                    height={ROW_H}
                    onClick={() => onSelect(isSelected ? undefined : row.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <title>{`${row.id} · ${row.title}${state === undefined ? '' : ` · ${state}`}`}</title>
                  </rect>
                  <g data-tone={taskTone(state)}>
                    <circle cx={12} cy={y + ROW_H / 2} r={3} fill="var(--tone)" />
                  </g>
                  <text
                    className={row.id.startsWith('FIX') ? 'svg-lane-label svg-lane-label--fix' : 'svg-lane-label'}
                    data-selected={isSelected}
                    x={22}
                    y={y + ROW_H / 2 + 3.5}
                    onClick={() => onSelect(isSelected ? undefined : row.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    {row.id}
                  </text>
                  {attempts.map((span) => {
                    const sx = scale(span.startedAt);
                    const ex = span.endedAt === undefined ? (span.outcome === 'running' ? scale(domain[1]) : sx + 3) : scale(span.endedAt);
                    const w = Math.max(3, ex - sx);
                    const outcome = span.outcome;
                    return (
                      <g key={`${span.task}-${String(span.attempt)}`} data-tone={outcome === 'unknown' ? 'ghost' : taskTone(outcome)}>
                        <title>{`${span.task} · attempt ${String(span.attempt)} · ${outcome}${span.runner === undefined ? '' : ` · ${span.runner}`}`}</title>
                        <rect className="svg-attempt" data-outcome={outcome} x={sx} y={y + 5} width={w} height={ROW_H - 10} rx={2} />
                        {span.attempt > 1 && w > 14 ? (
                          <text className="svg-attempt-n" x={sx + 3} y={y + ROW_H / 2 + 3}>
                            {span.attempt}
                          </text>
                        ) : null}
                      </g>
                    );
                  })}
                  {(taskMarkers.get(row.id) ?? []).map((marker) => (
                    <Glyph key={String(marker.index)} x={scale(marker.at)} y={y + ROW_H / 2} marker={marker} onClick={() => jump(marker)} />
                  ))}
                </g>
              );
            })}
            {finished ? null : <line className="svg-now" x1={scale(domain[1])} x2={scale(domain[1])} y1={0} y2={lanesH} />}
            {live ? null : <rect className="svg-future" x={playX} y={0} width={Math.max(0, x1 - playX)} height={lanesH} />}
          </svg>
        </div>

        <div className="playhead" data-tone={tone} data-dragging={dragging} style={{ left: playX }} aria-hidden="true">
          <span className={playX > x1 - 60 ? 'playhead__cap playhead__cap--right' : 'playhead__cap'}>{live ? (finished ? 'END' : 'LIVE') : formatClock(t)}</span>
        </div>

        <div
          ref={grabRef}
          className="recorder__grab"
          role="slider"
          tabIndex={0}
          aria-label="Playhead. Drag to replay the run; arrow keys step through the log."
          aria-valuemin={domain[0]}
          aria-valuemax={domain[1]}
          aria-valuenow={t}
          aria-valuetext={readout}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
        />
      </div>
    </section>
  );
}
