/**
 * Time, as the recorder needs it: parsing, formatting, and a linear scale with nice ticks.
 *
 * Pure. Every function takes its clock as an argument, so a test can pin "now" and a
 * screenshot never depends on when it was taken.
 */

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function ms(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? undefined : value;
}

/** `41m 22s`, `1h 03m`, `2.4s`, `840ms`. Never a decimal on a minute. */
export function formatDuration(duration: number | undefined): string {
  if (duration === undefined || !Number.isFinite(duration) || duration < 0) return '—';
  if (duration < SECOND) return `${String(Math.round(duration))}ms`;
  if (duration < 10 * SECOND) return `${(duration / SECOND).toFixed(1)}s`;
  if (duration < MINUTE) return `${String(Math.round(duration / SECOND))}s`;
  if (duration < HOUR) {
    const minutes = Math.floor(duration / MINUTE);
    const seconds = Math.round((duration - minutes * MINUTE) / SECOND);
    return seconds === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`;
  }
  if (duration < DAY) {
    const hours = Math.floor(duration / HOUR);
    const minutes = Math.round((duration - hours * HOUR) / MINUTE);
    return `${String(hours)}h ${String(minutes).padStart(2, '0')}m`;
  }
  const days = Math.floor(duration / DAY);
  const hours = Math.round((duration - days * DAY) / HOUR);
  return `${String(days)}d ${String(hours).padStart(2, '0')}h`;
}

/** `just now`, `3m ago`, `2h ago`, `yesterday`, `Sep 4`. */
export function formatRelative(iso: string | undefined, now: number): string {
  const at = ms(iso);
  if (at === undefined) return '—';
  const delta = now - at;
  if (delta < 45 * SECOND) return 'just now';
  if (delta < HOUR) return `${String(Math.round(delta / MINUTE))}m ago`;
  if (delta < DAY) return `${String(Math.round(delta / HOUR))}h ago`;
  if (delta < 2 * DAY) return 'yesterday';
  return formatDay(at);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local wall clock, `14:32:05`. Seconds included: the recorder scrubs at that grain. */
export function formatClock(at: number, withSeconds = true): string {
  const d = new Date(at);
  return withSeconds
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDay(at: number): string {
  const d = new Date(at);
  return `${MONTHS[d.getMonth()] ?? ''} ${String(d.getDate())}`;
}

export function formatStamp(at: number): string {
  return `${formatDay(at)} · ${formatClock(at)}`;
}

/** Signed offset from a reference, `+41m 22s`, `−3.0s`. What a scrubber shows. */
export function formatOffset(delta: number): string {
  const sign = delta < 0 ? '−' : '+';
  return `${sign}${formatDuration(Math.abs(delta))}`;
}

export interface Scale {
  (t: number): number;
  readonly invert: (x: number) => number;
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
}

/** Linear, clamped to the range. A zero-width domain maps everything to the left edge. */
export function scaleTime(domain: readonly [number, number], range: readonly [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const fn = ((t: number): number => {
    if (span <= 0) return r0;
    const ratio = (t - d0) / span;
    return r0 + Math.min(1, Math.max(0, ratio)) * (r1 - r0);
  }) as Scale & { invert: (x: number) => number; domain: readonly [number, number]; range: readonly [number, number] };
  fn.invert = (x: number): number => {
    if (r1 === r0) return d0;
    const ratio = (x - r0) / (r1 - r0);
    return d0 + Math.min(1, Math.max(0, ratio)) * span;
  };
  fn.domain = domain;
  fn.range = range;
  return fn;
}

const STEPS = [
  SECOND,
  5 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
];

/**
 * Tick instants at a "nice" interval, roughly one per `pixelsPerTick` of width.
 *
 * Aligned to the local clock so a tick reads `14:30`, not `14:27:41`. Days are aligned to
 * local midnight for the same reason.
 */
export function ticks(domain: readonly [number, number], width: number, pixelsPerTick = 90): number[] {
  const [d0, d1] = domain;
  const span = d1 - d0;
  if (span <= 0 || width <= 0) return [];
  const wanted = Math.max(1, Math.floor(width / pixelsPerTick));
  const step = STEPS.find((candidate) => span / candidate <= wanted) ?? STEPS[STEPS.length - 1] ?? DAY;

  const offset = step >= DAY ? new Date(d0).getTimezoneOffset() * MINUTE : 0;
  const first = Math.ceil((d0 - offset) / step) * step + offset;

  const out: number[] = [];
  for (let t = first; t <= d1; t += step) out.push(t);
  return out;
}

/** The label a tick gets, given how dense the ticks are. */
export function tickLabel(at: number, step: number): string {
  if (step >= DAY) return formatDay(at);
  if (step >= MINUTE) return formatClock(at, false);
  return formatClock(at, true);
}

export function stepOf(instants: readonly number[]): number {
  const a = instants[0];
  const b = instants[1];
  return a === undefined || b === undefined ? MINUTE : b - a;
}
