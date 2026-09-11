import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Marker, MarkerKind, StateAt, Timeline } from '../../lib/replay';
import { neighbour } from '../../lib/replay';
import { COMPACT_WIDTH, LANE, MARK_GAP, clipText, dodge, fitLabel, laneGutter, legendOf, markGlyph, titleBudget, titleX, type Legend } from '../../lib/recorder';
import { describe } from '../../lib/sentence';
import { MINUTE, formatClock, formatDay, formatOffset, scaleTime, stepOf, tickLabel, ticks } from '../../lib/time';
import { stageTone, taskTone, type Tone } from '../../lib/tone';
import { useT, word, type Dictionary } from '../../lib/i18n';

/**
 * The recorder: the run as a strip of time you can drag through.
 *
 * Top to bottom — the clock, a legend for what is on screen and only that, the ten-stage
 * tape drawn to true duration, the run's own marks (approval, revision, degradation,
 * findings), one lane per task with its marks in a strip above and a bar per attempt
 * below, and a playhead. Drag the playhead and the page below shows what the log said was
 * true at that instant; let it go at the right edge, or press LIVE, and the server's answer
 * takes over again.
 *
 * Draws the fold in `lib/replay.ts` and decides nothing itself. Every bar is a line of the
 * log with its `at` read off. What it *does* decide about pixels — which shape a mark is,
 * whether a word fits its cell — it asks `lib/recorder.ts`, where a test can pin it.
 */

const AXIS_H = 34;
const TAPE_Y = AXIS_H + 6;
const TAPE_H = 20;
const RUNROW_Y = TAPE_Y + TAPE_H + 8;
const RUNROW_H = 18;
const HEAD_H = RUNROW_Y + RUNROW_H + 6;
const ROW_H = LANE.height;
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

/** A bar one pixel short of its neighbour, so two runs of one stage read as two. */
const barWidth = (w: number): number => (w > 4 ? w - 1 : w);

/**
 * Whether the reader is on a touch screen: a phone held sideways is wider than the compact
 * breakpoint and still has no arrow keys and no room. Read once; a pointer does not change
 * kind mid-session, and a test environment without `matchMedia` is a desk.
 */
function useCoarsePointer(): boolean {
  const [coarse] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(pointer: coarse)').matches;
  });
  return coarse;
}

/** The shape of one kind of mark, drawn about the origin. `Mark` places it on the tape; the legend shows it still. */
function MarkShape({ kind }: { kind: MarkerKind }) {
  const { tone, shape } = markGlyph(kind);
  const s = LANE.mark;
  let body: JSX.Element;
  switch (shape) {
    case 'diamond':
      body = <path className="svg-marker" d={`M0 ${-s - 1} L${s + 1} 0 L0 ${s + 1} L${-s - 1} 0 Z`} />;
      break;
    case 'square':
      body = <rect className="svg-marker" x={-s + 1} y={-s + 1} width={s * 2 - 2} height={s * 2 - 2} />;
      break;
    case 'x':
      body = (
        <>
          <circle className="svg-marker" r={s} />
          <path d={`M${-s / 2} ${-s / 2} L${s / 2} ${s / 2} M${s / 2} ${-s / 2} L${-s / 2} ${s / 2}`} stroke="var(--bg)" strokeWidth={1.5} />
        </>
      );
      break;
    case 'tri':
      body = <path className="svg-marker" d={`M0 ${-s - 1} L${s + 1} ${s} L${-s - 1} ${s} Z`} />;
      break;
    case 'down':
      body = <path className="svg-marker" d={`M${-s - 1} ${-s} L${s + 1} ${-s} L0 ${s + 1} Z`} />;
      break;
    case 'ring':
      body = <circle className="svg-marker svg-marker--ring" r={s - 1} />;
      break;
    case 'tick':
      body = <rect className="svg-marker" x={-1.25} y={-s - 1} width={2.5} height={s * 2 + 2} />;
      break;
    case 'circle':
    default:
      body = <circle className="svg-marker" r={s} />;
  }
  return <g data-tone={tone}>{body}</g>;
}

