import { describe, it, expect } from 'vitest';
import {
  TRIVIAL_CONTEXT_CEILING_BYTES,
  measurePromptComposition,
  recoveryCostAgainstBaseline,
} from '../../src/core/prompt-budget.js';

/**
 * AR-09 — autonomy must not be bought with context explosion.
 *
 * A one-`grep` call in the evidence environment reported ≈49 000 input tokens before Agent
 * Flow contributed anything of its own, and the global rule block had already been
 * truncated from ≈25 k to ≈24 k characters on the way in. Recovery then adds a Failure
 * Context Packet to *that*, which is why §6.5's budgets are as conservative as they are.
 *
 * The measurement is the deliverable. "The prompt got big" is not a finding anybody can
 * act on; "AGENTS.md is 31 kB of a 38 kB prompt, on a trivial task" is.
 */

const parts = (overrides: Partial<Record<string, string>> = {}) => ({
  stagePrompt: 'Do the work.\n',
  agentsMd: '# Rules\n',
  advisory: '',
  failureContext: '',
  ...overrides,
});

describe('measuring what a prompt is made of', () => {
  it('attributes every byte to a source', () => {
    const measured = measurePromptComposition(parts());

    const summed = measured.parts.reduce((total, part) => total + part.bytes, 0);
    expect(summed).toBe(measured.totalBytes);
  });

  it('names the four sources separately', () => {
    // Separately, because they have four different owners: the stage prompt is ours, the
    // advisory block is MVP 3's retrieval, `AGENTS.md` is the repository's, and the packet
    // is recovery's. A single total cannot tell anybody which one to shrink.
    const measured = measurePromptComposition(
      parts({ advisory: 'context', failureContext: 'previous attempt' }),
    );

    expect([...measured.parts.map((part) => part.source)].sort()).toEqual([
      'advisory',
      'agentsMd',
      'failureContext',
      'stagePrompt',
    ]);
  });

  it('reports each source as a share of the whole', () => {
    const measured = measurePromptComposition(
      parts({ stagePrompt: 'x'.repeat(75), agentsMd: 'y'.repeat(25), advisory: '', failureContext: '' }),
    );

    const stage = measured.parts.find((part) => part.source === 'stagePrompt');
    expect(stage?.share).toBe(75);
  });

  it('counts bytes rather than characters, because a budget in bytes must', () => {
    // §6.5's budgets are byte budgets. A multi-byte character counted as one would
    // overshoot them quietly, which is the failure mode a budget exists to prevent.
    const measured = measurePromptComposition(parts({ stagePrompt: '“quoted”', agentsMd: '' }));

    expect(measured.totalBytes).toBeGreaterThan('“quoted”'.length);
  });

  it('omits a source that contributed nothing', () => {
    // A run with no advisory model and no retry should not read as though it had both at
    // zero — absent and empty are different facts.
    const measured = measurePromptComposition(parts());

    expect(measured.parts.map((part) => part.source)).not.toContain('advisory');
    expect(measured.parts.map((part) => part.source)).not.toContain('failureContext');
  });
});

describe('the trivial ceiling (AR-09)', () => {
  it('warns when a trivial task receives more context than the documented ceiling', () => {
    const measured = measurePromptComposition(
      parts({ agentsMd: 'x'.repeat(TRIVIAL_CONTEXT_CEILING_BYTES + 1) }),
      { complexity: 'trivial' },
    );

    expect(measured.overCeiling).toBe(true);
    // Named, so the warning says what to shrink rather than that something is too big.
    expect(measured.ceilingDetail).toContain('agentsMd');
  });

  it('says nothing for a trivial task inside the ceiling', () => {
    const measured = measurePromptComposition(parts(), { complexity: 'trivial' });
    expect(measured.overCeiling).toBe(false);
  });

  it('does not apply the ceiling to a complex task', () => {
    // The ceiling is about proportion, not about size: a complex task legitimately
    // receives a lot, and warning there would train the reader to ignore the warning.
    const measured = measurePromptComposition(
      parts({ agentsMd: 'x'.repeat(TRIVIAL_CONTEXT_CEILING_BYTES + 1) }),
      { complexity: 'complex' },
    );

    expect(measured.overCeiling).toBe(false);
  });

  it('names the largest contributor, which is the one worth shrinking', () => {
    const measured = measurePromptComposition(
      parts({
        stagePrompt: 'x'.repeat(100),
        agentsMd: 'y'.repeat(TRIVIAL_CONTEXT_CEILING_BYTES),
        advisory: 'z'.repeat(50),
      }),
      { complexity: 'trivial' },
    );

    expect(measured.ceilingDetail).toContain('agentsMd');
  });
});

describe('what a recovery cost, against the attempt it replaced (AR-09)', () => {
  it('reports the packet as an addition to a known baseline', () => {
    const cost = recoveryCostAgainstBaseline({ baselineBytes: 1000, retryBytes: 1250 });

    expect(cost?.addedBytes).toBe(250);
    expect(cost?.addedShare).toBe(25);
  });

  it('reports nothing rather than a fabricated ratio when there is no baseline', () => {
    // A first attempt whose size nobody recorded has no baseline, and inventing 100% or 0%
    // would both be assertions nobody measured.
    expect(recoveryCostAgainstBaseline({ retryBytes: 1250 })).toBeUndefined();
  });

  it('handles a retry that was smaller than the attempt before it', () => {
    // Possible and worth reporting: a packet that replaced a large advisory block can make
    // the second attempt cheaper than the first.
    const cost = recoveryCostAgainstBaseline({ baselineBytes: 1000, retryBytes: 800 });

    expect(cost?.addedBytes).toBe(-200);
    expect(cost?.addedShare).toBe(-20);
  });
});
