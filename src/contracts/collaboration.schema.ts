import { z } from 'zod';
import {
  AnyTaskIdSchema,
  ArtifactNameSchema,
  IsoTimestampSchema,
  RunIdSchema,
  WorkflowRoleSchema,
} from './common.schema.js';
import { validateAndNormalizeRepositoryPath } from './context-packet.schema.js';

/**
 * What agents are, what they say to each other, and what they write down (M4).
 *
 * Three vocabularies in one file because they share a trust story and nothing else in
 * the product shares it with them: **everything an agent authors is untrusted input.**
 * A plan already is — which is why `ValidationIdSchema` exists and why a task names an
 * id rather than a command — and a message is the same material arriving through a
 * different door.
 *
 * So the shapes here are narrow on purpose. A reference is a closed union rather than a
 * string, because an open one is a path field with extra steps. A recipient is a
 * discriminated object rather than a magic prefix, because a string convention is a
 * parser every reader has to re-implement and eventually one of them gets it wrong.
 *
 * **Nothing in this file carries workflow authority (I-27).** No message type completes
 * a task, opens a gate, moves a stage or signs a verdict, and no reader of these types
 * may be given the ability to. The modules that consume them are pure projections.
 */

/* ─── Identity ─────────────────────────────────────────────────────────────── */

/**
 * The id of an agent, a human or the orchestrator.
 *
 * The character set is the first defence and it is the same reasoning as
 * `ValidationIdSchema`: an id ends up in a log line, a projection key and a rendered
 * prompt block, and a string that can express a path separator, a shell metacharacter
 * or a newline is a string that eventually does.
 *
 * **The rule is "nothing that can express a path, a shell or a newline", not "lowercase".**
 * The first draft of this regex forbade uppercase and the roster test caught it
 * immediately: `WORKFLOW_ROLES` contains `planReviewer` and `finalReviewer`, so a
 * lowercase-only id would have forced a *second* spelling of the role vocabulary — and
 * two spellings of one identifier is how a message written by one reader fails to resolve
 * for another. Case is irrelevant to every threat in the paragraph above.
 *
 * The leading character must still be a lowercase letter, so that `Architect` and
 * `architect` cannot both exist and mean the same agent.
 *
 * Dots are allowed for the same reason: the derived roster uses the role vocabulary
 * verbatim, and `executor.normal` is an agent id in M4.
 */
export const AgentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*$/,
    'expected an agent id such as "architect", "planReviewer" or "executor.normal"',
  );
export type AgentId = z.infer<typeof AgentIdSchema>;

/**
 * The two participants that are not derived from configuration.
 *
 * `human` authors approvals, revisions and the answers to escalations. `orchestrator`
 * authors what Agent Flow itself has to say — a budget that ran out, an outbox it
 * refused. Both exist so that a conversation involving them does not have to be modelled
 * as a message from nobody, which is how an audit trail acquires an unattributable line.
 */
export const HUMAN_AGENT_ID = 'human';
export const ORCHESTRATOR_AGENT_ID = 'orchestrator';

export const RESERVED_AGENT_IDS: readonly AgentId[] = [HUMAN_AGENT_ID, ORCHESTRATOR_AGENT_ID];

/**
 * A logical agent. **Not a process, and not a stage invocation.**
 *
 * The distinction is the reason this type exists at all. `executor.normal` is a role and
 * a role is a slot; the thing that answered a question during TASK-003 and is being asked
 * a follow-up during TASK-007 has to be nameable across both, and a stage invocation is
 * over before the follow-up is written.
 *
 * `id` is a separate field from `role` **from the first version**, and that is a decision
 * rather than redundancy. In M4 the roster is derived and the two are equal. M5's
 * `teams:` block introduces a member whose id is `frontend` and whose role is
 * `executor.normal`, and every message written under M4 still resolves — because it was
 * never keyed on the role.
 */
export const AgentIdentitySchema = z.object({
  id: AgentIdSchema,
  displayName: z.string().min(1).max(120),
  role: WorkflowRoleSchema,
  runner: z.string().min(1),
  model: z.string().min(1).optional(),
  /**
   * What this agent is good at. Empty in M4, and empty is honest: nothing configures a
   * skill yet, and a derived list of guesses would be read as a measurement.
   */
  skills: z.array(z.string().min(1).max(40)).default([]),
  specializations: z.array(z.string().min(1).max(40)).default([]),
});
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