function Mark({ x, y, marker, onClick, dict }: { x: number; y: number; marker: Marker; onClick: () => void; dict: Dictionary }) {
  const kinds: Readonly<Record<string, string | undefined>> = dict.recorder.marks;
  const said = describe(marker.event, dict);
  // The legend's word for it first, so the tooltip and the legend meet on one term.
  const title = `${formatClock(marker.at)} · ${kinds[marker.kind] ?? marker.kind} · ${said.title}${said.detail === undefined ? '' : ` — ${said.detail}`}`;
  return (
    <g className="svg-mark" data-kind={marker.kind} transform={`translate(${x} ${y})`} onClick={onClick}>
      <title>{title}</title>
      <MarkShape kind={marker.kind} />
    </g>
  );
}

/**
 * What the colours and shapes on screen mean — only those, so a run with no findings has
 * no entry for one. The swatches are the tape's own classes drawn small, so the hatch for
 * `unknown` and the pulse for `running` teach themselves.
 *
 * On a phone the list is folded behind its own name until asked: nineteen entries were a
 * third of the screen before the tape began, and the tape is what a person came to see.
 */
function RecorderLegend({ legend, dict, compact }: { legend: Legend; dict: Dictionary; compact: boolean }) {
  const [open, setOpen] = useState(false);
  if (legend.bars.length === 0 && legend.marks.length === 0) return null;
  const kinds: Readonly<Record<string, string | undefined>> = dict.recorder.marks;
  const folded = compact && !open;
  return (
    <div className="recorder__legend-wrap" data-folded={folded}>
      {compact ? (
        <button type="button" className="recorder__legend-toggle" aria-expanded={open} aria-controls="recorder-legend" onClick={() => setOpen(!open)}>
          {dict.recorder.legend} · {legend.bars.length + legend.marks.length} {open ? '▾' : '▸'}
        </button>
      ) : null}
      {folded ? null : (
        <ul id="recorder-legend" className="recorder__legend" aria-label={dict.recorder.legend}>
          {legend.bars.length === 0 ? null : <li className="recorder__legend-k">{dict.recorder.legendBars}</li>}
          {legend.bars.map((entry) => (
            <li key={`bar-${entry.token}`} className="recorder__legend-item">
              <svg width={16} height={12} aria-hidden="true">
                <g data-tone={entry.tone}>
                  <rect className="svg-attempt" data-outcome={entry.token} x={0.5} y={0.5} width={15} height={11} rx={2} />
                </g>
              </svg>
              <span>{word(dict, entry.token)}</span>
            </li>
          ))}
          {legend.marks.length === 0 ? null : <li className="recorder__legend-k">{dict.recorder.legendMarks}</li>}
          {legend.marks.map((kind) => (
            <li key={`mark-${kind}`} className="recorder__legend-item">
              <svg width={14} height={14} aria-hidden="true">
                <g transform="translate(7 7)">
                  <MarkShape kind={kind} />
                </g>
              </svg>
              <span>{kinds[kind] ?? kind}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Recorder(props: RecorderProps) {
  const { timeline, domain, t, live, finished, truncated, onScrub, selected, onSelect, rows, liveStates, past } = props;
  /*
    `t` above is the *playhead instant* — this component had the name first, and the
    dictionary is `dict` here so the two never meet in one expression.
  */
  const dict = useT();
  const long: Readonly<Record<string, string | undefined>> = dict.stageLong;
  const short: Readonly<Record<string, string | undefined>> = dict.stageShort;
  const plotRef = useRef<HTMLDivElement>(null);
  const grabRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gutter = laneGutter(width);
  const coarse = useCoarsePointer();
  // Not before the first measurement: `0` is "unknown", not "a very small phone".
  const compact = coarse || (width > 0 && width < COMPACT_WIDTH);

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
  const legend = useMemo(() => legendOf(timeline), [timeline]);

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
  const runXs = dodge(runMarkers.map((marker) => scale(marker.at)), MARK_GAP, x1);
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
      ? dict.recorder.endOfLog(formatClock(domain[1]))
      : dict.recorder.now(formatClock(t))
    : dict.recorder.fromStart(formatClock(t), formatOffset(t - domain[0]));

  // The grab area starts where the lanes do, and the stylesheet learns where that is from here.
  const frame = { '--gutter': `${String(gutter)}px` } as CSSProperties;

  return (
    <section className="panel recorder" aria-label={dict.recorder.label} style={frame}>
      <div className="recorder__bar">
        <div className="recorder__mode" data-tone={tone}>
          <b>{live ? (finished ? dict.recorder.recorded : dict.recorder.live) : dict.recorder.replay}</b>
          <span className="recorder__readout">
            {readout}
            {past === undefined ? null : (
              <small>
                {dict.recorder.lines(past.seen, timeline.events.length)}
              </small>
            )}
            {truncated ? <small style={{ color: 'var(--warn)' }}>{dict.recorder.originCut}</small> : null}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* A phone has no arrow keys; the hints are a row of nothing there. */}
          {compact ? null : (
            <span className="recorder__keys" aria-hidden="true">
              <kbd>←</kbd>
              <kbd>→</kbd> {dict.recorder.keyStep} · <kbd>⇧</kbd> {dict.recorder.keyMinute} · <kbd>End</kbd> {dict.recorder.keyLive}
            </span>
          )}
          {live ? null : (
            <button type="button" className="btn btn--sm btn--primary" onClick={() => onScrub(null)}>
              ● {finished ? dict.recorder.end : dict.recorder.live}
            </button>
          )}
        </div>
      </div>

      <RecorderLegend legend={legend} dict={dict} compact={compact} />

      <div className="recorder__plot" ref={plotRef}>
        <svg className="recorder__svg" height={HEAD_H} width={width || undefined} role="img" aria-label={dict.recorder.stagesAria}>
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
            const dayLabel = step < 24 * 60 * MINUTE && (index === 0 || midnight) ? formatDay(at, dict.time) : undefined;
            return (
              <g key={at}>
                <line className="svg-tick" x1={scale(at)} x2={scale(at)} y1={AXIS_H - 6} y2={AXIS_H} />
                <text className="svg-axis-label" x={scale(at)} y={AXIS_H - 10} textAnchor="middle">
                  {tickLabel(at, step, dict.time)}
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
            {dict.recorder.stagesRow}
          </text>
          <text className="svg-stage-name" x={8} y={RUNROW_Y + RUNROW_H / 2 + 3.5}>
            {dict.recorder.runRow}
          </text>
          {/* stage tape */}
          {timeline.stages.map((span, index) => {
            const sx = scale(span.startedAt);
            const ex = span.endedAt === undefined ? scale(domain[1]) : scale(span.endedAt);
            const w = Math.max(3, ex - sx);
            const name = long[span.stage] ?? span.stage;
            // The long name, the short one, or none — the cell keeps its colour either way.
            const label = fitLabel(w, name, short[span.stage]);
            const outcome = span.outcome === 'reused' ? 'cached' : span.outcome;
            return (
              <g key={`${span.stage}-${String(index)}`} data-tone={stageTone(outcome)}>
                <title>{`${name} · ${word(dict, span.outcome)}${span.runner === undefined ? '' : ` · ${span.runner}`}${span.model === undefined ? '' : ` · ${span.model}`}`}</title>
                <rect className="svg-attempt" data-outcome={span.outcome} x={sx} y={TAPE_Y} width={barWidth(w)} height={TAPE_H} rx={2} />
                {label === undefined ? null : (
                  <text className="svg-tape-label" x={sx + 5} y={TAPE_Y + TAPE_H / 2 + 3.5}>
                    {label}
                  </text>
                )}
              </g>
            );
          })}
          {/* run-level marks, each clear of the one before it */}
          {runMarkers.map((marker, index) => (
            <Mark key={String(marker.index)} x={runXs[index] ?? scale(marker.at)} y={RUNROW_Y + RUNROW_H / 2} marker={marker} onClick={() => jump(marker)} dict={dict} />
          ))}
          {/* now */}
          {finished ? null : <line className="svg-now" x1={scale(domain[1])} x2={scale(domain[1])} y1={AXIS_H} y2={HEAD_H} />}
          {live ? null : <rect className="svg-future" x={playX} y={AXIS_H} width={Math.max(0, x1 - playX)} height={HEAD_H - AXIS_H} />}
        </svg>

        <div className="recorder__lanes">
          <svg className="recorder__svg" height={lanesH} width={width || undefined} role="img" aria-label={dict.recorder.attemptsAria}>
            <defs>
              {/* A title is an estimate of characters; the clip is the guarantee it stays in the gutter. */}
              <clipPath id="lane-gutter">
                <rect x={0} y={0} width={Math.max(0, gutter - 6)} height={lanesH} />
              </clipPath>
            </defs>
            {axisTicks.map((at) => (
              <line key={at} className="svg-grid" x1={scale(at)} x2={scale(at)} y1={0} y2={lanesH} />
            ))}
            {rows.map((row, index) => {
              const y = index * ROW_H + 4;
              const state = stateOf(row.id);
              const isSelected = selected === row.id;
              const attempts = timeline.attempts.filter((span) => span.task === row.id);
              const budget = titleBudget(gutter, row.id);
              const title = budget === 0 || row.title === '' ? undefined : clipText(row.title, budget);
              const marks = taskMarkers.get(row.id) ?? [];
              const markXs = dodge(marks.map((marker) => scale(marker.at)), MARK_GAP, x1);
              const pick = (): void => onSelect(isSelected ? undefined : row.id);
              return (
                <g key={row.id}>
                  <rect
                    className="svg-row-band"
                    data-selected={isSelected}
                    x={0}
                    y={y}
                    width={Math.max(width, x1)}
                    height={ROW_H}
                    onClick={pick}
                    style={{ cursor: 'pointer' }}
                  >
                    <title>{`${row.id} · ${row.title}${state === undefined ? '' : ` · ${word(dict, state)}`}`}</title>
                  </rect>
                  <g data-tone={taskTone(state)}>
                    <circle cx={12} cy={y + ROW_H / 2} r={3} fill="var(--tone)" />
                  </g>
                  <text
                    className={row.id.startsWith('FIX') ? 'svg-lane-label svg-lane-label--fix' : 'svg-lane-label'}
                    data-selected={isSelected}
                    x={22}
                    y={y + ROW_H / 2 + 3.5}
                    onClick={pick}
                    style={{ cursor: 'pointer' }}
                  >
                    {row.id}
                  </text>
                  {title === undefined ? null : (
                    <text
                      className="svg-lane-title"
                      data-selected={isSelected}
                      clipPath="url(#lane-gutter)"
                      x={titleX(row.id)}
                      y={y + ROW_H / 2 + 3.5}
                      onClick={pick}
                      style={{ cursor: 'pointer' }}
                    >
                      {title}
                    </text>
                  )}
                  {attempts.map((span) => {
                    const sx = scale(span.startedAt);
                    const ex = span.endedAt === undefined ? (span.outcome === 'running' ? scale(domain[1]) : sx + 3) : scale(span.endedAt);
                    const w = Math.max(3, ex - sx);
                    const outcome = span.outcome;
                    return (
                      <g key={`${span.task}-${String(span.attempt)}`} data-tone={outcome === 'unknown' ? 'ghost' : taskTone(outcome)}>
                        <title>{`${span.task} · ${dict.events.attemptN(span.attempt)} · ${word(dict, outcome)}${span.runner === undefined ? '' : ` · ${span.runner}`}`}</title>
                        <rect className="svg-attempt" data-outcome={outcome} data-task={span.task} x={sx} y={y + LANE.barY} width={barWidth(w)} height={LANE.barH} rx={2} />
                        {span.attempt > 1 && w > 14 ? (
                          <text className="svg-attempt-n" x={sx + 3} y={y + LANE.barY + LANE.barH / 2 + 3}>
                            {span.attempt}
                          </text>
                        ) : null}
                      </g>
                    );
                  })}
                  {marks.map((marker, index) => (
                    <Mark key={String(marker.index)} x={markXs[index] ?? scale(marker.at)} y={y + LANE.markY} marker={marker} onClick={() => jump(marker)} dict={dict} />
                  ))}
                </g>
              );
            })}
            {finished ? null : <line className="svg-now" x1={scale(domain[1])} x2={scale(domain[1])} y1={0} y2={lanesH} />}
            {live ? null : <rect className="svg-future" x={playX} y={0} width={Math.max(0, x1 - playX)} height={lanesH} />}
          </svg>
        </div>

        <div className="playhead" data-tone={tone} data-dragging={dragging} style={{ left: playX }} aria-hidden="true">
          <span className={playX > x1 - 60 ? 'playhead__cap playhead__cap--right' : 'playhead__cap'}>{live ? (finished ? dict.recorder.endCap : dict.recorder.live) : formatClock(t)}</span>
        </div>

        <div
          ref={grabRef}
          className="recorder__grab"
          role="slider"
          tabIndex={0}
          aria-label={dict.recorder.playheadAria}
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
