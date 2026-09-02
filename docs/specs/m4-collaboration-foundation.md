# M4 — Collaboration Foundation

## 0. Status and scope

Normative for M4-00 … M4-08. Where this document and the code disagree, the code
is the current truth and this document is the defect.

M4 gives a run **agents** rather than only roles, a **record of what they said to
each other**, and a **place to put a decision so the next agent finds it**. It gives
them nothing else. No team configuration, no skills-based assignment, no resource
ownership, no review protocol, no forge — those are M5 … M7 and are named here only
where M4 has to leave a door open for them.

The prior art this milestone must not duplicate is listed in §12. The single most
important instruction in this document is §2: **no concept in M4 may become a
second answer to a question the product already answers.**

---

## 1. Repository assessment — what M4 is being built on

Measured on `master` at the commit this document was written against.

### 1.1 Baseline

| Gate | Result |
|---|---|
| `npm ci` | PASS |
| `npm run typecheck` | PASS |
| `npm run typecheck:web` | PASS |
| `npm run typecheck:e2e` | PASS |
| `npm run lint` | PASS — 0 errors, 3 warnings (unused `eslint-disable` directives in `test/core/repository-retriever.test.ts`) |
| `npm run test` | PASS — 142 files, 3074 tests, 1 file / 2 tests skipped |
| `npm run test:web` | PASS — 26 files, 293 tests |
| `npm run build` | PASS — `dist/bin/agent-flow.js`, 770 kB |
| `npm run build:web` | PASS — 504 kB index chunk (over Vite's 500 kB advisory) |
| `npm run test:e2e` | not run in this environment — requires a Playwright browser download |

≈105 000 lines of TypeScript across `src`, `test`, `apps/web`.

### 1.2 Current capabilities

- Nine logical roles, resolved deterministically to (runner, model, effort) with
  per-model capability narrowing and a loud clamp.
- Four runner adapters: `claude-code-cli`, `codex-cli`, `agy-cli`,
  `openai-compatible`.
- Planning pipeline through an approval gate bound to one plan hash.
- Git worktree isolation, attempt receipts, marker commits, deterministic
  integration, crash recovery.
- Failure taxonomy, bounded autonomous recovery, corrective rounds.
- Advisory context from an optional local UtilityModel, with a strict trust
  boundary and per-source prompt telemetry.
- A local Fastify control plane and a React dashboard that project run state.
- 3371 lines of architecture tests that enforce the layering mechanically.

### 1.3 Current limitations, against M4's target

| # | Gap |
|---|---|
| G-1 | An agent is a *role*, not an entity. Nothing has an identity that outlives one stage invocation. |
| G-2 | There is no channel between two agents. Everything one agent learns dies with its process. |
| G-3 | There is no structured place for a decision. `sdd.md` and `architecture-impact.md` are prose artifacts written once by one stage. |
| G-4 | Task → executor routing reads `complexity`, `risk` and three flags. It cannot express "who". |
| G-5 | Review is a verdict artifact, not a conversation. A finding becomes a `FIX-` task and the thread ends. |
| G-6 | Prompt context is composed from four sources (`stagePrompt`, `agentsMd`, `advisory`, `failureContext`). There is no fifth for anything another agent said. |

### 1.4 Technical debt found during the audit

Recorded because it is in the blast radius of this milestone, not as a licence to
fix everything.

| # | Where | What |
|---|---|---|
| D-1 | `src/contracts/config.schema.ts`, `git.useWorktrees` | The comment says the flag is "inert" and "read by nothing that executes anything". Worktree isolation shipped in MVP 2; `run-git-identity.ts` reads it to decide `isolationMode` and `TaskWorkspaces` creates worktrees from it. |
| D-2 | `src/app/scheduler.ts:117`, `src/app/execution-context.ts:317` | Both say `recovery.enabled` "ships `false`". It has shipped `true` since AR-03 — `config.schema.ts` and `defaults.ts` both say so. |
| D-3 | `README.md:282`, `README.pt-BR.md:284` | Both list **OpenCode** as an agent CLI you can run against. No `opencode` adapter exists; the registry's four types are `claude-code-cli`, `codex-cli`, `agy-cli`, `openai-compatible`. |
| D-4 | `apps/web` build | The index chunk is 504 kB, over Vite's warning threshold. |

D-1, D-2 and D-3 are corrected as part of M4-00 because they are documentation
claims that are false *today*, and M4 adds surfaces that would repeat them.
D-4 is left alone: it is a pre-existing build characteristic and unrelated.

---

## 2. The rule that governs every decision below

> **One truth per concept.**

The concrete instances for M4:

| Concept | Its one home | What M4 must *not* build |
|---|---|---|
| ordering of work | `core/dag.ts` | a message-driven or handoff-driven ordering |
| when work runs | `app/scheduler.ts` | a "team scheduler" |
| what a task is worth | `core/router.ts` | a second routing table |
| whether a task is done | `app/integrator.ts` (worktree) / `app/task-executor.ts` (sequential) | a message that completes a task |
| what a prompt is made of | `core/prompt-budget.ts` | a second measurement |
| repository relevance | `core/repository-retriever.ts` | a second retriever |
| audit trail | `events.jsonl` via `StateStore` | a parallel history |
| run condition as seen by a human | `core/run-projection.ts` | a second status derivation |

M4 adds two persisted logs and five pure projection modules. It adds **no**
scheduler, **no** state machine over tasks, and **no** second router.

---

## 3. Invariants

Numbered continuing from the existing series (I-26 is the last one in use).

- **I-27 — A message has no workflow authority.** No message, of any type, from
  any agent, can change a task state, a run status, a stage, the DAG, an approval,
  a validation verdict, a receipt, a marker or an integration. The collaboration
  modules import nothing that could: an architecture test forbids
  `src/core/collaboration/**` and `src/app/collaboration-*.ts` from importing the
  scheduler, the integrator, the task executor, `child_process`, or any Git module.

- **I-28 — An agent cannot forge a sender.** The `from` of every persisted message
  is assigned by Agent Flow from the dispatch it is harvesting. A value supplied by
  the agent is discarded, not validated.

- **I-29 — Agent-authored content never reaches a shell, a path or a ref.** A
  message body is text. A reference is a closed union whose file variant is
  validated by the same repository-path validator the ContextPacket uses. Nothing
  in a message is interpolated into a command, a filename or a Git ref.

- **I-30 — Nothing an agent writes is silently overwritten.** The blackboard is
  append-only. A change is a new entry naming the one it supersedes, and a
  supersession by an author other than the original is recorded as **contested**,
  with both entries live and both reaching the reader.

- **I-31 — Collaboration is bounded by construction.** Every log has a per-run and
  per-task budget, every message a byte cap, every rendered context block a byte
  cap. An exhausted budget stops the channel, records which budget and names one
  action — never a loop, never a silent drop.

- **I-32 — Harvest happens after the agent exits and before the tree is captured.**
  The outbox is read and removed in that window, so no message file can enter a
  validated tree, a marker, a diff or `filesChanged`.

---

## 4. Domain

### 4.1 `AgentIdentity`

An agent is a **logical entity**; a stage invocation is an **occurrence**. The
distinction is the reason this type exists: `executor.normal` is a role, and the
thing that answered a question yesterday and is being asked a follow-up today has
to be nameable across both.

```ts
interface AgentIdentity {
  readonly id: AgentId;            // 'architect', 'executor.normal', later 'frontend'
  readonly displayName: string;
  readonly role: WorkflowRole;     // the existing vocabulary — unchanged
  readonly runner: string;
  readonly model?: string;
  readonly skills: readonly string[];
  readonly specializations: readonly string[];
}
```

**In M4 the roster is derived, not configured.** `deriveAgentRoster(config)` is a
pure function returning one identity per `WORKFLOW_ROLES` entry, with `id === role`
and `skills: []`. That is the whole of backward compatibility: a project whose
`config.yaml` has only `roles:` gets nine agents and needs no migration.

`id` is a separate field from `role` **on purpose and from the start**. M5's
`teams:` block will introduce members whose id is `frontend` and whose role is
`executor.normal`, and every message, handoff and blackboard entry written under M4
will still resolve, because they were never keyed on the role.

Two ids are reserved and are not derived from configuration:

| id | Who |
|---|---|
| `human` | the operator. Author of approvals, revisions, answers to escalations. |
| `orchestrator` | Agent Flow itself. Author of budget notices and harvest rejections. |

### 4.2 `AgentMessage`

```ts
interface AgentMessage {
  readonly id: MessageId;          // 'MSG-0001', allocated per run
  readonly runId: RunId;
  readonly threadId: ThreadId;     // 'THR-0001'
  readonly from: AgentId;          // assigned by Agent Flow (I-28)
  readonly to: MessageRecipient;
  readonly type: MessageType;
  readonly taskId?: AnyTaskId;
  readonly inReplyTo?: MessageId;
  readonly subject: string;
  readonly body: string;           // redacted and bounded
  readonly references: readonly CollaborationReference[];
  readonly createdAt: IsoTimestamp;
}

type MessageType =
  | 'question' | 'answer' | 'acknowledge'
  | 'information' | 'finding' | 'decision' | 'blocker'
  | 'handoff_request' | 'handoff_accepted' | 'handoff_rejected'
  | 'review_request' | 'review_feedback';

type MessageRecipient =
  | { readonly kind: 'agent'; readonly id: AgentId }
  | { readonly kind: 'role'; readonly role: WorkflowRole }
  | { readonly kind: 'everyone' };
```

A discriminated recipient rather than a magic string: "is this a group?" is a
schema question, and a string convention is a parser every reader has to
re-implement.

### 4.3 `CollaborationReference`

The whole of what a message may point at. Closed, because an open one is a path
field with extra steps.

| kind | id | validated as |
|---|---|---|
| `task` | `TASK-001` / `FIX-001` | `AnyTaskIdSchema` |
| `artifact` | `sdd`, `plan`, … | the existing `ArtifactName` union |
| `file` | `src/core/dag.ts` | `validateAndNormalizeRepositoryPath` — the ContextPacket's own validator |
| `attempt` | `TASK-001#2` | task id + positive integer |
| `entry` | `DEC-001` | a blackboard entry id in this run |
| `message` | `MSG-0007` | a message id in this run |

A reference that does not validate is dropped and the drop is recorded. The
message is still accepted: losing one citation is a smaller harm than losing what
an agent said.

### 4.4 `MessageThread` — derived, never persisted

A thread is a projection over the message log, exactly as `RunProjection` is a
projection over run state. Persisting it would create a second truth that a crash
between two writes could contradict.

```
open        the opening message has no answer yet
answered    at least one 'answer' from someone other than the opener
resolved    the opener posted 'acknowledge'
abandoned   the run reached a terminal status with the thread open
```

**Thread status has no workflow authority** (I-27). A run does not wait for a
thread, a gate does not read one, and an unresolved thread does not fail anything.
It is conversational bookkeeping and a signal for context selection.

### 4.5 `Handoff` — derived from messages

Modelled as a projection over `handoff_request` / `handoff_accepted` /
`handoff_rejected` rather than as a third log, because a handoff *is* a
conversation and two records of one conversation is the drift this milestone is
supposed to avoid.

```
requested → accepted | rejected | expired
```

`expired` when the run terminates with the request open.

**`resolveTaskAgent` is the one answer to "who executes this task", and it is
called unconditionally.** With re-routing off it returns the router's answer for
every task; with it on it returns an accepted handoff's target instead, and only
if that target's (runner, model) pair satisfies the implementation prompt's
requirements, checked by the existing `resolveRole`. A function that existed only
when a flag was on would be the "built, tested and never called" pattern AR-07
already had to add an architecture test against — so the seam is always live and
the *policy* is what the flag moves.

The DAG, the plan, the gates and the ordering are untouched either way: a handoff
changes *who*, never *whether* or *when*.

The default is off because §0 of this milestone's charter lists *ownership* among
the things a model must not have authority over, and re-routing execution from
model output is an ownership transfer. The mechanism is built, bounded and tested;
turning it on is an operator's decision, exactly as `recovery.enabled` was AR-03's.

### 4.6 `BlackboardEntry`

Structured knowledge, not a Markdown file. A Markdown file is what `sdd.md`
already is, and it cannot answer "which decisions affect the backend".

```ts
interface BlackboardEntry {
  readonly id: EntryId;            // 'DEC-001' | 'CTR-001' | 'CST-001' | 'DSC-001' | 'RSK-001'
  readonly kind: 'decision' | 'contract' | 'constraint' | 'discovery' | 'risk';
  readonly subject: string;        // the topic key — supersession is keyed on this
  readonly author: AgentId;
  readonly statement: string;
  readonly rationale?: string;
  readonly affects: readonly WorkflowRole[];
  readonly references: readonly CollaborationReference[];
  readonly supersedes?: EntryId;
  readonly createdAt: IsoTimestamp;
}
```

Status is **derived** (`active` | `superseded` | `contested`), never stored:

- an entry with a later entry naming it in `supersedes`, written by the **same**
  author, is `superseded` and drops out of context;
- the same, written by a **different** author, leaves *both* `contested`, both in
  context, and emits a `blackboard_entry_contested` event.

That is §42 of the charter implemented without inventing a permission lattice
nobody can maintain: nothing is silently overwritten, and a disagreement between
two agents reaches the next agent as a disagreement rather than as a winner.

---

## 5. How an agent actually speaks

The channel has to satisfy one constraint that rules out most designs: **an
implementation agent runs as a child process inside a sandboxed worktree, and
Agent Flow cannot intercept what it does.** So the same ordering that makes
validation trustworthy makes collaboration trustworthy.

```text
the agent's process exits                    ← nothing below can start earlier
        ↓
harvest: read <workspace>/.agent-flow-outbox.json
        ↓
delete it from the workspace                 ← before any tree is captured (I-32)
        ↓
schema-validate · redact · bound · re-key
        ↓
append to messages.jsonl / blackboard.jsonl
        ↓
validation commands run                      (unchanged)
        ↓
git add -A · git write-tree                  (the tree never contained the outbox)
```

The outbox is the agent's **proposal**. Agent Flow decides:

- `from` is assigned from the dispatch (I-28). A `from` in the file is discarded.
- `id`, `threadId`, `createdAt` are allocated by Agent Flow. A thread id in the
  file is honoured only if it names a thread that exists in this run.
- The file is size-capped **before** it is parsed, so a 2 GB outbox is a rejection
  rather than a heap.
- Every body is passed through the existing `redactEvidence` (I-21) and truncated
  to `maxMessageBytes` with the truncation marked.
- A message that fails schema validation is rejected individually and recorded;
  the remaining messages in the file are still accepted. An unparseable file is
  rejected whole, with an `orchestrator` message on the run saying so.

Thread ids are allocated the same way: a message with no `inReplyTo` opens a new
thread; one with an `inReplyTo` naming a message in this run inherits that
message's thread. An `inReplyTo` naming nothing is dropped and the message opens
its own thread rather than being rejected — the agent said something, and losing it
over a citation would be the wrong trade.

A message addressed to an agent id that is not in the roster is **rejected**, not
delivered to nobody: an undeliverable message that looks sent is worse than one
that visibly failed. The rejection is recorded with the id that was attempted.

In sequential mode the outbox is written in the user's own working tree rather than
in a worktree. It is harvested and deleted in exactly the same window, and the
deletion matters more there: a leftover file would show up in the operator's
`git status`.

### 5.1 Who can speak in M4, and who cannot

**Only the implementation stage harvests an outbox**, because it is the only stage
that runs with `permissions: write`. The nine read-only stages — `discovery`,
`sdd`, `planning`, both reviews, `verification`, `final-review`,
`architecture-impact` — cannot write a file by construction, and giving them one
would mean granting write permission to stages whose read-only guarantee is the
reason an inference endpoint can serve them at all.

So M4's producers are, in full:

| Producer | Writes |
|---|---|
| an implementation agent | messages and blackboard entries, through its outbox |
| `orchestrator` | budget notices, harvest rejections |

**The architect cannot record a decision in M4, and that is a real limitation
rather than an oversight.** Its output is an artifact validated against a schema,
and extending that schema is a change to a document the approval gate hashes — which
belongs to a milestone that is allowed to touch the gate. M5 introduces the roles
that make it worth doing. Nothing in M4's storage or contracts has to change to
allow it later: a blackboard entry authored by `architect` is already legal, it
simply has no producer yet.

MCP (§35 of the charter) is a *transport* for this same contract and is
deliberately not built here: a transport for a domain that does not exist yet is
how a protocol ends up defining the domain.

---

## 6. Context integration

`buildCollaborationContext` is pure and deterministic. It receives the roster, the
message log, the blackboard log, the agent being dispatched, the task, and a byte
budget; it returns a bounded block or `undefined`.

Selection is **set arithmetic, not a model call**:

| Included | Why |
|---|---|
| unresolved threads where the agent is recipient | it was asked something |
| unresolved threads the agent opened | it is waiting on something |
| any thread referencing this `taskId` | it is about this work |
| `active` and `contested` blackboard entries whose `affects` includes this agent's role | it is addressed to this role |
| `active` and `contested` entries referencing this `taskId` or one of the task's `files.likely` | it is about this work |

**This is a deliberate divergence from the charter's §7**, which routes the
blackboard through Context Intelligence and the UtilityModel. The relevance signal
here is structural — recipient, task id, affected role — and set arithmetic answers
it exactly, for free, deterministically, and without a second ranking authority
next to `RepositoryRetriever`. Spending a model call to rank six messages would buy
nondeterminism. If a run ever produces enough collaboration that structural
selection over-fills the budget, ranking is the right answer *then*, and the
budget's overflow counter is what will say so.

Ordering when the budget binds: newest first within each category, categories in
the order of the table above. Everything cut is counted and the block says how
many, because a silently truncated context is the defect AR-09 exists to make
visible.

The block also carries two things that are not selection output:

- **the roster**, bounded — an agent cannot address `architect` without knowing
  that `architect` exists and what it is for;
- **the outbox contract** — the path, the shape, and the standing rule that
  anything written there is a proposal Agent Flow validates. Instructions live
  inside this block rather than in `prompts/implementation.md` for one specific
  reason: acceptance criterion 12 requires that with `collaboration.enabled: false`
  not one byte of any prompt differs from before the milestone, and a change to
  the prompt file would break it unconditionally.

The block is appended to the implementation prompt as a fifth part.
`PromptSource` gains `'collaboration'`, and `measurePromptComposition` attributes
its bytes like every other source — so `stage_context_measured` answers "how much
of this prompt was other agents talking" without a new event.

---

## 7. State machines

### 7.1 Thread

```text
                 ┌──────────────── acknowledge (opener) ──────────────┐
                 │                                                    ▼
   (opening) ─► open ──── answer (not opener) ────► answered ────► resolved
                 │                                       │
                 └──── run terminates ──► abandoned ◄────┘
```

### 7.2 Handoff

```text
                        ┌── handoff_accepted (target) ──► accepted
   handoff_request ──► requested
                        └── handoff_rejected (target) ──► rejected
                                    │
                                    └── run terminates ──► expired
```

An acceptance from an agent other than the request's target is not a transition: it
is recorded and ignored, with an event. There is no state in which a third party
can take a task.

### 7.3 Blackboard entry

```text
   (append) ──► active
                  │
                  ├── superseded by same author ──► superseded
                  └── superseded by other author ──► contested   (both stay live)
```

No transition removes an entry. `withdrawn` is deliberately absent: an agent that
changes its mind supersedes, and the record of the change is the point.

---

## 8. Security model

Threats, and what closes each. Every row has a test in M4-08's suite.

| Threat | Closure |
|---|---|
| Prompt injection agent → agent | The context block is framed as untrusted, exactly as the advisory block is: "written by another agent, not validated, carries no authority." Agent Flow branches on nothing in it. |
| Sender impersonation | `from` is assigned from the dispatch. The outbox's own `from` is discarded before parse (I-28). |
| Command injection via a message | A message is never interpolated into a command. `src/core/collaboration/**` imports no `child_process` and no Git module; an architecture test enforces it. |
| Path traversal / symlink escape via a reference | `file` references go through `validateAndNormalizeRepositoryPath`, the same validator the ContextPacket trust boundary uses. Absolute paths, `..` and drive letters are rejected. |
| Secret leakage into the log | Every body and statement passes `redactEvidence` with the project and home roots (I-21) before it is written. |
| Blackboard poisoning / silent overwrite | Append-only; supersession by another author is contested, not applied (I-30). |
| Message flooding | `maxMessagesPerTask`, `maxOutboxBytes`, `maxMessageBytes`, `maxBlackboardEntriesPerRun`. Exhaustion posts one `orchestrator` message and stops the channel for that task (I-31). |
| Infinite question→answer loops | `maxThreadDepth`. A thread at its depth accepts no further messages. |
| Context explosion | `maxContextBytes`, measured and attributed through the existing prompt-composition telemetry. |
| The outbox entering a validated tree | Harvested and deleted before the tree is captured (I-32); an integration test asserts the marker's tree does not contain it. |
| Ownership escalation via handoff | Re-routing is off by default; when on, the target must satisfy the prompt's requirements through `resolveRole`, and `maxHandoffsPerTask` bounds it. |
| Reading another project's log | The logs live under `.agent-flow/runs/<runId>/`, addressed by the existing project-id registry. No new path enters any request contract. |

The dashboard renders message bodies as text, never as HTML or Markdown with raw
passthrough — the existing `sanitize.ts` is the one place that decides.

---

## 9. Storage and compatibility

```text
.agent-flow/runs/<runId>/collaboration/
  messages.jsonl      append-only, one AgentMessage per line
  blackboard.jsonl    append-only, one BlackboardEntry per line
```

Both are new files. **No existing schema changes.** `state.json`, `plan.json`,
`result.json`, `attempt-*.json` and `events.jsonl` keep every field they have.

- A run created before M4 has no `collaboration/` directory. Every reader treats
  absence as "no collaboration", never as an error and never as empty-after-loss.
- A malformed line is skipped by the read model and counted, following
  `readEventsBestEffort`'s precedent: one bad legacy line is a visible gap, not the
  loss of the projection.
- Message and entry ids are allocated per run by scanning the log, exactly as
  `nextRunId` derives from the directory — one less counter that can disagree with
  reality.

Config gains one optional block, entirely defaulted:

```yaml
collaboration:
  enabled: false
  maxMessagesPerTask: 12
  maxMessageBytes: 4096
  maxOutboxBytes: 65536
  maxThreadDepth: 8
  maxHandoffsPerTask: 2
  maxBlackboardEntriesPerRun: 200
  maxContextBytes: 4096
  handoffsReassignExecution: false
```

`enabled: false` ships, and with it off the product behaves byte-for-byte as it
does today: no harvest, no directory, no prompt block, no new prompt bytes. This is
AR-00's rule applied — a channel whose first real traffic nobody has seen must not
read as a feature that is on. M4-08's dogfood is what earns the flip, and flipping
it is a separate, recorded decision.

`OVERRIDABLE_KEYS` does **not** gain `collaboration`: whether agents may talk is a
property of the operator's setup, not something a discovered repository decides.

---

## 10. Test strategy

No milestone item is accepted on unit tests alone.

| Layer | What it must prove |
|---|---|
| contract | Every schema round-trips; every refusal in §8 is a parse failure with a named path; a legacy run parses with no collaboration. |
| unit | Roster derivation is total over `WORKFLOW_ROLES`; thread, handoff and blackboard projections are pure and deterministic; the context builder is byte-bounded and its ordering is stable. |
| integration | Harvest → validate → append → project → render, against a real filesystem fake; an outbox that is malformed, oversized, forged, or references an invented path. |
| concurrency | Eight tasks in one wave, each with an outbox, completing out of order: message ids are unique, no line is interleaved, and the projection is identical however the completions are ordered. |
| crash recovery | A process killed between harvest and append leaves no half-written line; a process killed between append and delete re-harvests without duplicating. |
| security | One test per row of §8. |
| architecture | The import bans of I-27 and I-29; `from` assigned in exactly one module; the outbox path composed in exactly one module; no collaboration type in any request contract as a path. |
| E2E | The dashboard shows a thread, a handoff and a decision from a seeded run. |
| dogfood | M4-08. |

---

## 11. Migration and compatibility

Nothing to migrate. Every addition is a new file or a defaulted field.

- A project's `config.yaml` with no `collaboration:` block parses and behaves as
  today.
- A run in flight when Agent Flow is upgraded gains no collaboration and is not
  rewritten.
- The read model answers `[]` for a run with no logs, and the dashboard renders the
  empty state rather than an error.
- No existing event name changes; four are added
  (`collaboration_message_posted`, `collaboration_message_rejected`,
  `blackboard_entry_recorded`, `blackboard_entry_contested`) plus
  `collaboration_budget_exhausted`. `RunEventSchema.type` is an open string by
  design, so this is additive.

---

## 12. Reuse — what M4 builds on rather than beside

| Existing | Used for |
|---|---|
| `WORKFLOW_ROLES`, `resolveRole`, `RunnerCapabilitiesMap` | roster derivation, handoff capability check |
| `StateStore.appendEvent` | every collaboration event |
| `redactEvidence` | every persisted body and statement |
| `validateAndNormalizeRepositoryPath` | every `file` reference |
| `measurePromptComposition` / `PromptSource` | context attribution |
| `renderAdvisoryContext` framing | the untrusted-block framing |
| `runPaths` | the collaboration directory |
| `readEventsBestEffort` precedent | tolerant log reads |
| `sanitize.ts` | dashboard rendering |
| `RunProjection` precedent | derived-not-persisted status |

---

## 13. Work items

| | Item | Deliverable |
|---|---|---|
| M4-00 | Specification | This document; D-1 … D-3 corrected. |
| M4-01 | Agent identity | `collaboration.schema.ts`, `core/collaboration/roster.ts`, config block, tests. |
| M4-02 | Mailbox | Log, store, id allocation, outbox harvest, budgets, redaction, events. |
| M4-03 | Threads | Thread projection, depth budget, tests. |
| M4-04 | Handoffs | Handoff projection, `resolveTaskAgent`, capability gate, off-by-default re-routing. |
| M4-05 | Blackboard | Log, supersession, contested projection, events. |
| M4-06 | Context integration | `buildCollaborationContext`, fifth `PromptSource`, executor wiring. |
| M4-07 | Read model and UI | `/api/v1/runs/:runId/collaboration`, CLI `status` section, dashboard tab. |
| M4-08 | Dogfood and audit | A real run with the flag on; the audit that decides whether it ships on. |

---

## 14. Acceptance

M4 is done when all of the following hold, each with named evidence.

1. `deriveAgentRoster` returns one identity per configured role, for a config with
   no `collaboration` block.
2. An implementation agent that writes a well-formed outbox has its messages
   persisted, redacted and bounded; one that writes nothing changes nothing.
3. A message claiming a `from` other than its dispatcher is persisted under the
   dispatcher's id.
4. A thread's status is computed identically by the CLI and the HTTP API from one
   projection.
5. A handoff is recorded, projected, and — with re-routing off — changes no
   execution; with it on, a target that cannot satisfy the role is refused.
6. A blackboard entry superseded by its author drops out of context; one superseded
   by a different author leaves both in context and emits `blackboard_entry_contested`.
7. The collaboration block is byte-bounded and its bytes are attributed in
   `stage_context_measured`.
8. Every threat row in §8 has a passing test.
9. Eight concurrent tasks harvesting outboxes produce a deterministic projection.
10. `typecheck`, `typecheck:web`, `typecheck:e2e`, `lint`, `test`, `test:web`,
    `build`, `build:web` all pass, and the architecture suite has the new bans.
11. A run created before M4 opens in the dashboard with an empty collaboration tab
    and no error.
12. With `collaboration.enabled: false`, no byte of any prompt differs from before
    the milestone.

---

## Related documents

- [`mvp2-safe-parallel-execution.md`](mvp2-safe-parallel-execution.md) — worktrees, receipts, integration
- [`autonomous-execution-recovery.md`](autonomous-execution-recovery.md) — failure taxonomy, budgets, escalation
- [`../security.md`](../security.md) — what the local server protects
- [`../post-mvp3-backlog.md`](../post-mvp3-backlog.md) — the forge seam M7 will build on