/* ─── Ids ──────────────────────────────────────────────────────────────────── */

export const MessageIdSchema = z.string().regex(/^MSG-\d{4}$/, 'expected MSG-0000');
export type MessageId = z.infer<typeof MessageIdSchema>;

export const ThreadIdSchema = z.string().regex(/^THR-\d{4}$/, 'expected THR-0000');
export type ThreadId = z.infer<typeof ThreadIdSchema>;

/**
 * Blackboard entry kinds, and the id prefix each one carries.
 *
 * A prefix per kind rather than one shared sequence, because the id is the thing a
 * message cites and a person reads aloud. `DEC-004` says what it is; `ENT-004` needs a
 * lookup to say anything at all.
 */
export const BLACKBOARD_ENTRY_KINDS = [
  'decision',
  'contract',
  'constraint',
  'discovery',
  'risk',
] as const;

export const BlackboardEntryKindSchema = z.enum(BLACKBOARD_ENTRY_KINDS);
export type BlackboardEntryKind = z.infer<typeof BlackboardEntryKindSchema>;

export const ENTRY_ID_PREFIX: Readonly<Record<BlackboardEntryKind, string>> = {
  decision: 'DEC',
  contract: 'CTR',
  constraint: 'CST',
  discovery: 'DSC',
  risk: 'RSK',
};

export const EntryIdSchema = z
  .string()
  .regex(/^(?:DEC|CTR|CST|DSC|RSK)-\d{3}$/, 'expected DEC-000, CTR-000, CST-000, DSC-000 or RSK-000');
export type EntryId = z.infer<typeof EntryIdSchema>;

/* ─── References ───────────────────────────────────────────────────────────── */

/**
 * The whole of what an agent may point at. Closed, and that is the point.
 *
 * An open `{ kind: string, id: string }` would be a free-text field wearing a schema,
 * and the `file` variant would be a path a model wrote reaching a reader that trusts it.
 * Each variant below resolves against something Agent Flow already knows: a task in the
 * plan, an artifact in the closed vocabulary, a path the ContextPacket's own validator
 * accepts, an attempt that was recorded, an entry or a message in this run.
 *
 * The `file` variant reuses `validateAndNormalizeRepositoryPath` rather than writing a
 * second path rule. That function already rejects absolute paths, `..`, percent-encoded
 * traversal, URL schemes, drive letters, UNC shares, control characters, `.git` and
 * `.agent-flow` — and a second implementation of that list is a second chance to miss one.
 */
export const CollaborationReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), id: AnyTaskIdSchema }),
  z.object({ kind: z.literal('artifact'), id: ArtifactNameSchema }),
  z.object({
    kind: z.literal('file'),
    id: z
      .string()
      .min(1)
      .max(400)
      .refine((path) => validateAndNormalizeRepositoryPath(path).valid, {
        message: 'expected a path inside the repository, relative to its root',
      }),
  }),
  z.object({
    kind: z.literal('attempt'),
    id: z.string().regex(/^(?:TASK|FIX)-\d{3}#[1-9]\d{0,3}$/, 'expected TASK-000#1'),
  }),
  z.object({ kind: z.literal('entry'), id: EntryIdSchema }),
  z.object({ kind: z.literal('message'), id: MessageIdSchema }),
]);
export type CollaborationReference = z.infer<typeof CollaborationReferenceSchema>;

/* ─── Messages ─────────────────────────────────────────────────────────────── */

/**
 * What a message is for.
 *
 * Grouped by what the projection does with each. The conversational five drive thread
 * status; the three handoff types drive the handoff projection; `review_request` and
 * `review_feedback` are declared now and are not yet produced by anything — M6 owns the
 * review protocol, and coining the name there rather than here would give one concept two
 * spellings, which is the defect `RECOVERY_EVENT_TYPES` was written to prevent.
 */
export const MESSAGE_TYPES = [
  // Conversation.
  'question',
  'answer',
  'acknowledge',
  'information',
  'finding',
  'decision',
  'blocker',
  // Handoff.
  'handoff_request',
  'handoff_accepted',
  'handoff_rejected',
  // Review — declared for M6, produced by nothing in M4.
  'review_request',
  'review_feedback',
] as const;

export const MessageTypeSchema = z.enum(MESSAGE_TYPES);
export type MessageType = z.infer<typeof MessageTypeSchema>;

