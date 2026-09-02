import { z } from 'zod';

/**
 * What agents are allowed to say to each other, and how much of it (M4, §9).
 *
 * Its own file for the reason `utility-model-config.schema.ts` is: a block with this many
 * knobs makes `config.schema.ts` unreadable, and a reader looking for the recovery budgets
 * should not have to scroll past a second set of budgets that bound something else.
 *
 * **Every field is defaulted and the whole block is optional.** A project whose
 * `config.yaml` predates this milestone parses unchanged and behaves unchanged, which is
 * the whole of M4's migration story.
 */
export const CollaborationConfigSchema = z.object({
  /**
   * Whether agents may talk at all.
   *
   * **Ships `false`**, and with it off the product behaves byte-for-byte as it did before
   * the milestone: no outbox is read, no directory is created, no block reaches a prompt,
   * and `stage_context_measured` reports the same four sources it always did.
   *
   * That is AR-00's rule applied rather than timidity. A channel whose first real traffic
   * nobody has seen must not read as a feature that is on, and the thing that earns the
   * flip is M4-08's dogfood — exactly as AR-03 was the milestone that turned
   * `recovery.enabled` on after AR-00 shipped it off with a stated expiry.
   */
  enabled: z.boolean().default(false),

  /**
   * Messages one task may contribute, across all of its attempts.
   *
   * Per task rather than per run, because the thing being bounded is a *loop*: an agent
   * that answers its own question and asks another has to run out of budget somewhere,
   * and a run-wide number would let one task consume everything the others needed.
   */
  maxMessagesPerTask: z.number().int().min(0).default(12),

  /**
   * Bytes of one message body, after redaction.
   *
   * Truncation is marked on the message (`truncated: true`) rather than applied quietly:
   * a body that stops mid-sentence with no sign is how a reader concludes the agent said
   * something it did not.
   */
  maxMessageBytes: z.number().int().min(256).default(4 * 1024),

  /**
   * The size cap on the outbox file, checked **before** it is parsed.
   *
   * Before, and not after, because the failure being prevented is a 2 GB file becoming a
   * 2 GB string. A schema cannot defend against a file it has already been handed.
   */
  maxOutboxBytes: z.number().int().min(1024).default(64 * 1024),

  /**
   * Messages in one thread.
   *
   * The anti-thrash rule for conversation, and the same reasoning as
   * `recovery.maxIdenticalFailures`: two agents that have exchanged eight messages about
   * one task are not converging, and the ninth is not the one that fixes it.
   */
  maxThreadDepth: z.number().int().min(2).default(8),

  maxHandoffsPerTask: z.number().int().min(0).default(2),

  /**
   * Blackboard entries one run may hold.
   *
   * Bounded because the blackboard feeds a prompt: an unbounded knowledge base is a
   * context budget that fails open, which is the failure AR-09 exists to make visible.
   */
  maxBlackboardEntriesPerRun: z.number().int().min(0).default(200),

  /**
   * Bytes of collaboration context one prompt may receive.
   *
   * Deliberately smaller than `recovery.maxPacketBytes` (8 kB): a Failure Context Packet
   * describes the failure this attempt exists to fix, and collaboration context is
   * background. Background that outweighs the task is the proportion problem
   * `core/prompt-budget.ts` was written to name.
   */
  maxContextBytes: z.number().int().min(0).default(4 * 1024),

  /**
   * Whether an accepted handoff changes **who executes** a task.
   *
   * **Ships `false`.** With it off a handoff is a complete, auditable record that reroutes
   * nothing: `resolveTaskAgent` still returns the router's answer for every task. With it
   * on, an accepted handoff's target replaces that answer — and only when the target's
   * (runner, model) pair satisfies the implementation prompt's requirements, checked
   * through the same `resolveRole` every other resolution goes through.
   *
   * Off by default because re-routing execution from model output is an *ownership*
   * transfer, and ownership is on the short list of things a model may not decide. The
   * mechanism is built, bounded and tested; turning it on is an operator's decision.
   */
  handoffsReassignExecution: z.boolean().default(false),
});

export type CollaborationConfig = z.infer<typeof CollaborationConfigSchema>;
