# Roadmap

What is done, what is being built now, and what is deliberately not being built.

The normative source for MVP 2 is
[`specs/mvp2-safe-parallel-execution.md`](specs/mvp2-safe-parallel-execution.md).
Where this page and that document disagree, the specification wins — and where the
specification and the code disagree, **the code is the current truth**.

```text
MVP 1  ─────────────────────────────────►  the execution foundation, complete
MVP 2  ─────────────────────────────────►  safe parallel execution, complete
MVP 3  ─────────────────────────────────►  context intelligence & advisory local model, complete
AR     ─────────────────────────────────►  autonomous execution & recovery, in progress
M4     ─────────────────────────────────►  collaboration foundation, dogfooded live — and still off
M5     ─────────────────────────────────►  team orchestration, dogfooded live
M6     ─────────────────────────────────►  collaborative review & quality gates, dogfooded live
M7     ─────────────────────────────────►  forge & remote delivery, dogfooded against real GitHub
                                        ▲
                                        you are here: M7 built and proved live; M8 next
```

---

## MVP 1 — the execution foundation · complete

Specified in [`specs/implementation-spec-v3.md`](specs/implementation-spec-v3.md),
kept as a historical record. It established everything the current product runs on:

- the logical role model, the deterministic router and the reasoning abstraction
- the planning pipeline: discovery → architecture impact → SDD → plan → plan review
- the approval gate, bound to one exact plan hash
- the DAG, the scheduler, the task executor, resume and retry
- validation commands run by the orchestrator, never by an agent
- final review and Definition of Done evaluated as code
- the local Web Control Plane, and write actions as use cases both adapters share
- the inter-process run execution lock

Two things were designed under MVP 1 and deliberately **not** built. Both are still
unbuilt, and both have their own document:

- [`config-write-design.md`](config-write-design.md) — `PATCH /config`
- [`pause-resume-cancel-design.md`](pause-resume-cancel-design.md) — `pause` / `resume` / `cancel`

---

## MVP 2 — Safe Parallel Execution · complete

Specified in [`specs/mvp2-safe-parallel-execution.md`](specs/mvp2-safe-parallel-execution.md).
Delivered Git worktree isolation, receipt-first marker verification, deterministic integration,
crash recovery, and parallel scheduler activation across M2-00 through M2-12.

---

## MVP 3 — Context Intelligence & Advisory Local Model · complete

Specified in [`specs/implementation-spec-v4-draft.md`](specs/implementation-spec-v4-draft.md).
Introduces an optional, provider-neutral, strictly advisory local UtilityModel layer that reduces
context bloat and accelerates stage execution while preserving all security invariants.

| | Milestone | Status |
|---|---|---|
| M3-00 | Architecture and probes | **done** |
| M3-01 | UtilityModel port | **done** |
| M3-02 | OpenAI-compatible adapter | **done** |
| M3-03 | ContextPacket | **done** |
| M3-04 | Repository retrieval | **done** |
| M3-05 | Hierarchical compression | **done** |
| M3-06 | Log and diff triage | **done** |
| M3-07 | Context telemetry | **done** |
| M3-08 | Primary-runner context integration | **done** |
| M3-09 | Dogfood and benchmark | **done** |

### Core Invariants Guaranteed by MVP 3

- **Zero Workflow Authority**: The UtilityModel is strictly advisory. It cannot sign gates, create markers, modify DAGs, alter verdicts, or execute commands.
- **Fail-Open Advisory Degradation**: An offline, unconfigured, failing, or timed-out utility model degrades cleanly to an empty advisory context; stage execution continues unaffected.
- **Deterministic Candidate Discovery**: The repository file universe is discovered via canonical Git/filesystem methods; model-invented paths are rejected by strict trust boundaries.
- **Symlink & Inode Security**: The secure content reader rejects all symlinks, checks exact file bounds, and snapshots file handles against TOCTOU manipulation.
- **Credential Containment**: Configuration stores only the environment variable name (`apiKeyEnv`), never secrets. Telemetry, logs, and artifacts are strictly sanitized.

---

## Autonomous Execution & Recovery · in progress