/**
 * Who a message is addressed to.
 *
 * A discriminated object rather than a string with a reserved prefix. "Is this a group?"
 * is then a schema question answered once, instead of a `startsWith` in every reader —
 * and the day a third addressing mode is needed, the union grows and every exhaustive
 * switch stops compiling, which is the notification you want.
 */
export const MessageRecipientSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), id: AgentIdSchema }),
  z.object({ kind: z.literal('role'), role: WorkflowRoleSchema }),
  z.object({ kind: z.literal('everyone') }),
]);
export type MessageRecipient = z.infer<typeof MessageRecipientSchema>;

/** The types that must name exactly one agent and one task. */
const DIRECTED_TYPES: ReadonlySet<MessageType> = new Set([
  'handoff_request',
  'handoff_accepted',
  'handoff_rejected',
]);

export const AgentMessageSchema = z
  .object({
    id: MessageIdSchema,
    runId: RunIdSchema,
    /**
     * The conversation this belongs to. Allocated by Agent Flow, never by the author:
     * a message with no `inReplyTo` opens a thread, one with an `inReplyTo` inherits
     * that message's thread.
     */
    threadId: ThreadIdSchema,
    /**
     * Who sent it — **assigned from the dispatch that produced it** (I-28).
     *
     * Never read from anything an agent wrote. `ProposedMessageSchema` has no `from`
     * field at all, so a forged one is discarded by the parse rather than by a check
     * somebody has to remember to write.
     */
    from: AgentIdSchema,
    to: MessageRecipientSchema,
    type: MessageTypeSchema,
    taskId: AnyTaskIdSchema.optional(),
    inReplyTo: MessageIdSchema.optional(),
    subject: z.string().min(1).max(200),
    /**
     * Redacted and length-bounded before it gets here (I-21, I-31).
     *
     * The cap in the schema is generous because the operative cap is
     * `collaboration.maxMessageBytes`, applied at harvest where the truncation can be
     * *marked*. A schema that silently rejected an over-long body would lose what the
     * agent said; the harvest truncates and says so.
     */
    body: z.string().min(1).max(64_000),
    references: z.array(CollaborationReferenceSchema).max(20).default([]),
    /** True when the body was cut to fit the byte budget. Never cut silently. */
    truncated: z.boolean().default(false),
    createdAt: IsoTimestampSchema,
  })
  .superRefine((message, ctx) => {
    if (!DIRECTED_TYPES.has(message.type)) return;

    // A handoff is a transfer between two named agents about one named task. Addressed
    // to a role or to everyone it is not a handoff, it is an announcement — and the
    // projection would have to guess which agent it bound, which is exactly the guess
    // §4.5 exists to remove.
    if (message.to.kind !== 'agent') {
      ctx.addIssue({
        code: 'custom',
        message: `a ${message.type} must be addressed to one agent, not to ${message.to.kind}`,
        path: ['to'],
      });
    }
    if (message.taskId === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `a ${message.type} must name the task it concerns`,
        path: ['taskId'],
      });
    }
  });
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

/* ─── Blackboard ───────────────────────────────────────────────────────────── */

export const BlackboardEntrySchema = z
  .object({
    id: EntryIdSchema,
    runId: RunIdSchema,
    kind: BlackboardEntryKindSchema,
    /**
     * The topic. What supersession is keyed on, and what a reader scans.
     *
     * Free text rather than an enum because the topics of a real feature are not
     * knowable in advance — `checkout-idempotency` is a subject nobody could have
     * enumerated. Bounded, so it stays a subject rather than becoming a second body.
     */
    subject: z.string().min(1).max(120),
    author: AgentIdSchema,
    statement: z.string().min(1).max(4_000),
    rationale: z.string().max(4_000).optional(),
    /**
     * Which roles this is addressed to. Roles rather than agent ids on purpose: an
     * entry outlives the agent that wrote it and should reach whoever holds the role
     * next, which is precisely what M5's teams will change about who that is.
     *
     * Empty means "everyone", and is the honest default for a discovery nobody knew
     * the audience of.
     */
    affects: z.array(WorkflowRoleSchema).max(16).default([]),
    references: z.array(CollaborationReferenceSchema).max(20).default([]),
    /**
     * The entry this one replaces, when it replaces one.
     *
     * Never a deletion and never an edit (I-30). The projection decides what the pair
     * means: same author is a correction, a different author is a *contested* pair with
     * both entries live and both reaching the next agent.
     */
    supersedes: EntryIdSchema.optional(),
    truncated: z.boolean().default(false),
    createdAt: IsoTimestampSchema,
  })
  .superRefine((entry, ctx) => {
    const expected = ENTRY_ID_PREFIX[entry.kind];
    if (!entry.id.startsWith(`${expected}-`)) {
      // The prefix is the kind, spelled where a person reads it. An entry whose id and
      // kind disagree would make every citation ambiguous — `DEC-004` cited from a
      // message would resolve to a risk, and nothing downstream would notice.
      ctx.addIssue({
        code: 'custom',
        message: `a ${entry.kind} entry has an id starting ${expected}-, not ${entry.id}`,
        path: ['id'],
      });
    }
    if (entry.supersedes === entry.id) {
      ctx.addIssue({
        code: 'custom',
        message: 'an entry cannot supersede itself',
        path: ['supersedes'],
      });
    }
  });
