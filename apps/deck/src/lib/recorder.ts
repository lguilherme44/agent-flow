import type { MarkerKind, Timeline } from './replay';
import { stageTone, taskTone, type Tone } from './tone';

/**
 * What the recorder needs decided before it draws: which shape and tone a mark takes, what
 * a legend has to explain, and how much of a word fits in how many pixels.
 *
 * Pure, like `replay.ts` beside it. The recorder used to answer all of this inline, and the
 * cost showed on screen: no legend could be drawn because the shape table lived inside a
 * render function, and a stage label was all-or-nothing because "does it fit" was one
 * comparison in JSX. Here each answer can be tested at the width the screenshot was taken.
 */

export type MarkShape = 'diamond' | 'circle' | 'ring' | 'square' | 'x' | 'tri' | 'down' | 'tick';

export interface MarkGlyph {
  readonly tone: Tone;
  readonly shape: MarkShape;
}

/** Every kind of mark, in the order a legend lists them. */
export const MARK_KINDS: readonly MarkerKind[] = [
  'created',
  'approved',
  'rejected',
  'revision',
  'assigned',
  'validated',
  'integrated',
  'requeued',
  'unblocked',
  'recovery',
  'exhausted',
  'finding',
  'gate',
  'degradation',
  'corrective',
  'forge',
  'lock',
  'other',
];

/*
  Eight shapes over six tones, and no two kinds that can share a lane share a glyph. The
  pairs that do share one mean the same thing to a reader: approval and refusal are one
  diamond in two tones, and `other` is the plain tick a mark falls back to.
*/
const GLYPHS: Readonly<Record<MarkerKind, MarkGlyph>> = {
  created: { tone: 'idle', shape: 'circle' },
  approved: { tone: 'warn', shape: 'diamond' },
  rejected: { tone: 'bad', shape: 'diamond' },
  revision: { tone: 'warn', shape: 'tri' },
  assigned: { tone: 'idle', shape: 'tick' },
  validated: { tone: 'ok', shape: 'tick' },
  integrated: { tone: 'ok', shape: 'square' },
  requeued: { tone: 'idle', shape: 'tri' },
  unblocked: { tone: 'idle', shape: 'ring' },
  recovery: { tone: 'warn', shape: 'ring' },
  exhausted: { tone: 'bad', shape: 'x' },
  finding: { tone: 'warn', shape: 'circle' },
  gate: { tone: 'idle', shape: 'square' },
  degradation: { tone: 'warn', shape: 'down' },
  corrective: { tone: 'warn', shape: 'square' },
  forge: { tone: 'live', shape: 'square' },
  lock: { tone: 'ghost', shape: 'ring' },
  other: { tone: 'ghost', shape: 'tick' },
};

export function markGlyph(kind: MarkerKind): MarkGlyph {
  return GLYPHS[kind];
}

/**
 * One task lane, in pixels from its top: the marks in a strip above, the attempt bar
 * below, and a pixel between them. A mark drawn across a bar hid the bar's colour and sat
 * on the attempt number; the strip is what separates an *instant* from a *duration*.
 */
export const LANE = {
  height: 28,
  /** Centre of the mark strip, and half a mark's height. */
  markY: 7,
  mark: 5,
  barY: 14,
  barH: 11,
} as const;

export interface LegendEntry {
  readonly token: string;
  readonly tone: Tone;
}

export interface Legend {
  /** The outcomes some bar on screen is coloured by, once each. */
  readonly bars: readonly LegendEntry[];
  /** The kinds of mark on screen, in `MARK_KINDS` order. */
  readonly marks: readonly MarkerKind[];
}

/** The outcomes a legend lists first, in this order; anything else follows as it was met. */
const BAR_ORDER: readonly string[] = ['running', 'completed', 'failed', 'interrupted', 'reused', 'unknown'];

/**
 * What this timeline needs explained — and nothing it does not. Eighteen kinds of mark in
 * a legend is a second thing to decode; the four that are on screen is a key.
 */