Specified in [`specs/autonomous-execution-recovery.md`](specs/autonomous-execution-recovery.md).
Every milestone through `AR-05b` has landed — the whole mechanical path from a failure
being *knowable* to a run correcting itself. `recovery.enabled` ships **true**: a
recoverable failure requeues itself with a Failure Context Packet, and a corrective round
whose every task falls inside the approved envelope executes without reopening the gate.

`AR-07`'s mechanical half has landed too: `run` refuses before it takes the execution
lease when nothing is runnable, through the same pure projection every surface reads. The
evidence run took and released that lease three times with nothing to do.

`AR-09` measures what every stage's prompt is made of, by source, and warns when a task
the planner called *trivial* receives more context than the repository's own standing
rules. A one-`grep` call in the evidence environment reported ≈49 k input tokens before
Agent Flow contributed anything of its own; recovery now adds a bounded packet to a number
somebody can finally attribute.

`AR-10`'s scenario list from §10.1 runs as a suite against scripted runners: every seeded
failure is one the evidence run actually hit, and every assertion is a row of §10.2. What
that suite cannot produce is §10.3's wall-clock and model-time numbers — those need a live
run against real runners, which is an exercise with a real cost and the owner's to spend.

`AR-07`'s read model reached both surfaces earlier than its rendering did, and that gap
was this milestone's own instance of the pattern a new architecture test now guards
against elsewhere — a module built, tested and never called: `projectRun` was computed
on `RunDetailView` and projected by the CLI, so C-19 … C-22 had one answer rather than
four derivations — but neither surface's headline, its
progress bar, its Resume button or its DAG toggle *read* that answer. `state.status`
stayed the CLI's headline through a whole revision and `run.status` stayed the
dashboard's; `completedTasks / taskCount` stayed the progress bar and reached 100% with
verification still pending, exactly as it had in the evidence run. Both now read
`runtime.status` and `runtime.progress.workflow` — the stage-based axis, monotonic by
construction — for the headline and the bar; `runtime.resumable` gates Resume and
`taskCount > 0` gates the DAG toggle. Progress is shown as that one axis rather than as
three separate bars, and no test yet pins CLI and dashboard text to the same projected
value across a shared fixture — both are still open, not silently closed.

`AR-08`'s CLI half was done first — `revise` reads a file, stdin or `$EDITOR`, and
`status` renders the full C-22 escalation — and the dashboard now renders the same two
things the CLI already did: the escalation banner, and `TaskDetailView.attemptHistory`
with each attempt's failure class and its own log, in a new Attempts tab. The artifact
copy action shipped earlier still and was never actually missing; the milestone's own
table just said so after the fact.

Driven by the first substantial human dogfood, `AF-2026-002`, which delivered 71 lines in
244 minutes with 16 manual operations — 11 of them after approval, none of them decisions.
The finding that ordered the milestone: three of six tasks produced a Git tree identical to
their base and were still recorded `completed` and integrated, so the run's final FAIL was
caused by false-positive acceptance rather than by anything the corrective path could fix.

The milestone moves the human from *recovery mechanism* to *decision maker*: everything
mechanically decidable — an uninitialised project, a (runner, model) effort mismatch, an
absent `node_modules`, a denied command hidden in discarded stderr, two corrective tasks
writing to one file, a task that changed nothing — is decided by code, bounded by explicit
budgets, and escalated with a specific action when a budget is exhausted.

| | Milestone | Status |
|---|---|---|
| AR-00 | Contracts, vocabulary and probes | **done** |
| AR-01 | Readiness preflight | **done** |
| AR-02 | Failure intelligence and evidence | **done** |
| AR-05a | Acceptance integrity | **done** |
| AR-06 | DAG and conflict safety | **done** |
| AR-03 | Autonomous retry and Failure Context Packet | **done** |
| AR-04 | Verification environment readiness | **done** |
| AR-05b | Autonomous corrective loop | **done** |
| AR-07 | Runtime state projection and human gates | mostly done — headline, progress, Resume and DAG-toggle gating on both surfaces read `runtime`; progress is one axis rather than three, no cross-surface pin yet |
| AR-08 | Recovery UX and CLI ergonomics | **done** — escalation, attempt history and failure class now render on the dashboard, matching the CLI |
| AR-09 | Cost and context controls | **done** |
| AR-10 | Dogfood and autonomy benchmark | harness done — live run is the owner's |