export type BlackboardEntry = z.infer<typeof BlackboardEntrySchema>;

/* ─── What an agent may propose ────────────────────────────────────────────── */

/**
 * One message as an agent writes it. **Deliberately a smaller shape than the record.**
 *
 * Six fields are absent and every absence is a defence:
 *
 *   - `from` — assigned from the dispatch (I-28). Zod strips unknown keys, so a forged
 *     sender is discarded by the parse itself rather than by a check somebody has to
 *     remember. The harvest still *notices* it was there and records that it did, because
 *     a defence that leaves no trace is a defence nobody can audit.
 *   - `id`, `threadId`, `createdAt`, `runId` — allocated by Agent Flow. An author that
 *     could choose its own id could overwrite another's message.
 *   - `truncated` — a fact about what Agent Flow did to the body, not a claim the author
 *     is entitled to make.
 *   - `taskId` — assigned from the dispatch, for the same reason `from` is: an agent
 *     working on TASK-003 must not be able to file a message against TASK-007. Absent
 *     rather than accepted-and-overwritten, because a field that is read and then ignored
 *     is a field the next reader assumes is honoured.
 */
export const ProposedMessageSchema = z.object({
  to: MessageRecipientSchema,
  type: MessageTypeSchema,
  inReplyTo: MessageIdSchema.optional(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1),
  references: z.array(CollaborationReferenceSchema).max(20).default([]),
});
export type ProposedMessage = z.infer<typeof ProposedMessageSchema>;

/** One blackboard entry as an agent writes it. `author`, `id` and `runId` are ours. */
export const ProposedEntrySchema = z.object({
  kind: BlackboardEntryKindSchema,
  subject: z.string().min(1).max(120),
  statement: z.string().min(1),
  rationale: z.string().optional(),
  affects: z.array(WorkflowRoleSchema).max(16).default([]),
  references: z.array(CollaborationReferenceSchema).max(20).default([]),
  supersedes: EntryIdSchema.optional(),
});
export type ProposedEntry = z.infer<typeof ProposedEntrySchema>;

/**
 * The file an agent leaves behind: `.agent-flow-outbox.json` in its workspace.
 *
 * Read after the process exits and removed before the tree is captured (I-32), so no
 * outbox can enter a validated tree, a marker, a diff or `filesChanged`. Everything in it
 * is a *proposal*; this schema is where the proposal stops being free-form.
 *
 * Both arrays default to empty, so an agent that wants to say one thing writes one key.
 * An outbox with neither is legal and is a no-op — which is what an agent that had
 * nothing to say should be able to produce without getting an error for it.
 */
export const AgentOutboxSchema = z.object({
  messages: z.array(ProposedMessageSchema).default([]),
  entries: z.array(ProposedEntrySchema).default([]),
});
export type AgentOutbox = z.infer<typeof AgentOutboxSchema>;

/**
 * Why one proposal was refused.
 *
 * A value rather than an exception, and per item rather than per file: one malformed
 * message must not discard the four beside it that were fine. The whole file is refused
 * only when it cannot be parsed at all, which is a different event.
 */
export const COLLABORATION_REJECTIONS = [
  'schema_invalid',
  'unknown_recipient',
  'unknown_thread',
  'budget_exhausted',
  'thread_depth_exceeded',
  'unknown_supersedes',
] as const;

export const CollaborationRejectionSchema = z.enum(COLLABORATION_REJECTIONS);
export type CollaborationRejection = z.infer<typeof CollaborationRejectionSchema>;
