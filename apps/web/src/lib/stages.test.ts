import { describe, it, expect } from 'vitest';
import { PIPELINE_STAGES, RUN_STAGES } from '@contracts/index.js';
import {
  PIPELINE_STAGE_ORDER,
  RUN_STAGE_ORDER,
  stageIndex,
  stagesPresent,
} from './stages';

/**
 * The test that makes the copy in `stages.ts` safe.
 *
 * The browser cannot import those lists as values without bundling Zod, so it
 * keeps its own. This is the only thing standing between "a local constant" and
 * "a local constant that quietly disagrees with the server" — a stage added to
 * the pipeline and not to the copy would silently sort last in every filter and
 * every chart, and nothing else in the suite would notice.
 */
describe('the browser copy of the pipeline order', () => {
  it('matches RUN_STAGES exactly', () => {
    expect([...RUN_STAGE_ORDER]).toEqual([...RUN_STAGES]);
  });

  it('matches PIPELINE_STAGES exactly', () => {
    expect([...PIPELINE_STAGE_ORDER]).toEqual([...PIPELINE_STAGES]);
  });
});

describe('stageIndex', () => {
  it('orders by the pipeline, not alphabetically', () => {
    expect(stageIndex('discovery')).toBeLessThan(stageIndex('planning'));
    expect(stageIndex('approval')).toBeLessThan(stageIndex('implementation'));
  });

  it('sorts a stage it has never heard of last, rather than first', () => {
    // A server one version ahead must not push its new stage to the top of every
    // filter. Unknown belongs at the end, where it reads as unknown.
    expect(stageIndex('something-new')).toBeGreaterThan(stageIndex('final-review'));
  });
});

describe('stagesPresent', () => {
  it('deduplicates and returns pipeline order', () => {
    expect(stagesPresent(['implementation', 'sdd', 'implementation', 'discovery'])).toEqual([
      'discovery',
      'sdd',
      'implementation',
    ]);
  });

  it('is empty for no runs', () => {
    expect(stagesPresent([])).toEqual([]);
  });
});
