import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@contracts/index.js';
import { buildTimeline } from './replay';
import { clipText, dodge, fitLabel, laneGutter, legendOf, markGlyph, titleBudget } from './recorder';

const T0 = Date.parse('2026-09-10T19:00:00.000Z');
const at = (offsetSeconds: number): string => new Date(T0 + offsetSeconds * 1_000).toISOString();
const event = (offsetSeconds: number, type: string, detail: Record<string, unknown> = {}): RunEvent => ({ at: at(offsetSeconds), type, detail });

/** Two stages that ended differently, one reused, one task done and one cut short, and three marks. */
const LOG: RunEvent[] = [
  event(0, 'run_created'),
  event(1, 'stage_started', { stage: 'planning' }),
  event(1_800, 'stage_completed', { stage: 'planning' }),
  event(1_801, 'stage_started', { stage: 'implementation' }),
  event(1_900, 'stage_failed', { stage: 'implementation' }),
  event(1_950, 'stage_reused', { stage: 'sdd' }),
  event(2_000, 'run_approved'),
  event(2_001, 'task_started', { task: 'TASK-001' }),
  event(2_500, 'task_finished', { task: 'TASK-001', status: 'completed' }),
  event(2_501, 'task_started', { task: 'TASK-002' }),
  event(2_600, 'task_interrupted', { task: 'TASK-002' }),
  event(2_601, 'finding_raised', { task: 'TASK-002', severity: 'high' }),
];

describe('legendOf', () => {
  const legend = legendOf(buildTimeline(LOG, T0 + 3_000_000));

  it('lists only the outcomes actually drawn, once each, in a stable order', () => {
    // `completed` closes a stage and a task; one swatch says both.
    expect(legend.bars.map((entry) => entry.token)).toEqual(['completed', 'failed', 'interrupted', 'reused']);
  });

  it('gives each swatch the tone the tape draws that outcome in', () => {
    const toneOf = (token: string): string | undefined => legend.bars.find((entry) => entry.token === token)?.tone;
    expect(toneOf('completed')).toBe('ok');
    expect(toneOf('failed')).toBe('bad');
    expect(toneOf('interrupted')).toBe('bad');
    expect(toneOf('reused')).toBe('ghost');
  });

  it('lists only the marks present, in vocabulary order', () => {
    expect(legend.marks).toEqual(['created', 'approved', 'finding']);
  });

  it('keeps a status the vocabulary has not learned, after the ones it has', () => {
    const odd = legendOf(
      buildTimeline(
        [
          event(0, 'task_started', { task: 'T' }),
          event(1, 'task_finished', { task: 'T', status: 'review_required' }),
          event(2, 'task_started', { task: 'U' }),
        ],
        T0 + 10_000,
      ),
    );
    expect(odd.bars.map((entry) => entry.token)).toEqual(['running', 'review_required']);
    expect(odd.bars[1]?.tone).toBe('warn');
  });

  it('has nothing to explain for an empty log', () => {
    expect(legendOf(buildTimeline([], T0))).toEqual({ bars: [], marks: [] });
  });
});

describe('markGlyph', () => {
  it('draws approval and refusal as one shape in opposite tones', () => {
    expect(markGlyph('approved')).toEqual({ tone: 'warn', shape: 'diamond' });
    expect(markGlyph('rejected')).toEqual({ tone: 'bad', shape: 'diamond' });
  });
});

describe('fitLabel', () => {
  it('prefers the long name, falls back to the short one, then to nothing', () => {
    expect(fitLabel(120, 'planejamento', 'plano')).toBe('planejamento');
    expect(fitLabel(60, 'planejamento', 'plano')).toBe('plano');
    expect(fitLabel(30, 'planejamento', 'plano')).toBeUndefined();
  });

  it('lives without a short name', () => {
    expect(fitLabel(60, 'planejamento', undefined)).toBeUndefined();
  });
});

describe('clipText', () => {
  it('returns the text whole when it fits', () => {
    expect(clipText('Parse the config', 20)).toBe('Parse the config');
  });

  it('ends a cut on an ellipsis, never on a space', () => {
    expect(clipText('Parse the config file', 10)).toBe('Parse the…');
  });

  it('says nothing in no room', () => {
    expect(clipText('Parse', 0)).toBe('');
    expect(clipText('Parse', 1)).toBe('…');
  });
});

describe('the gutter', () => {
  it('widens with the plot, and only the wide one has room for a title', () => {
    expect(laneGutter(600)).toBe(84);
    expect(laneGutter(900)).toBe(132);
    expect(laneGutter(1400)).toBe(260);
    expect(titleBudget(84, 'TASK-001')).toBe(0);
    expect(titleBudget(132, 'TASK-001')).toBe(0);
    expect(titleBudget(260, 'TASK-001')).toBeGreaterThanOrEqual(24);
  });

  it('leaves less room for a title after a longer id', () => {
    expect(titleBudget(260, 'CORRECTIVE-001')).toBeLessThan(titleBudget(260, 'FIX-001'));
  });

  it('shows no title in the medium gutter whatever the id, so no row is the odd one out', () => {
    // A short id left eight characters over in the medium gutter, and `FIX-001` got a
    // title while `TASK-001` beside it did not. Whether titles show is the gutter's call.
    expect(titleBudget(132, 'FIX-001')).toBe(0);
    expect(titleBudget(132, 'T-1')).toBe(0);
  });
});

describe('dodge', () => {
  it('leaves marks that are apart where they are', () => {
    expect(dodge([10, 30, 50])).toEqual([10, 30, 50]);
  });

  it('nudges a mark off the one before it, and the next off that', () => {
    expect(dodge([10, 12, 13, 40])).toEqual([10, 19, 28, 40]);
  });

  it('has nothing to move for nothing', () => {
    expect(dodge([])).toEqual([]);
  });

  it('pulls a cluster back from the right edge instead of drawing past it', () => {
    // Six marks in five pixels at the end of the plot were pushed off the strip on a
    // phone; the last one was cut in half. The cluster keeps its gaps and ends at the edge.
    expect(dodge([90, 92, 94, 96], 9, 100)).toEqual([73, 82, 91, 100]);
    expect(dodge([10, 30, 50], 9, 100)).toEqual([10, 30, 50]);
  });
});
