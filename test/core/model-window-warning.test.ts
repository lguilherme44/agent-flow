import { describe, it, expect } from 'vitest';
import { measurePromptComposition } from '../../src/core/prompt-budget.js';

/**
 * A context window is a wall, not a smell.
 *
 * `overCeiling` asks about *proportion* — a task called trivial receiving more
 * context than the repository's own standing rules. This asks about *capacity*,
 * and the failure it prevents is expensive and late: measured on a real run, the
 * server refused mid-task with the work already done, after two 45-minute
 * attempts that produced nothing.
 */
/** A composition with only the stage prompt filled — the rest genuinely empty. */
const parts = (n: number) => ({
  stagePrompt: 'x'.repeat(n),
  agentsMd: '',
  advisory: '',
  failureContext: '',
  collaborationBootstrap: '',
  collaboration: '',
});

describe('a prompt near the runner window says so before the call', () => {
  it('says nothing when no window is declared', () => {
    const c = measurePromptComposition(parts(200_000));
    expect(c.nearModelWindow).toBeUndefined();
    expect(c.windowDetail).toBeUndefined();
  });

  it('warns when the prompt passes 80% of the declared window', () => {
    // 160k bytes ≈ 42k tokens, against a 49k window — 86%.
    const c = measurePromptComposition(parts(160_000), undefined, 49_152);
    expect(c.nearModelWindow).toBe(true);
    expect(c.windowDetail).toContain('49152');
  });

  it('stays quiet with room to work', () => {
    // 40k bytes ≈ 10.5k tokens against 49k — 21%.
    expect(measurePromptComposition(parts(40_000), undefined, 49_152)
      .nearModelWindow).toBeUndefined();
  });

  it('is about the runner, not the prompt: the same prompt differs by window', () => {
    const prompt = parts(160_000);
    expect(measurePromptComposition(prompt, undefined, 49_152).nearModelWindow).toBe(true);
    expect(measurePromptComposition(prompt, undefined, 200_000).nearModelWindow).toBeUndefined();
  });

  it('names the share, so the reader knows how much room is left', () => {
    const c = measurePromptComposition(parts(160_000), undefined, 49_152);
    expect(c.windowDetail).toMatch(/\d+% of it/);
  });

  it('leaves the proportion ceiling alone — the two ask different questions', () => {
    // Trivial task, small prompt, tiny window: capacity warns, proportion does not.
    const c = measurePromptComposition(
      parts(20_000),
      { complexity: 'trivial' },
      4_000,
    );
    expect(c.nearModelWindow).toBe(true);
    expect(c.overCeiling).toBe(false);
  });
});
