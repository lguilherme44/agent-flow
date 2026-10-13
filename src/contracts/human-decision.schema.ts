import { z } from 'zod';

/**
 * A decision a named person made, in their own words.
 *
 * **The actor a run records is a channel, not a person.** `keyboard` is whoever typed at
 * this machine's terminal, and loopback HTTP skips pairing and falls back to `keyboard` too
 * — so an AI driving agent-flow records as `keyboard` exactly as a person does, and a gate
 * that trusted the actor could be opened by the AI on its own say-so. Who decided has to be
 * said, by name, and refused when it is not.
 *
 * One shape and one validator for every such decision. The e2e attestation is the first
 * user (`observedBy` + `e2eObserved`); the plan gate's `decidedBy` on approve / reject /
 * revise is the second ({@link GateDecisionSchema}), so the bounds and the refusal cannot
 * drift between them.
 */

/** The longest name a person may give: a name, not a paragraph. */
export const HUMAN_NAME_MAX_LENGTH = 120;

/** The longest text a person may give: an answer's bound (`AnswerRequestSchema`). */
export const HUMAN_WORDS_MAX_LENGTH = 4_000;

export const HumanNameSchema = z.string().trim().min(1).max(HUMAN_NAME_MAX_LENGTH);
export const HumanWordsSchema = z.string().trim().min(1).max(HUMAN_WORDS_MAX_LENGTH);

export const HumanDecisionSchema = z.object({
  /** Who decided, as they name themselves. Never inferred from the channel. */
  by: HumanNameSchema,
  /** What they said, verbatim. Quoted wherever it is shown, never interpreted. */
  words: HumanWordsSchema,
});
export type HumanDecision = z.infer<typeof HumanDecisionSchema>;

/**
 * The decision, trimmed — or the first field that does not hold, so a caller can say
 * which one to fix. `by` is judged first: words with no name are the failure this exists
 * to refuse.
 */
export function readHumanDecision(input: {
  readonly by?: unknown;
  readonly words?: unknown;
}): { readonly ok: true; readonly value: HumanDecision } | { readonly ok: false; readonly field: 'by' | 'words' } {
  const by = HumanNameSchema.safeParse(input.by);
  if (!by.success) return { ok: false, field: 'by' };
  const words = HumanWordsSchema.safeParse(input.words);
  if (!words.success) return { ok: false, field: 'words' };
  return { ok: true, value: { by: by.data, words: words.data } };
}

/**
 * How a plan-gate decision reached agent-flow — derived by the adapter, never said by the
 * caller about itself.
 *
 * `deck` is a browser write carrying this server as its Origin; `api` is every other HTTP
 * client the write guard admitted on its client header — an AI or a script; `cli` is the
 * terminal. The name and the words are free text anyone can type, so the channel is what
 * lets a human reading the run see that a decision "in their name" arrived through an AI's
 * hands. It is a record, not authentication: a non-browser client that forges an Origin
 * header is read as `deck`.
 */
export const DECISION_CHANNELS = ['deck', 'api', 'cli'] as const;
export const DecisionChannelSchema = z.enum(DECISION_CHANNELS);
export type DecisionChannel = z.infer<typeof DecisionChannelSchema>;

/** The plan-gate moves a decision is recorded on. */
export const GATE_DECISION_ACTIONS = ['approve', 'reject', 'revise'] as const;
export type GateDecisionAction = (typeof GATE_DECISION_ACTIONS)[number];

/**
 * Every operator action that is a human decision, and so carries a name and words over the
 * API: the three gate moves, an answer to a BLOCKED task (the human's knowledge reaching the
 * next attempt), a cancel (irreversible) and a retry that overrides a gate (`force`, or a
 * declaration that the task changes nothing). A plain retry, start, pause, resume and review
 * are not here — they record only the channel they came through.
 */
export const HUMAN_DECISION_ACTIONS = [
  ...GATE_DECISION_ACTIONS,
  'answer',
  'cancel',
  'retry',
  // Closing a run the Definition of Done did not (dogfood 09/10).
  'complete',
] as const;
export type HumanDecisionAction = (typeof HUMAN_DECISION_ACTIONS)[number];

/**
 * A decision at the plan gate: who made it, their words, and the channel it came through.
 * Recorded as `decidedBy` on the `operator_action` event the move appends. The same shape is
 * recorded for the other human decisions ({@link HUMAN_DECISION_ACTIONS}): an answer, a cancel.
 */
export const GateDecisionSchema = HumanDecisionSchema.extend({ channel: DecisionChannelSchema });
export type GateDecision = z.infer<typeof GateDecisionSchema>;