Ordered by dependency rather than by number: `AR-05a` precedes the corrective loop because
correcting damage the system is still creating would be building the loop backwards, and
`AR-06` precedes `AR-05b` because the corrective generator itself emitted the conflicting
plan that the evidence run had to reject.

### What AR-00 landed, and what it deliberately did not

Contracts and pure primitives, with **no behaviour change**: the failure taxonomy
(`FailureClass`, refining `RunnerErrorCode` rather than replacing it), the recovery budgets,
`capabilities(model?)` and `nonInteractiveToolGrants`, the two new artifact schemas, the
three-valued mechanical verdict, and four pure modules — evidence redaction, failure
classification, recovery policy and the runtime projection. `recovery.enabled` ships `false`,
because a budget nothing enforces must not read as a feature that is on.

**No behaviour changed.** `capabilities(model?)` and the resolver-shaped capability map
landed, and every shipped adapter still answered the same thing for every model — so
resolution was byte-identical to before. The measured per-model narrowing that makes the
existing clamp fire is documented in [`runner-capabilities.md`](runner-capabilities.md) and
was **AR-01's** to encode; it is encoded now.

Two divergences are worth recording, both now corrected in the specification itself:

- **`scope` was already taken.** AR §8.3 wanted that name for the file-containment mode,
  and every task in the AF-2026-002 plan carries `scope: "backend" | "docs" | "infra"` as a
  free-form module label. Redefining it as a two-value enum would have made one of the
  fixtures the compatibility gate depends on fail to parse, so the containment mode is
  **`scopeMode`** with the spec's values verbatim.
- **The `attempt` → `repair` rename is complete in `StageRunner` and partial above it.**
  Its events and logs now say `repairs`, and both readers accept either spelling so an
  existing run keeps its numbers. `TelemetryEntry.attempts` and `StageViewResponse.attempts`
  still carry the repair count for stages under the older name; renaming those is a
  read-model change and belongs to AR-07.

### What AR-01 landed

The first milestone that changes behaviour, and the change is stated plainly because it is
a migration: **a previously-fatal configuration now clamps.**

- **An uninitialised project is refused before a run exists.** `checkPlanningPreflight` now
  asks whether `.agent-flow/config.yaml` exists, in **every** isolation mode — it used to
  return satisfied immediately when `git.useWorktrees` was off, so a sequential run got no
  preflight at all. Zero runner invocations, zero runs, HEAD unchanged, exit `CONFIG_ERROR`,
  and one sentence naming the absent path and `agent-flow init` (C-01).
- **The effort a (runner, model) pair does not offer is clamped, loudly.** The AGY adapter
  encodes its measured per-model table; `medium` against a model offering `low` and `high`
  resolves to `low`, records a `reasoning_clamped` degradation naming requested, effective,
  supported set, runner and model, publishes the same facts on `stage_started` structurally,
  and the run proceeds. No runner is invoked at the unsupported level (I-20) and no task
  attempt is spent finding out (I-22, C-03).
- **`doctor` reports the pair mechanically, for free.** A new capability section compares
  what each role asks for with what its pair declares, and warns `permission_not_ready` when
  a write role's runner does not grant a tool class it needs (C-04). `--deep` stays opt-in
  and now exercises **every configured effort** plus a read-only tool-use probe — the old
  probe used the cheapest supported level and would never have exercised the `medium` that
  broke. Nothing here edits configuration or escalates a permission; repairing a gap is a
  later milestone's.
- **`init` refuses during an active run.** It names the run and its `planningBase`, writes
  nothing, and exits `GATE_NOT_SATISFIED`; `--force` proceeds and records
  `init_during_active_run` on the run (C-02).

**No persisted schema changed.** The degradation kind and the event name both already
existed from AR-00, and the structured clamp evidence rides on `RunEvent.detail`, which §8
keeps an open record precisely so evidence can be enriched without a migration.

