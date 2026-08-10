import { describe, it, expect } from 'vitest';
import { nextStepAfterPlanning } from '../../src/cli/feature.js';

/**
 * Found in a live run: the plan review returned FAIL, and the command still
 * closed with "Then: agent-flow approve". Following that advice hits a gate
 * that refuses — the message was written once, for the happy path, and never
 * consulted the verdict it had just printed above it.
 *
 * Same shape as the `status` bug: output asserting something the state does not
 * support. Cheap to get wrong, because nothing fails when it is wrong.
 */
describe('the closing advice matches the verdict', () => {
  it('sends a passing plan to approval', () => {
    expect(nextStepAfterPlanning('PASS')).toContain('agent-flow approve');
  });

  it('sends a failed plan to revision, not to the gate', () => {
    const advice = nextStepAfterPlanning('FAIL');

    expect(advice).toContain('agent-flow revise');
    expect(advice).not.toMatch(/Then: agent-flow approve/);
  });

  it('says the gate can still be forced, because it can', () => {
    // Hiding the option would be its own kind of lie: `--force` exists, it is
    // recorded on the run, and a person who has read the findings is entitled
    // to overrule them.
    expect(nextStepAfterPlanning('FAIL')).toContain('--force');
  });

  it('sends an unreviewed plan to approval', () => {
    // `--skip-review` leaves no verdict. There is nothing to revise against,
    // and the approval gate is exactly where the missing review gets noticed.
    expect(nextStepAfterPlanning(undefined)).toContain('agent-flow approve');
  });
});
