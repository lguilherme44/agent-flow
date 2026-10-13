import { describe, expect, it } from 'vitest';
import {
  DECISION_CHANNELS,
  GateDecisionSchema,
  HUMAN_NAME_MAX_LENGTH,
  HUMAN_WORDS_MAX_LENGTH,
  HumanDecisionSchema,
  readHumanDecision,
} from '../../src/contracts/index.js';

/**
 * A decision a named person made, in their own words.
 *
 * The actor a run records is the channel (`keyboard`, a paired device), and an AI driving
 * the CLI is `keyboard` too — so "who decided" has to be said by name, and refused when it
 * is not. One shape and one validator, because the e2e attestation is its first user and
 * approve / reject / revise are next.
 */
describe('HumanDecision', () => {
  it('trims both fields at the ends', () => {
    expect(HumanDecisionSchema.parse({ by: '  Luis  ', words: '  Saw it.  ' })).toEqual({
      by: 'Luis',
      words: 'Saw it.',
    });
  });

  it('refuses a decision with no name, naming the field', () => {
    expect(readHumanDecision({ by: '   ', words: 'Saw it.' })).toEqual({ ok: false, field: 'by' });
    expect(readHumanDecision({ words: 'Saw it.' })).toEqual({ ok: false, field: 'by' });
  });

  it('refuses a decision with no words, naming the field', () => {
    expect(readHumanDecision({ by: 'Luis', words: ' ' })).toEqual({ ok: false, field: 'words' });
  });

  it('refuses a name or words past their bounds', () => {
    expect(readHumanDecision({ by: 'x'.repeat(HUMAN_NAME_MAX_LENGTH + 1), words: 'w' })).toEqual({
      ok: false,
      field: 'by',
    });
    expect(readHumanDecision({ by: 'Luis', words: 'w'.repeat(HUMAN_WORDS_MAX_LENGTH + 1) })).toEqual({
      ok: false,
      field: 'words',
    });
  });

  it('accepts a decision at its bounds', () => {
    const at = readHumanDecision({
      by: 'x'.repeat(HUMAN_NAME_MAX_LENGTH),
      words: 'w'.repeat(HUMAN_WORDS_MAX_LENGTH),
    });
    expect(at.ok).toBe(true);
  });
});

/**
 * A plan-gate decision: the same who-and-words, plus the channel it came through, so a human
 * reading the run can see a decision that reached agent-flow over the API — an AI's hands —
 * apart from one clicked in the Deck or typed with the CLI.
 */
describe('GateDecision', () => {
  it('carries the channel beside the human decision', () => {
    expect(GateDecisionSchema.parse({ by: ' Luis ', words: ' Go. ', channel: 'api' })).toEqual({
      by: 'Luis',
      words: 'Go.',
      channel: 'api',
    });
  });

  it('knows exactly three channels', () => {
    expect([...DECISION_CHANNELS]).toEqual(['deck', 'api', 'cli']);
    expect(GateDecisionSchema.safeParse({ by: 'Luis', words: 'Go.', channel: 'mcp' }).success).toBe(
      false,
    );
  });

  it('refuses a decision with no channel', () => {
    expect(GateDecisionSchema.safeParse({ by: 'Luis', words: 'Go.' }).success).toBe(false);
  });
});