**The model id is never reconciled with the effective effort.** One vendor's ids encode an
effort — `gemini-3.1-pro-high` — while the clamp may land on `low`. The adapter forwards
both verbatim; the core treats the model as the opaque string AD-13 requires. An
architecture test forbids any layer above `src/adapters/` from taking a model string apart,
and confines the per-model table to `src/adapters/runners/`.

### Core invariants added by this milestone

- **I-20 — No unsupported effort is ever invoked**: an effort the resolved (runner, model) pair does not declare is clamped deterministically and recorded, never sent to a runner.
- **I-21 — No unredacted evidence is persisted**: raw runner output reaches disk, events and HTTP only through a single redaction contract.
- **I-22 — Preflight failures cost no attempt**: a failure knowable before invocation never increments the work-attempt counter.
- **I-23 — No completion without observable change**: a validated tree identical to its base cannot complete unless the plan declared it would.
- **I-24 — No verdict is rendered under a borrowed label**: mechanical verification, semantic review and the Definition of Done are distinct, and `NOT_RUN` is never shown as `PASS`.
- **I-25 — Bounded corrective autonomy**: a corrective round proceeds without human approval only when every task is inside a mechanically-decided envelope and the budget holds.
- **I-26 — Runtime status is projected, never persisted**: the CLI and the HTTP API derive status from one pure projection.

---

---

## M5 — Team Orchestration · complete, and dogfooded live

Specified in [`specs/m5-team-orchestration.md`](specs/m5-team-orchestration.md); the live
run is [`specs/m5-live-dogfood-report.md`](specs/m5-live-dogfood-report.md).

The milestone that answers **"who should execute TASK-X, and why"** deterministically. A
team has members; a member has roles, skills, a capacity and areas it owns; a task's
requirements are derived from the plan the planner already wrote. Every candidate is
ranked, every exclusion is named, and the whole ranking is in the audit log — because
"the AI decided" is not an answer.

**No second router and no second scheduler.** `resolveTaskAgent` kept its position in the
call graph and got a new body; `core/router.ts` survives as the input its answer is scored
against. The scheduler stays the only authority on when a task runs and how wide a wave
may be, and M5 hands it two more reasons to hold a task back.

**A model still decides nothing.** A handoff became a *request* the policy may admit and
may refuse — an accepted one still passes every filter the ordinary path applies. An
outbox has no field in which to claim an area, a capacity or an assignee, so the claim is
discarded by the parse rather than by a check somebody has to remember.

| | Item | |
|---|---|---|
| M5-00 | Specification, criticised against the M4 dogfood | **done** |
| M5-01 | Team and member contracts; roster from both sources | **done** |
| M5-02 | Skills: normalisation, matching, the score's term | **done** |
| M5-03 | `TaskRequirements` derivation | **done** |
| M5-04 | Filtering, scoring, tie-break; `resolveTaskAgent` re-bodied | **done** |
| M5-05 | Ownership: config, matcher, score, exclusive constraint | **done** |
| M5-06 | Capacity: the wave's fourth filter and its event | **done** |
| M5-07 | Handoff admission through the policy | **done** |
| M5-08 | Assignment log, read model, CLI, dashboard | **done** |
| M5-09 | Acceptance, concurrency, crash and threat suites; dogfood | **done** — [report](specs/m5-live-dogfood-report.md) |

### What the dogfood cost and bought

Six defects, five of them invisible to a green suite and two invisible from outside the
product entirely — the task ran, so nothing failed. One was **the M4 deadlock returning
through a seam M5 added**: an implementation prompt going out with no mention of the
coordination channel, on the one path that needs a team, a task nobody can take, and a
fallback role a member staffs.

The channel now costs **772 bytes a task** for availability against M4's 1 373
unconditional, and nothing more unless something relevant exists. Across nine live tasks,
nothing was relevant and no agent spoke — the same answer M4 got, at 44 % of the price.

`collaboration.enabled` stays `false` by default. Two milestones have now asked nine and
five agents whether they had anything to say, and one of fourteen did.

---

## M4 — Collaboration Foundation · complete, and shipped off

Specified in [`specs/m4-collaboration-foundation.md`](specs/m4-collaboration-foundation.md).