export function legendOf(timeline: Timeline): Legend {
  const tones = new Map<string, Tone>();
  for (const span of timeline.stages) if (!tones.has(span.outcome)) tones.set(span.outcome, stageTone(span.outcome));
  for (const span of timeline.attempts) if (!tones.has(span.outcome)) tones.set(span.outcome, taskTone(span.outcome));
  const known = BAR_ORDER.filter((token) => tones.has(token));
  const rest = [...tones.keys()].filter((token) => !BAR_ORDER.includes(token));
  const bars = [...known, ...rest].map((token) => ({ token, tone: tones.get(token) ?? 'ghost' }));

  const present = new Set(timeline.markers.map((marker) => marker.kind));
  return { bars, marks: MARK_KINDS.filter((kind) => present.has(kind)) };
}

/** One character of the 10px bold mono a tape cell is labelled in. */
const TAPE_CHAR = 6.4;

/** The long name if the cell has room, the short one if only that fits, nothing otherwise. */
export function fitLabel(width: number, long: string, short: string | undefined): string | undefined {
  const fits = (label: string): boolean => width > label.length * TAPE_CHAR + 10;
  if (fits(long)) return long;
  if (short !== undefined && fits(short)) return short;
  return undefined;
}

/** `text` cut to `maxChars`, ending on an ellipsis and never on a space. */
export function clipText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length === 0) return '';
  if (text.length <= maxChars) return text;
  if (maxChars === 1) return '…';
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

/** The lane gutter for a plot this wide: id alone until there is room for a title beside it. */
export function laneGutter(width: number): number {
  if (width < 760) return 84;
  if (width < 1100) return 132;
  return 260;
}

const ID_X = 22;
/** One character of the 11px mono an id is set in. */
const ID_CHAR = 6.6;
/** One character of the 10.5px UI face a title is set in — an average; a clip path holds the edge. */
const TITLE_CHAR = 5.6;
const TITLE_GAP = 8;
/** Fewer characters than this reads as a stray word, not a title. */
const TITLE_MIN = 8;
/** Titles begin with the wide gutter. Below it a short id left room and a long one did not, and one row with a title among rows without is the odd one out. */
const TITLE_GUTTER = 200;

/** Where a task's title starts, after its id. */
export function titleX(id: string): number {
  return ID_X + id.length * ID_CHAR + TITLE_GAP;
}

/** How many characters of a title fit in the gutter beside this id — `0` means show none. */
export function titleBudget(gutter: number, id: string): number {
  if (gutter < TITLE_GUTTER) return 0;
  const chars = Math.floor((gutter - titleX(id) - TITLE_GAP) / TITLE_CHAR);
  return chars < TITLE_MIN ? 0 : chars;
}

/** The least two marks may be apart before one hides the other. */
export const MARK_GAP = 9;

/**
 * Marks at their instants, nudged right where two would land on each other. A mark drawn
 * over another is a mark nobody sees; the tooltip still says the true clock, and the
 * drift is bounded by how many neighbours a mark has, not by how long the run is.
 * Expects `xs` in time order, which is the order the fold keeps markers in.
 *
 * With `max`, nothing is pushed past that edge: the cluster is pulled back left instead,
 * gaps kept — six marks in five pixels at the end of a phone's plot were half off it.
 */
export function dodge(xs: readonly number[], gap = MARK_GAP, max?: number): number[] {
  const out: number[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const x of xs) {
    const placed = x - last < gap ? last + gap : x;
    out.push(placed);
    last = placed;
  }
  if (max !== undefined) {
    let limit = max;
    for (let index = out.length - 1; index >= 0; index -= 1) {
      const x = out[index] as number;
      const placed = Math.min(x, limit);
      out[index] = placed;
      limit = placed - gap;
    }
  }
  return out;
}

/** Below this plot width the recorder is being read on a phone: fold the legend, drop the keys. */
export const COMPACT_WIDTH = 720;
