import type { GateDecision } from '../../src/contracts/index.js';

/**
 * A plan-gate decision as the CLI hands it to the use case: a named human, their words,
 * and the channel the adapter derived. For tests about something other than attribution,
 * which still have to say who decided — the use cases refuse a gate move without it.
 */
export const DECIDED: GateDecision = {
  by: 'Test Operator',
  words: 'Go ahead.',
  channel: 'cli',
};

/** The HTTP body half of a decision, for a non-browser client, which must send it. */
export const DECIDED_BY_BODY = { decidedBy: { by: 'Test Operator', words: 'Go ahead.' } } as const;