The milestone that gives a run **agents** rather than only roles: a persistent identity,
a durable channel between them, and a structured place to put a decision so the next
agent finds it. Nothing more — teams, skills-based assignment, resource ownership, the
review protocol and the forge are M5 … M7, and the specification says where each door is
left open.

The three things that make it safe are the three the product already had, applied to a
new kind of input:

- **An agent's message is a proposal, never an instruction.** It is harvested after the
  process exits, schema-validated, redacted, bounded and re-keyed — the same ordering
  that makes a validation receipt trustworthy (I-27 … I-29).
- **Nothing is silently overwritten.** The blackboard is append-only; a supersession by
  a different author leaves both entries live and *contested*, and both reach the next
  agent (I-30).
- **Everything is bounded.** Messages per task, bytes per message, thread depth,
  handoffs per task, and the byte budget of the block that reaches a prompt — measured
  through AR-09's existing per-source attribution rather than a second counter (I-31).

`collaboration.enabled` ships **false**, and with it off not one byte of any prompt
differs from before the milestone. That is AR-00's rule applied: a channel whose first
real traffic nobody has seen must not read as a feature that is on. M4-08's dogfood is
what earns the flip.

| | Milestone | Status |
|---|---|---|
| M4-00 | Specification, and the three false documentation claims it found | **done** |
| M4-01 | Agent identity | **done** |
| M4-02 | Mailbox, outbox harvest and budgets | **done** |
| M4-03 | Threads | **done** |
| M4-04 | Handoffs | **done** |
| M4-05 | Shared blackboard | **done** |
| M4-06 | Context integration | **done** |
| M4-07 | Read model, CLI and dashboard | **done** |
| M4-08 | Acceptance suite and documentation | **done** |
| M4-09 | Live dogfood, `AF-2026-002` | **done** — [report](m4-live-dogfood-report.md); `enabled` stays `false` |

### What M4-08 could prove, and what it could not

The acceptance suite drives the **real** `TaskExecutor` against scripted runners, because
the two claims that matter most are claims about where the calls sit rather than about
what a function returns: the harvest happens between the agent exiting and the tree being
captured, and the block reaches the prompt the runner actually receives. Fourteen tests,
one per row of §14.

The criterion worth naming is the twelfth. **With `collaboration.enabled: false`, the
prompt a runner receives is byte-identical to the pre-M4 one** — proved by running the same
task twice, once with the feature off and a full outbox sitting in the workspace, once with
the block absent from configuration entirely, and comparing the two strings. Not by reading
the code.

What it cannot produce is a live run. A dogfood against real runners costs real model calls
and is the owner's to spend — the same line AR-10 drew, for the same reason — and it is
what would earn the flip to `enabled: true`.

### What the milestone found on its way through

Six defects, all in M4's own code, and every one of them caught by a gate rather than by
review:

- **The architecture rules caught three.** `CollaborationService` imported `StateStore`,
  which can write task states — the prose said it never would and the import said it could.
  `nextMessageId` was exported, tested and called by nothing. `admitHandoff` was written a
  milestone before it had a caller.
- **The screenshots caught three more, all with green component tests.** The panel rendered
  every message of every thread into a 288-pixel box and cut the second thread and the
  whole blackboard off below the fold. The contested notice listed ids the reader could not
  act on while the list below repeated both entries with their text. And the empty state
  rendered "nothing said" over a list of handoffs.

There is also a red gate the M4-00 audit missed and this milestone is reporting rather than
absorbing: **`npm run test:visual` fails on `master`**, proved in a clean worktree at
`741941c` — four failures, the same DOM assertions that fail with M4 applied
(`nothing clips a value it has room for` at 1024, and `the inspector is a pane above 1200`
at three widths). Not M4's to fix, and not M4's to hide.

### What M4-00 corrected on its way past

Three documentation claims that were false at the moment the audit read them. Recorded
here rather than fixed silently, because each one had been true once and stopped being
so without anything noticing:

- **`git.useWorktrees` was documented as inert.** Its schema comment said "read by
  nothing that executes anything: no execution path creates a worktree" — true when
  written, false since M2-04 built `TaskWorkspaces`. What is still true is the
  containment, and the comment now says that instead.
