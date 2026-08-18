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
                                        ▲
                                        you are here: MVP3 corrective audit closure complete
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

What remains is what a person *reads*: the rest of `AR-07`'s read model and the recovery
UX (`AR-08`).

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
| AR-07 | Runtime state projection and human gates | partial — C-19 landed |
| AR-08 | Recovery UX and CLI ergonomics | design |
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

## Beyond this milestone

See [`docs/post-mvp3-backlog.md`](post-mvp3-backlog.md) for non-normative enhancement ideas and future backlog items.
