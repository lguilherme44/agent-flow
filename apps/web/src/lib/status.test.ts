import { describe, it, expect } from 'vitest';
import { PIPELINE_STATUSES, TASK_STATES } from '@contracts/index.js';
import { TONE_BG, TONE_DOT, TONE_TEXT, stageTone, taskTone } from './status';

/**
 * The one place a status becomes a colour, tested for the first time.
 *
 * **`stageTone` had no test at all**, and finding that out is what this file is really
 * about. `cached` was added to `PIPELINE_STATUSES` a day before M8.5 with two deliberate
 * browser-side guards behind it — `case 'cached': return 'info'` here, and
 * `solid={… || stage.status === 'cached'}` in `StageStep` — and *nothing in the repository
 * covered either*. No unit test named the function; no fixture anywhere, visual suite
 * included, carried a `cached` stage, so no screenshot contained one either.
 *
 * That is the shape this milestone spent its day on, arriving from a third direction: a
 * distinction the vocabulary draws, the code honours, and no instrument observes. The
 * guard would have survived a redesign by luck rather than by evidence — and it nearly
 * did, because the redesign that moved the pipeline to another surface had no reason to
 * notice it.
 *
 * **These are pure-function tests on purpose.** The rendered channels — a filled ring
 * against a hollow one — are what a baseline photographs, and the reference fixture now
 * carries a `cached` stage so it does. What a unit test can hold without brittleness is
 * the mapping, and the mapping is where the flattening happens.
 */

/**
 * An exhaustive test over an empty collection passes by looking at nothing.
 *
 * Both suites below iterate a contract enum, so both would go quietly vacuous the day one
 * of those arrays is refactored into something this file imports as `[]`. Proved once,
 * here, rather than assumed in six loops — measured at 7 and 8 when this was written.
 */
describe('the collections these suites iterate', () => {
  it('are not empty, so the exhaustive tests below are not vacuous', () => {
    expect(PIPELINE_STATUSES.length).toBeGreaterThanOrEqual(7);
    expect(TASK_STATES.length).toBeGreaterThanOrEqual(8);
  });
});

describe('stageTone', () => {
  it('gives every status the contract has a tone, exhaustively', () => {
    // The `default` branch is where an unmodelled state goes to die. Enumerating the
    // contract rather than a hand-written list is what makes a status added upstream show
    // up here as a decision rather than as silence.
    for (const status of PIPELINE_STATUSES) {
      const tone = stageTone(status);
      expect(TONE_BG[tone], `no background for ${status}`).toBeDefined();
      expect(TONE_TEXT[tone], `no text colour for ${status}`).toBeDefined();
      expect(TONE_DOT[tone], `no marker for ${status}`).toBeDefined();
    }
  });

  it('does not draw a reused stage as one that never ran', () => {
    // **The whole reason `cached` exists.** Before it had a case it fell through to
    // `default` and drew identically to `pending` — three facts, one symbol, and the
    // symbol asserting the strongest claim available: nothing happened here.
    expect(stageTone('cached')).not.toBe(stageTone('pending'));
  });

  it('does not claim this run did the work a cache did', () => {
    // `info`, not `success`, and the difference is a claim rather than a preference: green
    // says this run produced it, and a reused artifact is exactly as old as whatever did.
    // A stale cache is a real failure mode and it can only be noticed if the reuse is
    // visible as reuse.
    expect(stageTone('cached')).toBe('info');
    expect(stageTone('completed')).toBe('success');
    expect(stageTone('cached')).not.toBe(stageTone('completed'));
  });

  it('keeps violet for the stage that is running, and nothing else', () => {
    // The One Violet Rule. A running *task* is blue precisely so that violet keeps meaning
    // "where is this run right now" — so `primary` may appear here and nowhere in
    // `taskTone`.
    expect(stageTone('running')).toBe('primary');
    expect(TASK_STATES.map(taskTone)).not.toContain('primary');
  });

  it('separates the four states an operator reads off the pipeline', () => {
    // Not started, reused, in flight, done. These four are the pipeline's whole
    // vocabulary, and any two of them sharing a tone is the flattening this file exists to
    // catch — asserted as a set size rather than as six pairwise comparisons, so a fifth
    // state joining them is covered by construction.
    const tones = ['pending', 'cached', 'running', 'completed'].map((status) =>
      stageTone(status as (typeof PIPELINE_STATUSES)[number]),
    );

    expect(new Set(tones).size, `two of these share a tone: ${tones.join(', ')}`).toBe(4);
  });

  it('reads failure and refusal as different weights of the same problem', () => {
    // `failed` is danger; a stage held at a gate or blocked is warning. Both stop the run
    // and only one of them is the machine's fault.
    expect(stageTone('failed')).toBe('danger');
    expect(stageTone('blocked')).toBe('warning');
    expect(stageTone('waiting_approval')).toBe('warning');
  });
});

describe('taskTone', () => {
  it('gives every task state the contract has a tone, exhaustively', () => {
    for (const state of TASK_STATES) {
      const tone = taskTone(state);
      expect(TONE_BG[tone], `no background for ${state}`).toBeDefined();
    }
  });

  it('draws a running task blue, leaving violet to the pipeline', () => {
    expect(taskTone('running')).toBe('info');
  });

  it('separates done, moving and broken', () => {
    const tones = [taskTone('completed'), taskTone('running'), taskTone('failed')];
    expect(new Set(tones).size).toBe(3);
  });

  it('groups the states that are waiting for a person, because they are one decision', () => {
    // `blocked`, `review_required` and `interrupted` all mean "a person decides what
    // happens next". Giving each its own colour would spend three of six tones on one
    // question.
    expect(taskTone('blocked')).toBe('warning');
    expect(taskTone('review_required')).toBe('warning');
    expect(taskTone('interrupted')).toBe('warning');
  });
});