- **`recovery.enabled` was documented as shipping `false`** in `scheduler.ts` and
  `execution-context.ts`. It has shipped `true` since AR-03; the schema and the config
  template both said so, and two comments did not.
- **Both READMEs listed OpenCode as a runner you can use.** No `opencode` adapter has
  ever existed. The four that do — `claude-code-cli`, `codex-cli`, `agy-cli`,
  `openai-compatible` — are now all in the table, which listed two.

---

## M5 — Team Orchestration · built and dogfooded live

Specified in [`specs/m5-team-orchestration.md`](specs/m5-team-orchestration.md).

M4 answered *who the agents are*, *what they said* and *what they know*. M5 answers
*which agents form a team*, *what each can do*, *who should receive a task*, *who owns
what* and *which work may happen at once*.

The structural decision the specification rests on: **`resolveTaskAgent` already exists
and is already called on every task.** M4 built that seam deliberately, so M5 replaced
its body and kept its position — there is no second router and no second scheduler, and
`core/router.ts` survives as both the fallback path and a *term* in the new score, so a
high-risk task still gravitates to `executor.complex` even when a trivial executor has
the skills.

One M5 defect outlived the milestone and was found by M6's live run: a member declared
`runner:`, the capability check and the independence calculation honoured it, and the
*dispatch* resolved the role instead — so the runner a member ran on was whatever
`roles:` said. Fixed in M6, because M6's own independence figures depended on it.

## M6 — Collaborative Review & Quality Gates · built and dogfooded live

Specified in
[`specs/m6-collaborative-review-quality.md`](specs/m6-collaborative-review-quality.md),
with the live evidence in
[`specs/m6-live-dogfood-report.md`](specs/m6-live-dogfood-report.md).

M5 answered *who does the work*. M6 answers *who checks it*, *what exactly they found*,
*how the implementer responds*, *who verifies the correction*, *what evidence proves
quality*, and *when the workflow may continue*.

Half of it already existed — structured findings, corrective task generation, the
separation of semantic review from mechanical validation, `NOT_RUN` as a third value, a
Definition of Done evaluated as code, validation commands that only a human can author —
so the milestone is mostly an argument about ten precise gaps rather than a new domain.

Its most useful outcome was not planned. **A mechanism can be written, reviewed, covered
by tests, and unreachable by any real agent.** Three defects were exactly that shape: a
function nothing called, an event nothing emitted, and a key the emitter and the reader
disagreed about — so a finding raised by a live reviewer could never become work, and no
finding in a real run could ever leave `open`. Two architecture rules now ask that
question mechanically, one for exported functions and one for declared events.

---

## M7 — Forge & Remote Delivery · built and dogfooded against real GitHub

Specified in
[`specs/m7-forge-github-delivery.md`](specs/m7-forge-github-delivery.md).

M6 ended with a run that can prove which commit is approved. M7 publishes exactly that
commit, creates exactly one remote artifact for it, and observes the remote **without
handing it any authority**.

```text
models propose · Agent Flow decides locally · Forge publishes and observes
```

Three seams, and the point is that they are three: `GitClient` reads local Git,
`RemoteGitPublisher` puts one exact commit on one exact ref, `ForgeProvider` talks to an
API. Creating a pull request needs the commit to exist remotely, and that does not make
pushing a Forge operation — a provider that could run Git could rewrite history to make
its own call succeed.

Everything is off by default and every write is separately opt-in. Choosing GitHub names a
destination; it is not consent to write to it.

**What GitHub decides: nothing.** A `ForgeCheck` shares no field with a `QualityGateResult`,
a red check cannot move `run.status`, and a forge failure cannot un-complete a completed
run. Fifteen architecture rules hold those boundaries.

The dogfood ran against this repository: issue #18, branch `agent-flow/AF-2026-004`
carrying the exact approved commit, pull request #19, and ten real checks read from that
commit. Rerunning every operation produced no second object.

Its most useful outcome, again, was not planned. **Two defects were found by the real CI
that no local gate would have caught** — a dashboard panel that logged an error on every
render because its endpoint was unstubbed in the visual harness, and a packaging smoke that
had been asserting eleven prompts since M6 added a twelfth. The second had been red in CI
for a whole milestone, invisible because `test:packaging` is not in the canonical gate list.

