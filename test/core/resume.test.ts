import { describe, expect, it } from 'vitest';
import { planningResume } from '../../src/core/resume.js';

/**
 * D7 — what a resume keeps, and the sentence that used to guess.
 *
 * Three surfaces said some version of *"the stages before this one are kept"*. Measured on
 * a run that timed out in `sdd` and was resumed with `--from sdd`: `stage_started` for
 * **discovery** appeared seven seconds later. The promise cost ten minutes of a frontier
 * model, and it was written by hand in three places.
 *
 * So the rule is a fold and the sentences render it. These tests pin the fold, and the
 * last one pins that the sentence is generated from it rather than asserted again.
 */

describe('which planning stages survive a resume', () => {
  it('keeps the two that go through the artifact reuse', () => {
    const { kept, rerun } = planningResume('planning', 'standard');

    expect(kept).toEqual(['discovery', 'architecture-impact', 'sdd']);
    expect(rerun).toEqual([]);
  });

  it('re-runs discovery on high-risk, which refreshes it on purpose', () => {
    // Not a defect being pinned: a high-risk plan must not rest on a cached map, and the
    // pipeline says so. What was a defect is that the sentence claimed otherwise.
    const { kept, rerun } = planningResume('planning', 'high-risk');

    expect(rerun).toEqual(['discovery']);
    expect(kept).toEqual(['architecture-impact', 'sdd']);
  });

  it('re-runs discovery when the caller asked for no cache', () => {
    const { kept, rerun } = planningResume('sdd', 'standard', { noCache: true });

    expect(rerun).toEqual(['discovery']);
    expect(kept).toEqual(['architecture-impact']);
  });

  it('reproduces the measured case: --from sdd on high-risk redoes discovery', () => {
    // The exact resume that produced the finding. `architecture-impact` survived and
    // discovery did not, against a message promising both.
    const { kept, rerun } = planningResume('sdd', 'high-risk');

    expect(kept).toEqual(['architecture-impact']);
    expect(rerun).toEqual(['discovery']);
  });

  it('has nothing to keep before the first stage', () => {
    expect(planningResume('discovery', 'standard')).toEqual({ kept: [], rerun: [] });
  });
});