## M8 — Control Plane & Operational Kanban · built, and dogfooded live

Four milestones each added a set of authoritative facts and a panel to render them. The
dashboard became eight correct panels, and an operator still could not answer the four
questions that decide what they do next: what is happening, what needs me, what is blocked,
what is delivered.

M8 adds **no workflow authority**. It projects facts the system already decided into an
*order* and a *lane*, and puts the most actionable one first.

```text
attention    projected, never stored — no dismiss; an item leaves when its fact does
lanes        six, projected from task state, the DAG and the run — no `task.column`
reasons      the join nobody had made: the DAG knew, the deferral knew, the card did not
snapshot     one read, one instant, so the board and the queue cannot describe two moments
```

The board carries no drag, and that is the design rather than a gap: dragging BLOCKED →
DONE would be the browser writing state, and no domain action means "move this task to that
column". An architecture rule asserts no drag handler exists, which is also what makes the
board keyboard-operable by construction.

**Two evidence gaps were closed in a second pass, and both of them found something.**

390px was in the spec and had never been photographed — because the dashboard had no
mobile layout at all: a fixed 240px sidebar took 62% of the screen. It is a drawer below
1024 now, three rows that never wrapped do, and the new page-overflow assertion caught 187
pixels produced by the drawer's own geometry. A menu button that rendered at *every* width,
because a one-class rule ties with Tailwind's `.flex`, was caught by six existing baselines
at 1280 and 1200 — ten pixels of command bar shifting every page in the app.

`AF-2026-006` was approved and started from the screen. Three tasks proved
READY → IN PROGRESS → DONE naturally, a fourth reached REVIEW, the board moved with the
page loaded once and never reloaded, and the stage-lag fix behaved correctly live. The run
did not reach DONE: its last task was "run the full verification ladder", whose success
looks identical to doing nothing, and the plan did not declare `expectsNoChange: true` — so
`assertObservableChange` refused it, which is exactly what C-12 built it for. **The gap is
in what the planner emits, not in what the operator sees.**

**Phase A came first, and it was not about the UI at all.** M7 closed with `test:packaging`
red for a whole milestone — CI ran it, CI blocked on it, and no local command asked. The
gap turned out to be bidirectional: `typecheck:web` and `typecheck:e2e` were in the local
`check` and in no CI job. `scripts/gates.mjs` is now the only list, CI invokes
`npm run gate:<lane>` and holds none of its own, and `test/gates.test.ts` proves the drift
rules fire by mutation rather than assuming they would.

Two defects the work found in its own code, both within an hour of writing it:

- the board asked `core/dag` for readiness, which the server is forbidden to import — and
  which turned out to be redundant, because `effectiveTaskStates` already resolves `ready`
  for every reader;
- a single failed task put a P1 `agent_blocked` on everything downstream of it, because
  `blocked` is two things — a record the executor wrote and a condition the graph derives —
  and only the first carries a reason.

## What the live dogfood changed about M4

Recorded here because it is the milestone's most useful outcome and it was not planned.

**M4 shipped a channel that could never carry its first message.** A fresh run's log is
empty, so no block reached the prompt, so the agent never learned the outbox existed, so
it wrote none, so the log stayed empty — for every agent, on every run. 366 tests passed,
because every one of them either seeded the log first or called the harvest directly, and
one of them asserted the deadlock as though it were the contract.

Fixed, and then the run produced the traffic: a Codex agent on a blocked task wrote a
`blocker` to the architect and a `risk` to the blackboard, both technically correct and
both about work another agent had done.

The finding no acceptance criterion asks about: **five agents received the invitation and
only the blocked one used it.** That is not a defect — a task with a complete SDD and a
reviewed plan has nothing to ask — but it means the channel's value is concentrated
exactly where the plan failed, and a default of `true` would put 1 373 bytes on every
prompt to buy a message that arrives only when something has already gone wrong.
`collaboration.enabled` stays `false` until a second dogfood reaches an answer and an
acknowledgement.

---

## Beyond this milestone

See [`docs/post-mvp3-backlog.md`](post-mvp3-backlog.md) for non-normative enhancement ideas and future backlog items.
