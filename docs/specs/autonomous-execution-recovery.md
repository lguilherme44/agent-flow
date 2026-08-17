# Autonomous Execution & Recovery

## 0. Status and scope

**Status: design. Nothing in this document has been implemented.**

This is the normative specification for the milestone that follows MVP 3. It is the
authority for Autonomous Execution & Recovery in the same way
[`mvp2-safe-parallel-execution.md`](mvp2-safe-parallel-execution.md) is the authority
for Safe Parallel Execution: where this document and a higher-level strategy document
disagree, this one wins until it is deliberately amended.

**What this milestone is not.** It does not reopen MVP 3, does not relax any Git
safety rule, does not remove worktree isolation, does not remove human approval, and
does not move a single authoritative decision from mechanical evidence to a model. It
adds no provider-specific architecture: AGY appears in this document only as the
runner that produced the evidence, never as a dependency of the core.

**The problem this milestone solves is not missing safety.** Safety exists and held
throughout the evidence run: no destructive Git operation, no force-push, no shell
command originating in model output, no attempt integrated without a validated tree
and a receipt. The problem is that **autonomous recovery is insufficient**, so the
operator is currently the recovery mechanism.

### 0.1 The evidence

Every claim in §1 is derived from `.agent-flow/runs/AF-2026-002/` and from the Git
objects that run produced, both inspected directly. The run's goal was to add
`agent-flow bug "<description>"` as a first-class verb delegating to the existing
`feature` workflow — 18 lines of production code.

| Measure | Value |
| --- | --- |
| Wall clock | 13:34:15Z → 17:38:44Z — **244 min** |
| Model time (21 stage calls) | **56 min (23%)** |
| Remaining time | **188 min (77%)** — operator investigating, deciding, waiting |
| Manual operations | **16** (7 `run`, 3 `retry`, 2 `revise`, 2 `review`, 1 `approve`, 1 `reject`) |
| Manual operations *after* approval | **11**, of which **0 were decisions** |
| Delivered | 71 lines across 5 files |
| Verdict | final review FAIL · Definition of Done **NOT DONE** |

The 77% is the target of this milestone. The 23% is not.

### 0.2 Three defects found in the evidence that no summary had recorded

These were found by comparing Git trees, not by reading logs, and they change the
priority order of the whole milestone.

**D-1 — Half the tasks delivered nothing and the system accepted it.**

```
TASK-001 a1   marker 83712ea  base 4387a74   1 file   changed
TASK-002 a2   marker f99723d  base c011c67   0 files  IDENTICAL TREE
TASK-003 a3   marker 8463fd9  base 4f2025f   5 files  changed
TASK-004 a1   marker c5b4ea8  base 49b827b   2 files  changed
TASK-005 a1   marker 8fff922  base 49b827b   0 files  IDENTICAL TREE
TASK-006 a1   marker aebd1b7  base fede07d   0 files  IDENTICAL TREE
```

TASK-002, TASK-005 and TASK-006 produced a tree byte-identical to their base. All
three were recorded `judgement: satisfied`, `status: completed`, and were integrated
with a merge commit. `attempt-<n>.json` **already persists both hashes** —
`receipt.validatedTree` and the workspace `base` — so the detection is a string
comparison nobody performs.

**D-2 — `validationExpectation: 'fail'` is satisfiable by doing nothing.**
`core/validation-outcome.ts:42-50` returns `completed` whenever a RED task's
validation does not pass. TASK-002 was to add the dispatch, exit-code,
missing-argument and `--dry-run` tests. It wrote zero bytes. The suite stayed red
*because TASK-001 had made it red*. `judgeValidation` receives only
`{ passed, ran }`: it cannot see the diff, the acceptance criteria, or
`filesChanged`.

**D-3 — One task wrote outside its declared scope and emptied three downstream
tasks.** TASK-003 declared `files.likely = ['src/cli/index.ts']` and wrote five
files, including the `README`s and `scripts/packaging-smoke.mjs` — the files owned by
TASK-004 and TASK-005. Nothing checked. TASK-004's own notes admit it: *"The `bug`
rows were already present from a previous change"*. TASK-005 then had nothing to do,
validated with `npm run build` instead of the `test:packaging` its acceptance
criterion named, and passed.

**These three compose into the run's actual failure.** The final review rejected the
run for the absence of exactly the work TASK-002 and TASK-005 had been credited with.
False-positive acceptance was not a defect *beside* the FAIL — it was its cause.

**D-2 and the FIX-task collision were both already known.** Two rules were established
and written down during MVP 2's dogfood, and neither is enforced by code:

> *A wave may contain at most **one** unpaired RED task per validation command.* A task
> is judged by running the whole suite in its own worktree, so it inherits every red test
> from its base — including one a sibling wrote deliberately. The upstream fix is to put a
> module's tests and its implementation in the **same** task.

> *Two tasks that edit the same file never integrate in the same wave*, however many
> retries are spent. Three "independent" tasks once conflicted in the barrel file.

The AF-2026-002 plan violated both. TASK-001 and TASK-002 are two unpaired RED tasks on
one file, which is exactly the configuration that lets an idle task inherit a sibling's
red suite and be credited for it — D-2 is that rule going unenforced. And `applyFixes`
then generated FIX-001 and FIX-002 on one file in one wave, which is the second rule
going unenforced.

This is the strongest argument for the milestone's shape: **a rule that lives only in a
person's notes is a rule the product does not have.** AR-05a (C-14) makes the first
mechanical, AR-06 (AD-42, AD-43) makes the second mechanical, and the planner-side
guidance that would prevent the pattern upstream is recorded in §12 as a deferred
item — the guard has to exist regardless of whether the planner improves.

### 0.3 The asymmetry that makes verification readiness cheap

```
integration          node_modules: NO    ← runVerification ran here → 4 × exit 127
TASK-001..006/a*     node_modules: YES   (275 MB each, ~2.5 GB total)
```

`.agent-flow/config.yaml` already declares `install: npm ci`, and
`app/task-workspaces.ts:8-39` already runs `project.commands.install` when preparing
every task workspace, with a clean assertion on either side and the rule that *the
agent is not invoked on a failed preparation*. The command exists, the mechanism
exists, the policy exists — it was never applied to the integration worktree, which
is created by a different path (`app/integrator.ts:417`).

AR-04 is therefore **parity, not a new feature**, and needs no new configuration key.

### 0.4 Prior art in this repository that this milestone extends rather than replaces

Four patterns already exist and are reused verbatim below. Introducing parallel
mechanisms where these exist is out of scope.

| Existing pattern | Where | Reused by |
| --- | --- | --- |
| Deterministic preflight that refuses **before** a run is created | `app/run-git-identity.ts:269` (`checkPlanningPreflight`) | AR-01 |
| Capability gap is a **config error**, never a fallback trigger | `core/role.ts:26-43` (`RoleResolutionError`, `fallbackEligible = false`) | AR-01 |
| A clamp is recorded, never silent | `DEGRADATION_KINDS` already has `reasoning_clamped`, `parallelism_clamped` | AR-01 |
| Persisted lifecycle separated from display projection | `RUN_STAGES` (8) vs `PIPELINE_STAGES` (9), `state.schema.ts:26-33` | AR-07 |

`RunEventSchema.detail` is `z.record(z.string(), z.unknown())` — **enriching an event
is not a breaking change.** This is load-bearing for AR-02: most new evidence lands in
events without any migration.

---

## 1. The principle, and where the boundary sits

> **The human is a decision maker, not the recovery mechanism.**

The human approves intent and judges outcome. Agent Flow operates the process. The
boundary is not a matter of taste; it is decidable, and this section decides it.

### 1.1 The rule

A decision belongs to the machine when it is **mechanically decidable**: computable
from exit codes, Git object identity, file paths, declared configuration, or set
arithmetic over data the run already persists. A decision belongs to a model only
when it is **semantic and advisory**. A decision belongs to the human only when it
changes **what was agreed** or **what is permitted**.

### 1.2 Applied to the evidence run

| # | Manual intervention | Authority it should have | Root cause | Location |
| --- | --- | --- | --- | --- |
| 0 | AF-2026-001 abandoned: discovery ran 17 min uninitialised; `init` then moved HEAD and voided `planningBase` | **mechanical** | preflight checks worktree/HEAD/gitignore/clean-tree, not *project initialised*. With no `.agent-flow/config.yaml` the validation registry is empty, so the run was **statically infeasible** | `run-git-identity.ts:269-309` |
| 1–2 | 2 × `revise` with hand-written instructions | **mechanical + LLM** | plan review rejected; `runCorrectiveRound` is one-shot, no self-repair | `corrective-round.ts:52-112` |
| 3 | `approve` | **human** — legitimate gate | — | — |
| 4 | `retry` TASK-002 + edit effort `medium`→`high` outside the tool | **mechanical** | `capabilities()` takes no argument, so `supportedReasoningLevels` describes the **CLI**, not the (runner, model) pair | `agy-runner.ts:34-45`, `role.ts:138-141`, `ports/agent-runner.ts:131` |
| 5–7 | 3 × `Resume run` that only took and released the lock | **mechanical** | TASK-003 sat in `review_required`; no projection distinguishes "held at a gate" from "resumable" | `run-actions.ts` |
| 8 | `retry` TASK-003 | **mechanical** | `requeue` writes `state: 'queued'` and nothing else — no failure context travels | `run-actions.ts:779-784` |
| 9 | Read `~/.gemini/antigravity-cli/log/` by hand to find `soft-denying tool confirmation "Bash"`; add `command(grep)` to global config | **diagnosis mechanical; grant human** | `result.raw` travels on `StageFailure` and is dropped at **both** persistence points; stage log is 2 metadata lines | `stage-runner.ts:300-320`, `task-executor.ts:151` |
| 10 | `retry --force` | **mechanical** | `retry.maxAttempts: 2` and attempt 2 died of an **environment permission**, not bad work. One counter, no classes | `defaults.ts:89`, `run-actions.ts:766-777` |
| 11–12 | 2 × `review`, both with 4 × exit 127 | **mechanical** | integration worktree has no `node_modules`; and `Verification: PASS` (the model's semantic verdict) prints below four mechanical `✗` under the same label | `run-actions.ts:1226-1243`, `cli/review.ts:180` |
| 13 | `reject` the corrective plan | **mechanical** | `applyFixes` hardcodes `dependencies: []`, two FIX tasks target one file, and `complexity` is derived from finding **severity** | `corrective-plan.ts:64-67` |

**10 of the 13 were mechanically avoidable. One needed a model to phrase a corrective
objective. Two were genuine human decisions — `approve`, and granting a tool
permission that had never been authorised.**

### 1.3 What must remain human

- Plan approval, where policy requires it.
- Scope expansion (§6.4 defines this mechanically).
- An ambiguous product decision.
- A sensitive permission not previously authorised.
- Any destructive action.
- Final acceptance and the merge decision.
- `AUTO_RECOVERY_EXHAUSTED` (§7).

### 1.4 What must never be human again

Discovering exit 127; discovering absent `node_modules`; a known model/effort
mismatch; a predictable command permission; reading a hidden stderr; clicking Resume
in a non-resumable state; deciding to retry a clearly recoverable failure; telling a
retry which test just failed; repairing a corrective plan rejected for mechanical
constraints; asking for verification to run again.

---

## 2. Design decisions

Numbering continues from the highest existing decision in the repository (`AD-16`),
with a deliberate gap. New invariants continue from `I-13`, new requirements from
`R-16`.

---

### AD-30 — Runner capabilities are a function of the (runner, model) pair

**Decision.** `AgentRunner.capabilities()` becomes
`capabilities(model?: string): RunnerCapabilities`. The core passes the configured
model as an **opaque string** and never interprets it. An adapter that has
model-specific knowledge answers with it; an adapter that has none returns what it
returns today, so behaviour is unchanged for every existing runner.

**Rationale.** `AgyRunner.capabilities()` declares
`supportedReasoningLevels: ['low','medium','high']`. That is true of the `agy` CLI and
false of Gemini 3.1 Pro, which accepts only `low` and `high`. The current signature is
**structurally incapable** of expressing the difference: no argument reaches it, and
`ports/agent-runner.ts:21` states the model is opaque to the core. The mismatch was
therefore undetectable before invocation, and cost a task attempt.

**Alternatives rejected.**
- *A capability table in the core keyed by model name.* Puts provider knowledge in the
  provider-neutral layer and would make Gemini a core concern. Violates AD-13.
- *A probe on every run.* Spends quota on every stage to learn a static fact.
- *Config-declared per-model capabilities.* Makes the user responsible for knowing what
  a model supports, which is the failure being fixed.

**Compatibility.** Adding an optional parameter is source-compatible with every
adapter. `RunnerCapabilitiesMap` becomes a resolver rather than a plain record — this
is the one call-site change, in `core/role.ts`.

**Persistence.** None.

**Security.** None. The model string was already passed to the adapter.

---

### AD-31 — An effort the (runner, model) pair does not support is clamped deterministically, never refused

**Decision.** When the resolved model does not offer the configured effort,
`clampReasoning` selects the nearest level below (falling back to the runner's minimum
only when nothing lower exists), `reasoningClamped` is set, and a
`reasoning_clamped` degradation is recorded. **No AgentRunner is invoked with an
unsupported effort. No task attempt is consumed. The run proceeds.**

**Rationale.** The mechanism already exists — `clampReasoning`, the
`reasoningClamped` field on results and attempts, and the `reasoning_clamped`
degradation kind — and until now has never fired, because it was fed CLI-level
capabilities. Feeding it model-level capabilities makes the existing machinery
correct. Refusing instead would satisfy `R-05` (a capability gap is a configuration
error, not an infrastructure failure) but would stop the run and demand a human, which
is the behaviour this milestone exists to remove.

**Alternatives rejected.**
- *Refuse with `RoleResolutionError`* — correct by `R-05`, and rejected because the
  system can resolve this without a person. The refusal path is retained for gaps that
  are **not** resolvable by clamping (read-only, non-interactive, working directory,
  native structured output).
- *Hybrid by role criticality* (clamp executors, refuse reviewers) — more precise, and
  deferred: it introduces two policies, and the boundary must be justified role by role.
  Recorded in §12 as a candidate, not adopted.

**Compatibility.** No CLI or config change. A run that previously died now proceeds at
a recorded lower effort.

**Persistence.** None — `reasoningClamped` and the degradation kind already exist.

**Security.** None.

**Consequence — I-20.** *No AgentRunner is ever invoked with a reasoning level the
resolved (runner, model) pair does not declare.*

---

### AD-32 — Permission readiness is a capability, distinct from non-interactivity

**Decision.** `RunnerCapabilities` gains:

```ts
/** Tool classes the runner can exercise without interactive confirmation. */
readonly nonInteractiveToolGrants: {
  readonly fileEdit: boolean;
  readonly commandExecution: boolean;
  /** Commands known to be denied in the current environment, if discoverable. */
  readonly deniedCommands?: readonly string[];
};
```

**Rationale.** `supportsNonInteractive: true` says the process will not block on a
prompt. It does **not** say the agent can run the tools the work requires. AGY was
non-interactive and still failed: it tried `grep`, local policy demanded confirmation,
nobody could answer, and the run recorded `execution_failed`. The two properties are
different and were conflated.

**Alternatives rejected.**
- *`--dangerously-skip-permissions` as the standard path.* Explicitly out of scope: it
  removes the containment that AD-14 assigns to the runner.
- *Inferring grants from an error after the fact.* Detection after paying for the
  attempt is what AR-01 exists to avoid — though AR-02 still classifies it when a
  novel denial appears.

**Compatibility.** A new required field on `RunnerCapabilities` touches all four
adapters. Each declares what its CLI documents; unknown stays `false`, and `false`
does not block execution — it produces a `permission_not_ready` **warning** from
`doctor` and a preflight finding, never a silent pass.

**Persistence.** None.

**Security.** Positive: makes an implicit assumption explicit and auditable. A grant is
declared, never inferred from a successful run.

---

### AD-33 — Raw runner output is persisted on failure, redacted, and is evidence rather than control flow

**Decision.** On a stage failure, `StageFailure.raw` is persisted in three places:
the stage log (full, redacted), the `stage_failed` event (`rawExcerpt`, first 2 KB,
redacted), and a new `attempt-<n>.failed.json` artifact (§AD-34). Control flow
continues to branch **only** on `RunnerErrorCode`, never on raw text.

**Rationale.** The contract already carries it —
`AgentRunFailure.raw` is documented as *"Original message, kept for diagnosis. Never
used for control flow"* — and `runner-probe.ts:66` already reads it. It is dropped at
exactly the two points that persist anything: `stage-runner.ts:300` writes only
`errorCode` to the log, and `stage-runner.ts:302-312` omits it from the event.
`task-executor.ts:151` then keeps `failure.message` and discards `failure.raw`. The
true cause — `soft-denying tool confirmation "Bash"` — existed in memory and was
thrown away, so a person read the vendor's own log directory instead.

**Alternatives rejected.**
- *Log raw only, not the event.* The dashboard reads events; the operator would still
  need a terminal.
- *Persist unredacted.* Violates the no-secrets rule.

**Compatibility.** Additive.

**Persistence.** Yes — new event field, new artifact. Both additive; `detail` is an
open record.

**Security.** Requires the redaction contract in AD-35. Raw output may contain tokens,
`Authorization` headers, and absolute paths, and `task-workspaces.ts:71-86` already
establishes that persisted detail must be path-free by construction.

---

### AD-34 — A failed attempt produces an artifact; it is a distinct artifact from a completed one

**Decision.** A stage failure writes `tasks/<TASK>/attempt-<n>.failed.json`, holding
classification, provenance, redacted evidence, and the validation results that did
run. It **never** contains an `agentReport`.

**Rationale.** `task-executor.ts:136-141` deliberately writes no artifact when the
stage throws, and the justification is sound: the agent produced no report, and
inventing one would be *"evidence of a report nobody made"*. But the conclusion
overshoots. The evidence of the **failure** exists — error code, provenance, raw
output, duration — and discarding it means the only attempts without a persisted
artifact are precisely the ones somebody needs to diagnose. In the evidence run,
`TASK-002/attempt-1.json` and `TASK-003/attempt-2.json` do not exist; those are the
two attempts that failed.

Separating the file name preserves the invariant §17.3 depends on: *no
`attempt-<n>.json` means the attempt's work was never observed.* That statement stays
literally true.

**Alternatives rejected.**
- *Write `attempt-<n>.json` with a null report.* Breaks the recovery window semantics.
- *Keep it in events only.* Events are an audit trail, not the source of truth
  (`AD-06`); a Failure Context Packet must read from an addressable artifact.

**Compatibility.** New file, new name. No reader of `attempt-<n>.json` changes.

**Persistence.** Yes — new artifact, new schema (§8).

**Security.** Subject to AD-35.

---

### AD-35 — Redaction is a contract, applied once, at the boundary that persists

**Decision.** A pure `core/evidence-redaction.ts` exposes
`redactEvidence(text: string, context: RedactionContext): string`, applied by every
writer of raw evidence. It replaces: absolute paths under the worktree root and the
home directory with stable placeholders (`<workspace>`, `<home>`); anything matching
known credential shapes (bearer tokens, `sk-`/`ghp_`-style keys, `api[_-]?key`
assignments, `Authorization:` values); and environment values sourced from configured
secret keys. Redaction is **irreversible and lossy by design**.

**Rationale.** AD-33 and AD-34 create three new persistence paths for untrusted
third-party output. Redacting at each writer independently guarantees drift. The
repository already demands path-free persisted detail
(`task-workspaces.ts:71-86`), and that rule must not weaken because the channel is new.

**Alternatives rejected.** Redacting at read time — the secret is on disk by then.

**Persistence.** Every persisted evidence field is post-redaction. There is no raw
mirror.

**Security.** This is the invariant that makes AD-33 and AD-34 safe. **I-21:** *No
persisted artifact, event, or HTTP response contains an unredacted runner output.*

---

### AD-36 — Failure classification is mechanical, happens once, and extends the canonical vocabulary

**Decision.** A pure `core/failure-classification.ts` maps
`(RunnerErrorCode, redacted raw, execution context, validation outcome)` to a
`FailureClass`. It runs **once**, in the adapter-facing layer, before anything is
persisted, and the result travels on every artifact and event that reports the
failure. It is deterministic and table-driven, and it never calls a model.

`RUNNER_ERROR_CODES` — `quota_exceeded`, `auth_required`, `runner_unavailable`,
`timeout`, `execution_failed`, `invalid_output`, `blocked` — is **unchanged**.
`FailureClass` is a **refinement layer above** it, not a replacement, and every class
declares which runner code it refines. Nothing branches on both.

**Rationale.** The existing vocabulary is a *runner transport* vocabulary and is
correct at that level. What is missing is the level above: `execution_failed` covered
an unsupported effort, a denied command, and a genuine implementation failure — three
failures with three different correct responses. Creating a second parallel enum
instead of a refinement would produce two answers to one question.

**Alternatives rejected.**
- *Extend `RUNNER_ERROR_CODES`.* It is the adapter translation contract, deliberately
  small, and `FALLBACK_TRIGGERS` is defined as a subset of it at the schema level.
  Growing it changes fallback reasoning as a side effect.
- *Classify with an LLM.* Never for the authoritative decision. AD-40 permits an
  advisory classification only for a raw output no rule matches, and it may not change
  `recoverable`.

**Compatibility.** Additive.

**Persistence.** Yes — `failureClass` on task progress, on the failed-attempt
artifact, and in event detail (§8).

**Security.** Classification reads redacted text only.

---

### AD-37 — Not every failure consumes an attempt

**Decision.** `TaskProgress` splits its counter:

```ts
readonly attempts: number;              // work attempts — gates maxAttempts
readonly infrastructureFailures: number; // preflight/environment — gates its own budget
```

A failure consumes an **attempt** only when the agent was invoked and produced work
that was judged. Everything the run knew, or could have known, before invoking the
agent consumes an **infrastructure failure** instead.

**Rationale.** TASK-003 burned both attempts: attempt 1 on `validation_unsatisfied`
(genuine work, correctly counted) and attempt 2 on a denied `grep` — an environment
fact that had nothing to do with the quality of the work. The single counter then
forced `retry --force`, which is the mechanism for *deliberately overruling a gate*,
spent here to work around miscounting. `attempts` is already persisted and already
gates `retry` at `run-actions.ts:766`; the fix is to stop putting two kinds of event in
one number.

**Alternatives rejected.**
- *Do not count infrastructure failures at all.* Unbounded: a permanently misconfigured
  environment would retry forever.
- *Decrement on infrastructure failure.* Arithmetic that hides history; the audit trail
  should show what happened.

**Compatibility.** `attempts` keeps its meaning and its default. `infrastructureFailures`
defaults to `0`, so existing state files parse unchanged.

**Persistence.** Yes — one new optional field with a default (§8).

**Security.** None.

**Consequence — I-22.** *A failure classified `PRE_EXECUTION` never increments
`attempts`.*

---

### AD-38 — A completed task must have produced observable change, or it is not completed

**Decision.** Before a task may reach `completed`, two mechanical assertions must
hold, both computed from data already persisted:

1. **Non-empty effect.** `receipt.validatedTree !== base tree`, unless the task's plan
   entry declares `expectsNoChange: true` (a new, explicit, opt-in field for
   verification-only tasks).
2. **Scope containment.** Every path in the mechanical diff is within the task's
   `files.likely`, unless the plan entry declares `scopeMode: 'open'` (§8.3 — the field is
   `scopeMode` because `Task.scope` is an existing free-form module label).

Assertion 1 failing yields `acceptance_evidence_missing`. Assertion 2 failing yields
`scope_violation`. Both are `review_required`, never silent.

**Rationale.** This is D-1 and D-3. Both hashes are already in
`attempt-<n>.json`; `filesChanged` is currently taken from
`parseResultBlock` — the **model's own prose** (`task-executor.ts:172,252`) — while
Git holds the mechanical answer and is never asked. A run cannot claim
"mechanical evidence over model claims" while its record of what changed is a model
claim.

`expectsNoChange` is required rather than inferred because TASK-006 was a legitimate
verification task with an empty diff. The difference between "correctly changed
nothing" and "did nothing" is intent, and intent belongs in the plan, declared before
the fact.

**Alternatives rejected.**
- *Warn instead of blocking.* A warning on an integrated merge commit is a warning
  nobody acts on. The evidence run proves it: the final reviewer caught it three
  stages and two review cycles later.
- *Infer `expectsNoChange` from an empty `files.likely`.* TASK-006 declared three
  files it was meant to leave untouched, so the inference would be exactly backwards.

**Compatibility.** `expectsNoChange` and `scopeMode` default to absent, so plans
generated before this milestone keep planning-time validity — but a *task* that
changes nothing now stops at `review_required` instead of completing. That is the
intended behaviour change and the reason this milestone exists.

**Persistence.** Yes — two optional plan fields; `filesChanged` gains a mechanical
source (§8).

**Security.** Positive: closes a false-positive acceptance path.

**Consequence — I-23.** *No task reaches `completed` with a validated tree identical
to its base unless its plan entry declares `expectsNoChange`.*

---

### AD-39 — `filesChanged` is mechanical; the agent's list is retained as a claim

**Decision.** `TaskResult.filesChanged` and `AttemptRecord.filesChanged` are computed
from `git diff --name-only <base> <validatedTree>`. The agent's self-report moves to
`agentReport.claimedFilesChanged`. A divergence between the two is recorded as
`report_divergence` in the attempt's notes — informative, never blocking.

**Rationale.** Direct application of the security model. The two agreed in the evidence
run, which is a fact about that agent's honesty on that day, not a guarantee.

**Compatibility.** Field keeps its name and type; its source changes. Sequential runs
with no isolation and no validated tree keep the reported list, marked as such.

**Persistence.** Yes — additive within existing artifacts (§8).

**Security.** Positive.

---

### AD-40 — The Failure Context Packet is assembled mechanically and consumed as untrusted advisory input

**Decision.** A retry-eligible failure produces a `FailureContextPacket`, built by
pure code from persisted artifacts, with a hard size budget (§6.5):

```ts
interface FailureContextPacket {
  readonly previousAttempt: number;
  readonly failureClass: FailureClass;
  readonly runnerErrorCode?: RunnerErrorCode;
  readonly rawExcerpt?: string;          // redacted, bounded
  readonly failedChecks: readonly CommandSummary[];   // command + exit + tail
  readonly successfulChecks: readonly string[];       // ids only
  readonly previousDiffStat?: string;    // --stat, never the full patch
  readonly acceptanceCriteria: readonly string[];
  readonly correctiveObjective: string;
  readonly environmentRepairs: readonly string[];
}
```

It is appended to the implementation prompt, exactly as MVP 3's advisory context is
(`stage-runner.ts:238-254`): additive, never replacing the rendered prompt. The next
attempt still branches from the **integration head** (AD-41). `correctiveObjective`
may be phrased by a model; everything else is mechanical, and a model's phrasing may
not alter any other field.

**Rationale.** `requeue` (`run-actions.ts:779-784`) writes `state: 'queued'` and
nothing else, so a retry re-reads the same task description that already failed once.
The system had the failing command, its exit code, its stderr, the previous diff and
the acceptance criteria — and asked the operator to explain the failure to the next
attempt.

**Alternatives rejected.**
- *Hand over the previous patch.* Makes a rejected attempt a starting point and erodes
  isolation. `--stat` conveys shape without conveying content.
- *Have a model summarise the failure into prose.* Spends a call to compress data that
  is already structured, and inserts a paraphrase where evidence belongs.

**Compatibility.** Additive. A packet is present only on a retry.

**Persistence.** Yes — persisted next to the attempt it informs, so a run can show
what the retry was told (§8).

**Security.** Post-redaction. Bounded by §6.5, so recovery cannot become a context
explosion.

---

### AD-41 — A retry always branches from the integration head; knowledge travels, code does not

**Decision.** Unchanged from today: a new attempt is a new worktree on a new branch
cut from the current integration head. The Failure Context Packet is the **only**
channel by which anything from a previous attempt reaches the next one, and it carries
no patch.

**Rationale.** Isolation is what makes a validated tree meaningful. The user's
intuition that Retry means "continue what broke" is real, and it is satisfied by
carrying **knowledge** rather than **state** — which also keeps the previous attempt
from becoming a source of truth it was never validated as.

**Alternatives rejected.** Branching from the failed attempt — a rejected tree becomes
the base for a receipt claiming validation.

**Persistence.** None.

**Security.** Preserves I-3.

---

### AD-42 — Corrective task dependencies are derived from declared file overlap

**Decision.** `applyFixes` stops hardcoding `dependencies: []`. Corrective tasks are
generated in finding order, and each one depends on every earlier corrective task whose
`files.likely` intersects its own. `complexity` is derived from the **shape of the
work** (one file and one acceptance criterion → `trivial`; several files or a
cross-cutting gate → `normal`; a new contract or a new module → `complex`), not from
the finding's severity.

**Rationale.** `corrective-plan.ts:67` hardcodes `dependencies: []` for every fix, and
lines 64-65 map `severity: high|critical → complex`. In the evidence run that produced
FIX-001 and FIX-002 both targeting `test/cli/cli.test.ts` with no dependency — same
wave, same file, guaranteed conflict — and all three classified `complex` because all
three findings were `high`. Severity measures *how much a defect matters*; complexity
measures *how much work it is*. Using one for the other is a category error that costs
the highest-effort model on a one-line test fix.

Overlap-derived serialisation is deterministic, conservative, and cheap: an
intersection of two string sets.

**Alternatives rejected.**
- *Let the plan reviewer catch it.* It did — after a model call, and it then required a
  human to write a revision. `planning-checks.ts` already exists precisely because
  *"arithmetic is not what a model should be spending a call on"*.
- *Merge overlapping fixes into one task.* Loses per-finding traceability, which
  `correctiveFor` exists to preserve.

**Compatibility.** Same schema; different generated values.

**Persistence.** None.

**Security.** Positive: removes a class of merge conflict from the corrective path.

---

### AD-43 — File-overlap safety is validated before the scheduler, and enforced by the scheduler

**Decision.** Two layers.

1. `checkPlan` gains a **deterministic overlap guard**: two tasks whose `files.likely`
   intersect and which are mutually independent in the DAG are reported as a problem.
   This is a plan-validity check, and it runs before any review.
2. The scheduler gains a **wave constraint**: no two tasks in the same wave may
   declare intersecting `files.likely`. When the constraint bites, the later task waits
   for the next wave and a `wave_serialised_for_overlap` event records why.

`core/dag.ts` stays file-agnostic. Overlap is planning and scheduling policy, not graph
topology, and `DagNode` remains `{ id, dependencies }`.

**Rationale.** `checkPlan` already runs coverage, validation-id and DAG checks
(`planning-checks.ts:21-63`) and has no notion of files. The scheduler takes
`ready.slice(0, concurrency)` (`scheduler.ts:322`) with no notion of files either. Two
layers rather than one because they answer different questions: layer 1 rejects a plan
that is *wrong on paper*, and layer 2 protects a plan that is right on paper but whose
tasks became ready together after a retry reordered them.

The guard is a **risk report at planning time and a serialisation at execution time** —
never an automatic dependency edge injected into an approved plan, because that would
change a document a human approved.

**Alternatives rejected.**
- *Inject dependencies automatically at planning time.* Silently rewrites the plan the
  human reads and approves.
- *Only annotate the risk.* An annotation nobody enforces is what produced FIX-001 and
  FIX-002.
- *Teach the DAG about files.* Couples pure topology to a scheduling concern; the
  architecture test that guards single-implementation topology would have to loosen.

**Compatibility.** Layer 1 can reject plans that previously validated. This is
intended, and it is why AR-06 lands after AR-05 in §9.

**Persistence.** New event type only.

**Security.** Positive.

---

### AD-44 — Verification runs in a prepared workspace, and environment readiness is not a regression

**Decision.** Before `runVerification`, the integration worktree goes through the
**same preparation sequence** as a task workspace (`task-workspaces.ts:8-39`): assert
clean → `project.commands.install` → assert clean. Preparation failure yields
`workspace_not_ready` / `dependency_environment_not_ready` and **verification does not
run**, because an unprepared verification produces exit codes that describe the
environment and get read as a verdict on the code.

`install` is **not** added to `VERIFICATION_ORDER`. It is workspace preparation, not
a verification step: it must run before the step whose failure it would otherwise be
blamed for, and a project that declares no install command is not a project that failed
to install.

**Rationale.** §0.3. The command, the mechanism and the policy all already exist; only
the integration worktree was left out. The exit 127s were not hidden from the model —
they reached both reviewers through `commandResults` — so the defect is not visibility.
It is that nothing prepared the tree, and nothing distinguished *"the environment
cannot answer this question"* from *"the answer is no"*.

**Alternatives rejected.**
- *Add `install` to `VERIFICATION_ORDER`.* It would run inside the sequence it must
  precede, and a missing install command would surface as a skipped verification step.
- *Share one `node_modules` across worktrees by symlink.* Correctness risk (hoisting,
  platform binaries, lockfile drift) for a disk saving, and it would make one attempt's
  install observable to another — breaking the isolation that makes a validated tree
  mean something. Recorded in §12 as a deferred optimisation with a real cost:
  9 worktrees × 275 MB ≈ 2.5 GB in the evidence run.

**Compatibility.** `review` becomes slower on first run in a worktree and can now
refuse before spending two model calls — which is the point.

**Persistence.** New event types for preparation outcome.

**Security.** Unchanged: `commands.install` is human-authored configuration, never
model output. `doctor`'s existing install probe (`cli/doctor.ts:242-343`) already
verifies it leaves a fresh checkout clean.

---

### AD-45 — Mechanical Verification, Semantic Review, Final Review and Definition of Done are four distinct verdicts and are never rendered under one label

**Decision.** Four named results, each with its own vocabulary:

| Verdict | Authority | Question | Values |
| --- | --- | --- | --- |
| **Mechanical Verification** | exit codes | did the project's own commands pass? | `PASS` / `FAIL` / `NOT_RUN` |
| **Semantic Review** | model, advisory | does the implementation look right? | `PASS` / `FAIL` |
| **Final Review** | model, advisory | does it satisfy the approved SDD? | `PASS` / `FAIL` |
| **Definition of Done** | code | may this be called finished? | `done` / `not done` |

`NOT_RUN` is the third value the current model lacks, and it is what an unprepared
workspace produces. A `NOT_RUN` mechanical verification makes the Definition of Done
`not done` and **suppresses** both model verdicts from being rendered as conclusions
about the code — they were formed against an environment that could not answer.

**Rationale.** `cli/review.ts:180` prints `Verification: ${verification.verdict}` —
the **model's** verdict — directly beneath four mechanical `✗` marks emitted by
`onVerificationStep` (`cli/review.ts:44-46`). Two different questions, one label,
opposite answers, and the operator reasonably concluded the tool was lying. The
Definition of Done was in fact correct (`NOT DONE`, on `verificationPassed: false`);
the rendering was not.

**Alternatives rejected.**
- *Rename the display only.* Leaves `NOT_RUN` unrepresentable, so an unprepared
  environment still looks like a failing codebase.
- *Let mechanical failure suppress the model calls entirely.* Sometimes desirable, but
  a reviewer reading a broken build is occasionally the fastest route to the cause. AR-04
  removes the common case by preparing the workspace; the distinction still has to exist
  for the rest.

**Compatibility.** `DoneInput.verificationPassed: boolean` becomes
`mechanicalVerification: 'PASS' | 'FAIL' | 'NOT_RUN'`. One call site, one contract.

**Persistence.** Yes — `verification.json` gains a mechanical section (§8).

**Security.** Positive: removes a path where a degraded run reads as a passing one.
Directly serves the rule that *degraded is never a silent PASS*.

**Consequence — I-24.** *No user-visible surface renders a model verdict and a
mechanical result under the same label; and no surface reports `PASS` for a run whose
mechanical verification is `FAIL` or `NOT_RUN`.*

---

### AD-46 — Approval authorises bounded corrective work inside a mechanically-decided envelope

**Decision.** Approving a plan authorises corrective rounds whose every corrective
task is **inside the envelope**, with no new human gate. A corrective task is inside
the envelope when **all** hold:

1. `files.likely ⊆ files touched by this run so far` (mechanical, from the integration
   diff);
2. `requirements ⊆ requirement ids declared by the approved SDD`;
3. it introduces no new file under a declared contract path (`src/contracts/**`);
4. it declares no new validation id;
5. the corrective-round budget (§6.2) is not exhausted.

Any corrective task failing any condition puts the **whole round** back through human
approval. The grant and the envelope evaluation are recorded on the run.

**Rationale.** `runCorrectiveRound` clears `approved` unconditionally
(`corrective-round.ts:79-85`), with a good reason: the human approved a set of tasks
and this is a different set. But conditions 1–4 make "different set" measurable. A fix
that touches only files this run already changed, cites only requirements the SDD
already declares, adds no contract and adds no validation id is **not a different
agreement** — it is the same agreement, executed correctly. That is precisely
"scope-preserving correction", and it is decidable by set arithmetic.

**Alternatives rejected.**
- *Human gate on every corrective round.* Safe, simple, and concedes that zero
  interventions between approval and result is unreachable.
- *Per-run opt-in flag (`approve --auto-correct=N`).* Autonomy by explicit consent; kept
  in §12 as a possible refinement of the budget, not of the envelope.

**Compatibility.** The envelope is evaluated before `approved` is cleared, so a
run whose corrective work is outside it behaves exactly as today.

**Persistence.** Yes — the grant and each envelope evaluation are recorded (§8).

**Security.** This is the one decision in this milestone that moves a gate. It is made
safe by four properties: the envelope is mechanical and cannot be argued into; it can
only ever **narrow** what a human already approved; it is bounded by budget; and every
evaluation is persisted, so a run can always show why it did not ask. **A corrective
task may never grant a permission, and may never change a Git safety rule.**

**Consequence — I-25.** *No corrective round proceeds without human approval unless
every one of its tasks is inside the envelope and the corrective budget is unexhausted.*

---

### AD-47 — A corrective plan may repair itself against mechanical constraints, within a budget

**Decision.** When `checkPlan` or the overlap guard rejects a generated corrective
plan, the generator **repairs it mechanically and re-validates**, up to
`maxCorrectivePlanRepairs` (§6.2). Repairs are limited to a closed set: adding
overlap-derived dependencies, correcting complexity, dropping a duplicate finding,
and replacing an unresolvable validation id with the project's default set. If the
plan is still invalid, or if the **plan reviewer** rejects it, the round escalates
with `AUTO_RECOVERY_EXHAUSTED`.

A model-authored repair of a **reviewer-rejected** plan is explicitly out of scope
for this milestone: the reviewer's objection is semantic, and answering it
autonomously would let the system talk itself past its own gate.

**Rationale.** `runCorrectiveRound` is one-shot: `checkPlan` fails → `invalid_plan`,
reviewer fails → `plan_rejected`, and in both cases the operator writes the revision.
The rejections in the evidence run were mechanical in nature (same file, no
dependencies, wrong complexity) and are exactly what AD-42 stops generating. The
repair loop exists for the residue.

**Alternatives rejected.**
- *Let a model rewrite the rejected plan.* Model-authored answers to a model's
  objection, with no mechanical arbiter.
- *No repair loop at all.* Relies on AD-42 being complete, which is not a claim worth
  making about a generator.

**Compatibility.** Additive; the terminal outcomes are unchanged.

**Persistence.** New event per repair round.

**Security.** Bounded, mechanical, and it never bypasses the plan review — it only
avoids spending a review call on a plan that code can prove invalid.

---

### AD-48 — Runtime status is projected, never persisted

**Decision.** `RUN_STATUSES` is **unchanged**. A new pure
`core/run-projection.ts` derives a `RuntimeStatus` from persisted state, the event
log and the DAG, and both the CLI and the HTTP API consume that one projection. It
answers, among others: is there executable work right now; which gate is holding this
run; is the newest review the one being displayed; and are workflow, implementation and
corrective progress each what they are.

**Rationale.** The pattern is already established and documented in this repository:
`PIPELINE_STAGES` (9) exists separately from `RUN_STAGES` (8) so that *"a display
concern"* never becomes *"a stage the state machine has to pretend to run"*
(`state.schema.ts:26-33`). Every observability defect in the evidence run is a missing
projection, not a missing state: `plan_rejected` persisted while revision 2 was running;
`APPROVED` shown during implementation; `Resume run` offered three times with nothing
runnable; overall progress at 100% with verification pending, then falling to 67% when
corrective tasks were appended.

**Alternatives rejected.**
- *Add runtime statuses to `RUN_STATUSES`.* Mixes lifecycle with presentation, and a
  crash mid-write would persist a runtime opinion.
- *Compute it in the UI.* Makes the UI a source of truth and guarantees the CLI and the
  dashboard disagree.

**Compatibility.** Additive and pure.

**Persistence.** None — this is the decision's whole point.

**Security.** None.

**Consequence — I-26.** *No runtime status is persisted, and the CLI and the HTTP API
derive theirs from one projection.*

---

## 3. Failure taxonomy

`FailureClass` refines `RunnerErrorCode` (AD-36); it does not replace it. Every class
declares the runner code it refines (`—` where the failure never reached a runner), who
detects it, whether recovery may proceed without a human, and whether it consumes a
work attempt.

### 3.1 PRE_EXECUTION — knowable before the agent is invoked

| Class | Refines | Detected by | Auto-recoverable | Consumes attempt |
| --- | --- | --- | --- | --- |
| `project_not_initialized` | — | preflight (fs) | no — refuse, 0 tokens | **no** |
| `runner_unavailable` | `runner_unavailable` | `healthCheck` | yes — fallback | **no** |
| `runner_not_authenticated` | `auth_required` | `healthCheck` / probe | no — human | **no** |
| `model_capability_mismatch` | — | resolution (AD-30) | yes — clamp (AD-31) | **no** |
| `permission_not_ready` | — | capability + preflight | no — human grant | **no** |
| `workspace_not_ready` | — | preparation assert | yes — one re-prepare | **no** |
| `dependency_environment_not_ready` | — | preparation / `NOT_RUN` | yes — `commands.install` | **no** |
| `validation_registry_incomplete` | — | `checkPlan` | no — human config | **no** |

### 3.2 RUNNER — the agent was invoked and the process failed

| Class | Refines | Detected by | Auto-recoverable | Consumes attempt |
| --- | --- | --- | --- | --- |
| `runner_execution_failed` | `execution_failed` | adapter | yes — 1 retry w/ packet | **yes** |
| `runner_timeout` | `timeout` | adapter | yes — 1 retry | **yes** |
| `runner_quota_exhausted` | `quota_exceeded` | adapter | yes — fallback, else wait | **no** |
| `runner_permission_required` | `execution_failed` | classifier over raw | no — human grant | **no** |
| `malformed_runner_output` | `invalid_output` | `StageRunner` repair loop | yes — existing loop | **yes** |

`runner_permission_required` is the class the evidence run needed and did not have. It
refines the same runner code as `runner_execution_failed` and is distinguished by the
classifier reading redacted raw output for a denial signature — the AGY case being
`soft-denying tool confirmation` plus `permission check failed`. It does **not** consume
an attempt, because the work was never attempted.

### 3.3 TASK — the agent produced work and it was judged

| Class | Refines | Detected by | Auto-recoverable | Consumes attempt |
| --- | --- | --- | --- | --- |
| `implementation_completed` | — | judgement | n/a — success | yes |
| `validation_unsatisfied` | — | `judgeValidation` | yes — retry w/ packet | **yes** |
| `acceptance_evidence_missing` | — | AD-38 assertion 1 | yes — retry w/ packet | **yes** |
| `acceptance_evidence_unsatisfied` | — | per-AC evidence (AR-05) | yes — retry w/ packet | **yes** |
| `scope_violation` | — | AD-38 assertion 2 | no — human | **yes** |
| `agent_blocked` | `blocked` | `parseResultBlock` | **no — never automatic** | yes |

`agent_blocked` keeps today's behaviour without exception: BLOCKED means a decision is
missing, and re-running the same prompt produces the same gap or a guess.
`scope_violation` is not auto-recoverable because a task that wrote outside its
declared scope may already have changed another task's outcome — as TASK-003 did.

### 3.4 INTEGRATION

| Class | Refines | Detected by | Auto-recoverable | Consumes attempt |
| --- | --- | --- | --- | --- |
| `merge_conflict` | — | Integrator | yes — re-attempt on new head | **no** |
| `integration_validation_failed` | — | post-merge validation | yes — corrective round | yes |
| `integration_history_invalid` | — | reconciliation | **no — human** | **no** |

### 3.5 REVIEW

| Class | Refines | Detected by | Auto-recoverable | Consumes attempt |
| --- | --- | --- | --- | --- |
| `semantic_review_failed` | — | Semantic Review | yes — corrective round | n/a |
| `final_review_failed` | — | Final Review | yes — corrective round, inside envelope | n/a |
| `corrective_plan_invalid` | — | `checkPlan` + overlap guard | yes — repair (AD-47) | n/a |
| `corrective_plan_rejected` | — | plan reviewer | **no — human** | n/a |

### 3.6 RECOVERY — the disposition, not a failure

`recoverable` · `requires_human` · `recovery_exhausted`

Every `FailureClass` maps to exactly one disposition, and the mapping is a table, not a
judgement. `AUTO_RECOVERY_EXHAUSTED` is the terminal projection of
`recovery_exhausted` and must always carry: the class, the counts, the redacted
evidence, every repair already attempted, why each did not work, and **one specific
human action**. `something failed, inspect logs` is a contract violation.

---

## 4. State machines

### 4.1 Run — persisted lifecycle (unchanged)

`RUN_STATUSES` gains nothing. Recovery is a **runtime** condition (AD-48).

```
running ──────────────► waiting_for_approval ──► approved ──► running
   │                          ▲     │                             │
   │                          │     └──► plan_rejected ───────────┘ (revise)
   │                          │
   └── corrective round ──────┘  (envelope outside → human; inside → stays running)
                                                          │
                                        ┌─────────────────┴─────────────────┐
                                        ▼                                   ▼
                                    completed                            failed
```

### 4.2 Run — runtime projection (new, derived, never persisted)

```
RuntimeStatus =
  | planning | awaiting_human_approval | plan_rejected_revisable
  | implementing | recovering            ← ≥1 task in an automatic recovery step
  | verifying    | reviewing
  | correcting   ← corrective round in flight; carries round number and envelope verdict
  | blocked_on_human  ← carries WHICH gate and the one action that clears it
  | auto_recovery_exhausted ← carries class, counts, evidence, attempted repairs
  | complete | failed

resumable: boolean   ← true only when the DAG yields executable work now.
                       `Resume` is offered if and only if this is true.
```

### 4.3 Task

Existing states are unchanged. `TRANSITIONS` (`core/task-state.ts:17-39`) gains **one**
edge, and `completed` stays terminal:

```
review_required ──► queued     already legal
failed          ──► queued     already legal
running         ──► recovering NEW: an automatic recovery step is executing
recovering      ──► queued     recovery prepared a new attempt
recovering      ──► blocked    recovery escalated to a human
```

`recovering` is a **runtime** state in the projection, not a new persisted
`TaskState`. Persisted state remains `failed` / `review_required` until a new attempt
is queued, so a crash mid-recovery is indistinguishable from a crash after the failure
— which is the behaviour crash recovery already handles.

### 4.4 Attempt

An **attempt** is one invocation of an AgentRunner for one task, in one prepared
workspace, whose work was observed and judged. This is the answer to the milestone's
first mandatory question, and it is narrower than today's usage.

```
prepared ──► invoked ──► observed ──► judged ──► { satisfied | unsatisfied | not_reached }
    │            │
    │            └─ process failed ──► attempt-<n>.failed.json  (AD-34)
    │                                  classified (AD-36)
    │                                  counts as attempt ONLY if class says so (AD-37)
    └─ preparation failed ──► infrastructureFailures += 1, attempts unchanged
```

**Naming collision to remove.** `StageRunner`'s internal repair counter is also called
`attempt` and is written into the stage log — the evidence run has
`attempt=1 failed` inside a file named `...-attempt-2.log`. AR-00 renames the internal
counter to `repair` in logs and events. One word, one meaning.

**Where that rename stops, and why.** AR-00 owns the counter and everything it *writes*: the
loop variable is `repair`, and every log line and event field it emits uses the normative
term. Readers accept **both** spellings, because every event already on disk says `attempts`
and renaming a field a reader depends on is a migration unless the reader keeps reading the
old one.

`TelemetryEntry.attempts` and `StageViewResponse.attempts` are **read-model and UI
surfaces**, not records the state machine writes. For a stage entry they carry the repair
count under the older name. Renaming them belongs to **AR-07**, which owns the projection both
surfaces consume; doing it in AR-00 would change a rendered contract in a milestone whose
non-goal is "no behaviour change" and whose scope excludes the UI.

### 4.5 Recovery

```
failure ──► classify (mechanical, once)
              │
              ├─ requires_human ─────────────► blocked_on_human (specific action)
              ├─ recovery_exhausted ─────────► AUTO_RECOVERY_EXHAUSTED
              └─ recoverable
                    │
                    ├─ environment? ─► repair env ─► re-verify ─► requeue
                    │                     (budget: maxEnvironmentRepairs)
                    └─ work?        ─► build packet (AD-40) ─► requeue from
                                       integration head (AD-41)
                                       (budget: maxAttempts)
```

Each loop iteration must either **change something mechanically observable** or end.
Identical consecutive failures are capped by `maxIdenticalFailures` (§6.1).

### 4.6 Corrective round

```
final review FAIL
   ↓
generate corrective tasks (AD-42: overlap-derived deps, work-derived complexity)
   ↓
deterministic DAG + overlap sanity (AD-43 layer 1)
   ↓ invalid ──► mechanical repair (AD-47) ──┐ up to maxCorrectivePlanRepairs
   ↓ valid                                   │
envelope evaluation (AD-46) ◄────────────────┘
   ├─ any task outside ──► human approval
   └─ all inside ──► plan review
                        ├─ PASS ──► execute ──► re-verify
                        └─ FAIL ──► AUTO_RECOVERY_EXHAUSTED (no self-answer)
```

---

## 5. Recovery decision table

The normative dispatch table. `Authority` is who decides — never a model for anything
in the `mechanical` column.

| Failure | Detection | Authority | Automatic | Consumes attempt | Retry strategy | Human escalation | Evidence required |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `project_not_initialized` | fs preflight | mechanical | **refuse before run** | no | none | *"Run `agent-flow init`"* | absent config path |
| `model_capability_mismatch` | resolution | mechanical | **clamp** | no | n/a — never invoked | none | requested, effective, supported set, reason |
| `permission_not_ready` | capability decl. | mechanical | no | no | none | grant the named tool | tool class, runner, model |
| `runner_permission_required` | classifier over raw | mechanical | no | **no** | after grant | grant the named command | redacted raw + command |
| `workspace_not_ready` | clean assert | mechanical | 1 re-prepare | no | re-prepare, re-assert | dirty paths, bounded | phase + changed paths |
| `dependency_environment_not_ready` | prep / `NOT_RUN` | mechanical | `commands.install` | no | install, re-assert, re-verify | install exit + tail | exit code + command |
| `runner_unavailable` | `healthCheck` | mechanical | fallback | no | fallback role | all providers down | health detail |
| `runner_quota_exhausted` | adapter | mechanical | fallback | no | fallback; else stop | no fallback available | runner code |
| `runner_timeout` | adapter | mechanical | 1 retry | **yes** | same effort, packet | budget exhausted | duration + timeout |
| `runner_execution_failed` | adapter | mechanical | 1 retry | **yes** | retry + packet | budget exhausted | redacted raw + class |
| `malformed_runner_output` | schema | mechanical | existing repair loop | **yes** | re-prompt with problems | loop exhausted | problems list |
| `validation_unsatisfied` | `judgeValidation` | mechanical | retry + packet | **yes** | failing command + tail | budget exhausted | exit codes + tails |
| `acceptance_evidence_missing` | tree comparison | mechanical | retry + packet | **yes** | packet names the empty diff | budget exhausted | base tree, validated tree |
| `acceptance_evidence_unsatisfied` | per-AC evidence | mechanical | retry + packet | **yes** | packet names unmet ACs | budget exhausted | AC → evidence map |
| `scope_violation` | diff ∩ scope | mechanical | **no** | **yes** | none | review the out-of-scope paths | offending paths |
| `agent_blocked` | report parse | mechanical | **never** | yes | none | answer the question | agent's own reason |
| `merge_conflict` | Integrator | mechanical | re-attempt on new head | **no** | new base, packet | repeats after budget | conflicting paths |
| `integration_history_invalid` | reconciliation | mechanical | **no** | no | none | inspect the branch | expected vs actual head |
| `semantic_review_failed` | model verdict | **LLM advisory** | corrective round | n/a | findings → tasks | envelope or budget | findings with severity |
| `final_review_failed` | model verdict | **LLM advisory** | corrective round, in envelope | n/a | findings → tasks | outside envelope | findings + envelope verdict |
| `corrective_plan_invalid` | `checkPlan` + overlap | mechanical | mechanical repair | n/a | repair, re-validate | repairs exhausted | problem list per round |
| `corrective_plan_rejected` | plan reviewer | model | **no** | n/a | none | revise the plan | reviewer findings |

Two columns deserve emphasis. **`consumes attempt` is `no` for every
`PRE_EXECUTION` class** — that is I-22, and it is what makes `retry --force`
unnecessary in the evidence run's TASK-003. And **`Authority` is `mechanical` for 20 of
22 rows**: the two exceptions are review verdicts, which are advisory and whose
findings still re-enter as ordinary tasks through ordinary gates.

---

## 6. Autonomy budgets

Autonomy is bounded. Every budget is configurable, has a default, and its exhaustion
produces `AUTO_RECOVERY_EXHAUSTED` with the contract in §3.6.

### 6.1 Per task

| Budget | Default | Counts |
| --- | --- | --- |
| `retry.maxAttempts` | `2` (unchanged) | work attempts only (AD-37) |
| `recovery.maxEnvironmentRepairs` | `2` | preparation/environment repairs per task |
| `recovery.maxIdenticalFailures` | `2` | consecutive failures with identical `(class, command, exit)` |
| `recovery.maxModelCallsPerTask` | `4` | total AgentRunner invocations for one task, all attempts |

`maxIdenticalFailures` is the anti-thrash rule: an automatic loop that produces the
same failure twice has learned nothing and must stop, whatever the other budgets allow.

### 6.2 Per run

| Budget | Default | Counts |
| --- | --- | --- |
| `recovery.maxCorrectiveRounds` | `2` | corrective rounds per run |
| `recovery.maxCorrectivePlanRepairs` | `2` | mechanical repairs per corrective plan |
| `recovery.maxVerificationCycles` | `3` | full verification + review cycles |
| `recovery.maxAutonomousModelCalls` | `24` | AgentRunner calls made **without** an intervening human action |

`maxAutonomousModelCalls` is the global stop. The evidence run used 21 calls **with** a
human in the loop; an autonomous run that exceeds 24 without one has stopped converging.

### 6.3 Interaction with existing budgets

`maxRevisionCycles` (currently `2`, from the workflow class) is unchanged and is
**not** consumed by corrective rounds. Revisions are human-initiated re-planning;
corrective rounds are system-initiated correction. The evidence run exhausted
`maxRevisionCycles` on two hand-written revisions *before* implementation, and then
needed the corrective path afterwards — sharing one counter would have blocked it.

### 6.4 Scope expansion — the mechanical definition

A corrective round is **scope-preserving** when every generated task is inside the
AD-46 envelope. It is **scope expansion** when any task touches an untouched file,
cites a requirement the SDD does not declare, adds a contract file, or adds a validation
id. Scope expansion always requires human approval and is never inferred to be
harmless.

### 6.5 Context growth

| Budget | Default |
| --- | --- |
| `recovery.maxPacketBytes` | `8 KB` |
| `recovery.maxRawExcerptBytes` | `2 KB` |
| `recovery.maxDiffStatLines` | `40` |

A Failure Context Packet that exceeds its budget is **truncated with an explicit
marker**, never silently. Truncation order is fixed and reverse-priority:
`previousDiffStat`, then `successfulChecks`, then `rawExcerpt` — `failureClass`,
`failedChecks` and `acceptanceCriteria` are never truncated.

**Why these numbers are conservative.** A trivial AGY call in this environment already
reported ≈49 k input tokens, and the global rule block was truncated from ≈25 k to
≈24 k chars before Agent Flow contributed anything. Recovery context is therefore added
to a prompt that is already near a limit, which is why the packet is capped at 8 KB and
why `previousDiffStat` carries `--stat` rather than a patch. **Mechanical automation
comes before LLM automation, and every §5 row whose authority is `mechanical` spends
zero tokens.** AR-09 measures the ceiling rather than assuming it.

---

## 7. Normative contracts

Each contract is `GIVEN / WHEN / THEN`, mechanically testable, and free of model
judgement unless stated. These are the acceptance criteria of the milestones in §9.

### C-01 Uninitialised project (AR-01)

```
GIVEN   a directory with no .agent-flow/config.yaml
WHEN    `agent-flow feature "<x>"` or `agent-flow bug "<x>"` is invoked
THEN    a deterministic preflight refuses;
        0 AgentRunner invocations occur;
        0 model tokens are spent;
        0 runs are created — no directory under .agent-flow/runs/;
        HEAD is unchanged;
        stderr names the absent path and the single action "Run agent-flow init";
        the exit code is CONFIG_ERROR;
        the decision involves no LLM.
```

### C-02 `init` with an active run (AR-01)

```
GIVEN   a project with a run whose status is not completed or failed
WHEN    `agent-flow init` is invoked without --force
THEN    it warns that the active run's planningBase may be invalidated by the commit
        init's files require;
        it names the run id and its planningBase;
        it writes nothing;
        it exits GATE_NOT_SATISFIED;
        `--force` proceeds and records an `init_during_active_run` event on the run.
```

### C-03 Model/effort mismatch (AR-01)

```
GIVEN   role R configured runner=A model=M effort=E
  AND   A.capabilities(M).supportedReasoningLevels does not contain E
WHEN    the execution context resolves R
THEN    no AgentRunner is invoked with E;
        the effective effort is the nearest supported level below E, or A's minimum
        when none is below;
        reasoningClamped is true on the result and on every attempt artifact;
        a reasoning_clamped degradation records requested, effective, supported set
        and reason;
        no task attempt is consumed;
        the run proceeds;
        the decision involves no LLM.
```

### C-04 Permission not ready (AR-01)

```
GIVEN   role R resolves to a runner whose
        capabilities(M).nonInteractiveToolGrants.commandExecution is false
  AND   the stage's prompt declares permissions: 'write'
WHEN    preflight runs
THEN    a permission_not_ready finding is produced naming runner, model and tool class;
        `agent-flow doctor` reports it as a warning with the specific grant needed;
        execution is not blocked by the warning alone;
        no attempt is consumed by discovering it.
```

### C-05 Runner failure is diagnosable (AR-02)

```
GIVEN   an AgentRunner returning ok:false with errorCode C and raw text T
WHEN    the stage fails
THEN    logs/<stage>.log contains redact(T) in full;
        the stage_failed event carries failureClass, runner, model, reasoning,
        repair counter and rawExcerpt = first 2 KB of redact(T);
        tasks/<TASK>/attempt-<n>.failed.json exists and contains classification,
        provenance and evidence, and contains no agentReport;
        no persisted field contains an unredacted absolute path or credential;
        control flow branched only on C.
```

### C-06 Denied command is classified, not generic (AR-02)

```
GIVEN   a runner failure whose redacted raw output matches a permission-denial
        signature
WHEN    classification runs
THEN    failureClass is runner_permission_required, not runner_execution_failed;
        the denied command is extracted and persisted;
        recoverable is false and the escalation names the grant to add;
        attempts is NOT incremented;
        infrastructureFailures IS incremented;
        the classification is table-driven and involves no LLM.
```

### C-07 UI and CLI find the attempt log (AR-02)

```
GIVEN   a worktree-mode run with logs/implementation-<TASK>-attempt-<n>.log present
WHEN    the HTTP API is asked for that task's log
THEN    the contents are returned;
        the reader resolves the same name attemptLogName produces;
        a task with several attempts exposes each attempt's log separately.
```

*(Today `server/run-reader.ts:646` requests `implementation-<TASK>` while
`paths.ts:116` writes `implementation-<TASK>-attempt-<n>`, so this returns `[]` for
every worktree run.)*

### C-08 Retry carries failure context (AR-03)

```
GIVEN   task T failed with class F, failing command C exit X, and diff D
WHEN    T is requeued, automatically or manually
THEN    a FailureContextPacket is built mechanically and persisted;
        it contains F, C, X, the tail of C's output, D as --stat, T's acceptance
        criteria and a correctiveObjective;
        it contains no full patch;
        it is within maxPacketBytes, or is truncated with an explicit marker in the
        documented order;
        the next attempt's prompt contains it, appended, with the rendered prompt
        unchanged;
        the next attempt's workspace base is the current integration head.
```

### C-09 Infrastructure failure does not consume an attempt (AR-03)

```
GIVEN   task T with attempts = N
WHEN    T fails with any PRE_EXECUTION class
THEN    attempts is still N;
        infrastructureFailures is N' + 1;
        `agent-flow retry T` succeeds without --force while attempts < maxAttempts;
        the projection explains which counter moved and why.
```

### C-10 Verification workspace readiness (AR-04)

```
GIVEN   an integration worktree without installed dependencies
  AND   project.commands.install is configured
WHEN    `agent-flow review` runs
THEN    the worktree is prepared with assert-clean → install → assert-clean before
        any verification command runs;
        a workspace_prepared event records the install command and its exit code;
        the verification commands then run in a prepared tree.

GIVEN   the same, and install fails or is not configured
THEN    mechanical verification is NOT_RUN, never FAIL;
        the Definition of Done is not done, citing environment readiness — not a
        regression;
        Semantic Review and Final Review are not rendered as conclusions about the code;
        the escalation names the install command and its exit code.
```

### C-11 No contradictory verdicts (AR-04)

```
GIVEN   a review whose mechanical verification is FAIL or NOT_RUN
WHEN    any surface renders the outcome
THEN    the mechanical result and the model verdicts appear under distinct labels;
        no surface prints PASS as the run's headline;
        the Definition of Done is not done;
        NOT_RUN is visually distinct from FAIL.
```

### C-12 A task that changed nothing does not complete (AR-05a)

```
GIVEN   an attempt whose receipt.validatedTree equals its workspace base tree
  AND   the task's plan entry does not declare expectsNoChange
WHEN    the task result is finalised
THEN    the status is review_required, never completed;
        failureClass is acceptance_evidence_missing;
        the task is NOT integrated;
        the evidence records both tree hashes;
        the decision involves no LLM.

GIVEN   the same, with expectsNoChange: true declared
THEN    the task may complete, and the empty diff is recorded as expected.
```

### C-13 Scope containment (AR-05a)

```
GIVEN   an attempt whose mechanical diff contains a path outside the task's
        files.likely
  AND   the task does not declare scopeMode: 'open'
WHEN    the task result is finalised
THEN    the status is review_required;
        failureClass is scope_violation;
        the offending paths are persisted;
        the escalation names them;
        recovery is not attempted automatically.
```

### C-14 RED tasks prove they wrote something (AR-05a)

```
GIVEN   a task with validationExpectation: 'fail'
WHEN    its validation does not pass
THEN    the judgement is satisfied only if the mechanical diff is non-empty;
        an empty diff yields acceptance_evidence_missing;
        and the acceptance record states which new test failed, not merely that the
        suite failed.
```

*(This is D-2. Today `judgeValidation` sees only `{passed, ran}`, so TASK-002 was
credited for a suite TASK-001 had already reddened.)*

### C-15 Per-AC evidence (AR-05a)

```
GIVEN   a task with acceptance criteria AC-1..AC-n
WHEN    the attempt is recorded
THEN    the artifact contains an acceptance map from each AC to its evidence —
        a validation id and exit code, a diff path, or explicitly "no mechanical
        evidence";
        a task whose declared required evidence is absent yields
        acceptance_evidence_unsatisfied;
        an agent's claim is never accepted as an AC's evidence.
```

### C-16 Corrective plan safety (AR-06)

```
GIVEN   findings F1..Fn producing corrective tasks
WHEN    the corrective plan is generated
THEN    any two tasks with intersecting files.likely are ordered by dependency;
        complexity is derived from the work's shape, not the finding's severity;
        checkPlan and the overlap guard both pass before a reviewer is called;
        a failing plan is mechanically repaired up to maxCorrectivePlanRepairs and
        re-validated;
        a still-invalid plan escalates rather than being sent to a reviewer.
```

### C-17 Overlap in a wave (AR-06)

```
GIVEN   tasks A and B, mutually independent, with intersecting files.likely
WHEN    both become ready in the same pass
THEN    checkPlan reported the overlap at planning time;
        the scheduler places them in different waves;
        a wave_serialised_for_overlap event names both tasks and the shared paths;
        no dependency edge is injected into the approved plan.
```

### C-18 Bounded corrective autonomy (AR-05b)

```
GIVEN   an approved run whose final review failed
  AND   every corrective task is inside the AD-46 envelope
  AND   maxCorrectiveRounds is not exhausted
WHEN    the corrective round runs
THEN    approval is NOT cleared;
        the envelope evaluation is persisted per task with the reason it passed;
        the corrective plan is still reviewed in its own right;
        execution proceeds without human action.

GIVEN   any corrective task outside the envelope
THEN    approval IS cleared;
        the run reports which task, which condition, and why;
        no corrective work executes before human approval.
```

### C-19 Resume is offered only when work exists (AR-07)

```
GIVEN   a run whose only incomplete task is in review_required
WHEN    status is projected for the CLI or the API
THEN    resumable is false;
        no surface offers "Resume run";
        the projection names the gate and the one action that clears it;
        invoking run anyway is refused before the execution lock is taken.
```

*(The evidence run took and released the lock three times with nothing runnable.)*

### C-20 No stale review (AR-07)

```
GIVEN   a review artifact written at T1 and a planning stage started at T2 > T1
WHEN    status is projected
THEN    the review is marked superseded and is not presented as current;
        the projection reports the in-flight stage;
        plan_rejected is not shown as the headline while a revision is running.
```

### C-21 Distinct progress axes (AR-07)

```
GIVEN   a run with 6 of 6 tasks integrated, verification pending, and 3 corrective
        tasks appended
WHEN    progress is projected
THEN    workflow progress, implementation progress and corrective progress are three
        values;
        no axis reports 100% while a later stage is pending;
        appending corrective tasks does not make a previously-reported percentage fall.
```

### C-22 Bounded termination (AR-00, all)

```
GIVEN   any automatic recovery loop
WHEN    a budget in §6 is exhausted
THEN    the loop terminates;
        the runtime status is auto_recovery_exhausted;
        the projection carries class, counts, redacted evidence, every repair
        attempted, why each failed, and one specific human action;
        no surface renders the message "something failed, inspect logs".
```

---

## 8. Persisted schema changes

**Schema changes are required.** All are additive, all defaulted, and every existing
`state.json`, `attempt-<n>.json` and `result.json` continues to parse. `RunEventSchema.detail`
is an open record, so event enrichment needs no migration.

### 8.1 `TaskProgressSchema` — `contracts/state.schema.ts`

```ts
attempts: z.number().int().min(0).default(0),                 // unchanged, narrowed meaning
infrastructureFailures: z.number().int().min(0).default(0),   // NEW  (AD-37)
failureClass: FailureClassSchema.optional(),                  // NEW  (AD-36)
lastFailureAt: IsoTimestampSchema.optional(),                 // NEW
```

### 8.2 `RunStateSchema`

```ts
autonomy: z.object({                                          // NEW  (AD-46)
  correctiveRoundsUsed: z.number().int().min(0).default(0),
  autonomousModelCalls: z.number().int().min(0).default(0),
  grantedAt: IsoTimestampSchema.optional(),
}).optional(),
```

`RUN_STATUSES` is unchanged (AD-48). `DEGRADATION_KINDS` is unchanged — AD-31 reuses
`reasoning_clamped`.

### 8.3 `TaskSchema` — `contracts/task.schema.ts`

```ts
expectsNoChange: z.boolean().optional(),                      // NEW  (AD-38)
scopeMode: z.enum(['declared', 'open']).optional(),           // NEW  (AD-38)
requiredEvidence: z.array(z.string()).optional(),             // NEW  (C-15)
```

**The containment mode is `scopeMode`, not `scope`.** `Task.scope` is a pre-existing
free-form module or domain label — plans carry values such as `"backend"`, `"docs"` and
`"infra"`, and nothing branches on it. Redefining that key as a two-value enum would break
backward compatibility, including the AF-2026-002 fixtures this section requires to keep
parsing, so the recovery contract takes a new field instead.

**Absent `scopeMode` means `declared`.** Containment is the default: a plan written before
this field existed is not thereby granted an open scope. This is deliberately *not* the
three-state treatment `isolationMode` receives — there, absent means "predates the question"
and nothing may promote it, because isolation is a promise about how a run executed. Scope
containment is an assertion made *about* a diff after the fact, so the safe reading of
silence is the strict one.

### 8.4 New artifact — `tasks/<TASK>/attempt-<n>.failed.json` (AD-34)

```ts
{ run, task, attempt, base, branch, workspace,
  runner, model?, reasoning, reasoningClamped, fallback?,
  startedAt, finishedAt,
  failureClass, runnerErrorCode?,
  rawExcerpt?,                     // redacted, ≤ maxRawExcerptBytes
  validation?: { expectation, passed, ids, commands },
  repairAttempts,                  // StageRunner's internal counter, renamed
  consumedAttempt: boolean }       // the AD-37 decision, recorded
```

No `agentReport` field exists in this schema. That is the invariant §17.3 relies on,
preserved.

### 8.5 New artifact — `tasks/<TASK>/attempt-<n>.context.json` (AD-40)

The `FailureContextPacket` handed to attempt *n*, so a run can always show what a retry
was told.

### 8.6 `AttemptRecord` — `contracts/attempt.schema.ts`

```ts
filesChanged: z.array(z.string()),                            // now mechanical (AD-39)
agentReport: z.object({
  status, notes, deviations,
  claimedFilesChanged: z.array(z.string()).default([]),       // NEW: the model's claim
}),
acceptance: z.array(z.object({                                // NEW  (C-15)
  criterion: z.string(),
  evidence: z.discriminatedUnion('kind', [ /* validation | diff | none */ ]),
})).default([]),
treeComparison: z.object({                                    // NEW  (AD-38)
  baseTree: z.string(), validatedTree: z.string(), identical: z.boolean(),
}).optional(),
```

Also: `agentReport` is normalised to an object by the schema and by the single writer. The
historical string-vs-object divergence originally cited here was **not reproducible**: all
inspected AF-2026-002 attempt artifacts store an object. The object invariant remains
mechanically enforced — a reader that has to sniff whether it received an object or a string
holding one will eventually guess wrong, whether or not that has already happened.

### 8.7 `verification.json` (AD-45)

```ts
{ mechanical: { verdict: 'PASS'|'FAIL'|'NOT_RUN',             // NEW section
                commands: CommandResult[], skipped: string[],
                workspacePrepared: boolean, notRunReason?: string },
  semantic:   { verdict: 'PASS'|'FAIL', findings, summary } }  // today's top level
```

Readers must accept the legacy flat shape. `DoneInput.verificationPassed: boolean`
becomes `mechanicalVerification: 'PASS'|'FAIL'|'NOT_RUN'`.

### 8.8 New event types

`workspace_prepared` · `workspace_preparation_failed` · `task_failure_classified` ·
`recovery_started` · `recovery_step_completed` · `recovery_exhausted` ·
`environment_repaired` · `failure_context_built` · `wave_serialised_for_overlap` ·
`corrective_plan_repaired` · `corrective_envelope_evaluated` ·
`init_during_active_run`

### 8.9 Ports

```ts
capabilities(model?: string): RunnerCapabilities                   // AD-30
RunnerCapabilities.nonInteractiveToolGrants: {...}                 // AD-32
```

`RunnerCapabilitiesMap` becomes a resolver rather than a record — the single call-site
change, in `core/role.ts`.

---

## 9. Milestones

The proposed AR-00…AR-10 split is **adopted with three changes**, each forced by the
evidence rather than by preference.

**Change 1 — AR-05 is split, and the acceptance half moves first.** The original AR-05
was "Autonomous Corrective Loop". But §0.2 shows the corrective loop was *cleaning up
after* false-positive acceptance: three tasks were credited for work never done, and the
final review then failed for exactly that. Automating correction before closing
acceptance would build an autonomous loop whose job is to repair damage the system is
still creating. **AR-05a (Acceptance Integrity) is the first milestone after AR-00.**

**Change 2 — AR-06 (DAG safety) lands before AR-05b (corrective loop).** AD-42 removes
the defect that produced the rejected corrective plan. Building the loop first means
building it around a generator known to emit conflicting tasks.

**Change 3 — AR-08 is narrowed and AR-07 absorbs the state work.** Every observability
defect in the evidence run is a missing projection, not a missing widget. Once AR-07
lands one projection consumed by both surfaces, what remains in AR-08 is genuinely
cosmetic — and cosmetic UI is explicitly out of scope for this milestone (§12).

### Dependency order

```
AR-00 ──► AR-01 ──► AR-02 ──► AR-05a ──► AR-06 ──► AR-03 ──► AR-04 ──► AR-05b ──► AR-07 ──► AR-09 ──► AR-10
             │         │          │                    │
             │         └──────────┴────────────────────┘   AR-03 needs AR-02's evidence
             └─ C-01..C-04 independent of everything else       and AR-05a's assertions
```

---

### AR-00 — Contracts, vocabulary and probes

**Objective.** Land every contract, schema and pure module the rest depends on, plus
the empirical probe the AGY adapter never got. No behaviour change.

**Files.** `contracts/{common,state,task,attempt,result,review}.schema.ts` ·
`ports/agent-runner.ts` · new `core/failure-classification.ts`,
`core/evidence-redaction.ts`, `core/recovery-policy.ts`, `core/run-projection.ts` ·
`docs/runner-capabilities.md`

**Contracts.** §8 in full. `FailureClassSchema` with the §3 mapping to
`RunnerErrorCode`. `capabilities(model?)`. `nonInteractiveToolGrants`.

**Invariants.** I-20 … I-26 declared and covered by architecture tests.

**Acceptance.**
- Every §8 schema change parses every existing artifact in `.agent-flow/runs/`
  unchanged — asserted against the AF-2026-002 fixtures.
- `FailureClass` → `RunnerErrorCode` is total and single-valued; an architecture test
  forbids branching on both.
- `redactEvidence` removes worktree-absolute paths, home paths and each documented
  credential shape; property test asserting no output contains the input's secrets.
- `agentReport` is always persisted as an object, enforced by the schema and by the single
  writer, so a string-vs-object divergence cannot arise (§8.6).
- `StageRunner`'s internal counter is `repair` in every log and event **it writes**, and both
  readers accept either spelling so an existing run keeps its numbers. `attempt` means §4.4's
  definition in everything the state machine persists. The read-model field names
  (`TelemetryEntry.attempts`, `StageViewResponse.attempts`) still carry the repair count for
  stages and are renamed by AR-07 (§4.4).
- **`docs/runner-capabilities.md` gains an AGY section with measured per-model
  reasoning levels**, matching the empirical form the Claude Code and Codex sections
  already use. This is the omission that caused the evidence run's first failure.

**Tests.** Unit for the three new pure modules; contract tests over real fixtures;
architecture test for the taxonomy boundary.

**Migration.** None — additive and defaulted.

**Non-goals.** No behaviour change. No new preflight. No recovery.

---

### AR-01 — Readiness preflight

**Objective.** Nothing knowable before invocation costs a token or an attempt.

**Files.** `app/run-git-identity.ts` (extend `checkPlanningPreflight`) ·
`core/role.ts` · `app/execution-context.ts` · `cli/{init,doctor}.ts` · all four
adapters

**Contracts.** C-01, C-02, C-03, C-04.

**Invariants.** I-20, I-22.

**Acceptance.**
- Uninitialised project: 0 runner calls, 0 tokens, 0 runs, HEAD unchanged, one
  actionable sentence — reproducing AF-2026-001's exact starting condition.
- `checkPlanningPreflight` also runs in sequential mode. Today it returns `SATISFIED`
  immediately when `useWorktrees` is false, so a sequential run gets no preflight at all.
- Model/effort mismatch clamps, records the degradation, consumes no attempt, and the
  run proceeds — reproducing TASK-002 attempt 1 with `medium` against a model offering
  `low`/`high`.
- `doctor` reports capability discovery **mechanically** by default. Real probes stay
  behind the existing opt-in flag, and the probe is extended to exercise **each
  configured effort** and a minimal tool-use, because `probeRunner` currently uses
  `cheapestReasoning` and would never have exercised `medium`.
- `init` refuses with an active run unless forced.

**Tests.** `test/cli/lifecycle-preflight.test.ts` extended; a fake runner whose
`capabilities(model)` differs per model; `doctor` snapshot tests.

**Migration.** A previously-fatal configuration now clamps. Announced in the release
notes as an intentional change.

**Non-goals.** No failure classification of runtime failures (AR-02). No retry change.

---

### AR-02 — Failure intelligence and evidence

**Objective.** No failure is ever reported only as `execution_failed`.

**Files.** `app/stage-runner.ts` · `app/task-executor.ts` · `app/attempt-receipt.ts` ·
`server/run-reader.ts` · `cli/render/errors.ts`

**Contracts.** C-05, C-06, C-07.

**Invariants.** I-21.

**Acceptance.**
- `stage_failed` carries `failureClass`, provenance and a redacted `rawExcerpt`; the
  stage log carries the full redacted raw.
- `attempt-<n>.failed.json` exists for every failed attempt — the two missing files
  from the evidence run are produced when it is replayed.
- The AGY permission denial classifies as `runner_permission_required`, extracts the
  denied command, and escalates with the grant to add. Replayed from a stored raw
  fixture, so no quota is spent.
- `readTaskLog` resolves `attemptLogName`; a task with three attempts exposes three logs.
- No persisted field contains an unredacted absolute path or credential — asserted over
  every artifact a full test run produces.

**Tests.** Fixtures under `test/fixtures/responses/agy/` for the denial, an unsupported
effort and a quota error, following the existing per-runner fixture convention;
redaction property tests; a server test that reads a real attempt log.

**Migration.** Additive.

**Non-goals.** No automatic retry (AR-03). No UI beyond the log fix.

---

### AR-05a — Acceptance integrity

**Objective.** A task cannot be completed without mechanical evidence that it did its
work. **This is the milestone that recommends itself first after AR-00/AR-01/AR-02.**

**Files.** `core/validation-outcome.ts` · `core/validation-registry.ts` ·
`app/task-executor.ts` · `app/attempt-receipt.ts` · `app/integrator.ts` ·
`contracts/task.schema.ts`

**Contracts.** C-12, C-13, C-14, C-15.

**Invariants.** I-23.

**Acceptance.**
- Replaying AF-2026-002's attempt data, **TASK-002, TASK-005 and TASK-006 do not reach
  `completed`** — each yields `acceptance_evidence_missing` with both tree hashes
  recorded. This is the milestone's decisive test.
- **TASK-003 yields `scope_violation`**, naming the four paths outside
  `files.likely`.
- A RED task with an empty diff is never `satisfied`, whatever the suite's exit code.
- `judgeValidation` gains the diff and the acceptance map as inputs; the asymmetric
  RED/GREEN rules it already encodes are preserved unchanged.
- Every attempt artifact carries an acceptance map; an AC with no mechanical evidence
  says so explicitly rather than being absent.
- A verification-only task declaring `expectsNoChange: true` completes with an empty
  diff.

**Tests.** `test/core/validation-outcome.test.ts` extended for the empty-diff cases;
an integration test replaying the AF-2026-002 attempt fixtures and asserting the three
demotions; `test/app/integrator.integration.test.ts` asserting a demoted task is not
integrated.

**Migration.** **The only behaviour change in this milestone that can stop a run that
previously completed** — deliberately, because such a run was completing on unproven
work. Plans generated before this milestone stay planning-valid; a task that does
nothing now stops.

**Non-goals.** No corrective loop. No retry automation.

---

### AR-06 — DAG and conflict safety

**Objective.** Two tasks never contend for one file, and corrective plans are born
valid.

**Files.** `core/corrective-plan.ts` · `app/stages/planning-checks.ts` ·
`app/scheduler.ts` (`core/dag.ts` stays file-agnostic)

**Contracts.** C-16, C-17.

**Acceptance.**
- Replaying the AF-2026-002 final review, **FIX-002 depends on FIX-001** (both target
  `test/cli/cli.test.ts`), and FIX-003 depends on both, being the global gate.
- Complexity comes from work shape: the three fixes classify `trivial`/`normal`, not
  three `complex` derived from three `high` findings.
- `checkPlan` reports mutually-independent tasks with intersecting `files.likely`.
- The scheduler never places two overlapping tasks in one wave, and records
  `wave_serialised_for_overlap` when it serialises.
- No dependency edge is ever injected into an approved plan.
- An architecture test asserts `DagNode` has no file-shaped field.

**Tests.** `test/core/corrective-plan.test.ts` for overlap ordering and complexity;
`test/app/planning-checks.test.ts` for the guard; `test/app/parallel-wave.integration.test.ts`
for the wave constraint.

**Migration.** `checkPlan` can now reject plans that previously validated — which is
the guard working.

**Non-goals.** No automatic dependency injection into approved plans. No conflict
*resolution*, only prevention.

---

### AR-03 — Autonomous retry and the Failure Context Packet

**Objective.** A recoverable failure recovers itself, informed by what actually
happened.

**Files.** `app/run-actions.ts` · `app/task-executor.ts` · `app/scheduler.ts` ·
new `app/recovery-coordinator.ts` · `core/recovery-policy.ts`

**Contracts.** C-08, C-09, C-22.

**Invariants.** I-22.

**Acceptance.**
- A `validation_unsatisfied` failure requeues automatically with a packet naming the
  failing command, its exit code and its output tail — no human action.
- The packet is mechanical: an identical failure produces a byte-identical packet.
- It never contains a patch, and respects `maxPacketBytes` with documented truncation
  order.
- The next attempt branches from the integration head (AD-41 unchanged).
- Replaying TASK-003: attempt 1 (`validation_unsatisfied`) consumes an attempt; attempt
  2 (`runner_permission_required`) does **not**; `retry --force` is never required.
- Every §6.1 budget terminates its loop; `maxIdenticalFailures` stops a loop producing
  the same failure twice.
- **`recovery.enabled: false` restores today's behaviour exactly** — the scheduler's
  standing rule that it never retries on its own remains available as configuration.

**Tests.** `test/app/retry-attempts.integration.test.ts` extended;
`test/app/recovery-coordinator.test.ts` for each §5 row with a fake runner; a
budget-exhaustion test asserting the C-22 escalation shape.

**Migration.** Automatic retry is new behaviour and is why the kill switch above is a
required acceptance criterion.

**Non-goals.** No corrective rounds. No environment repair beyond re-preparation
(AR-04).

---

### AR-04 — Verification environment readiness

**Objective.** Verification answers a question about the code, never about the
environment.

**Files.** `app/run-actions.ts` · `app/task-workspaces.ts` (extract the sequence) ·
`app/integrator.ts` · `core/definition-of-done.ts` · `cli/review.ts` ·
`app/verification-commands.ts`

**Contracts.** C-10, C-11.

**Invariants.** I-24.

**Acceptance.**
- The integration worktree goes through assert-clean → `install` → assert-clean before
  any verification command, using the **same extracted function** as task workspace
  preparation. An architecture test forbids a second implementation.
- Replaying AF-2026-002's `review`: the four exit 127s do not occur; if install fails,
  mechanical verification is `NOT_RUN` and the escalation names the install command and
  exit code.
- `NOT_RUN` makes the Definition of Done `not done`, citing environment readiness, and
  suppresses both model verdicts as conclusions about the code.
- **No surface prints `Verification: PASS` beneath failing mechanical checks** — the
  exact contradiction the evidence run showed.
- `install` is **not** in `VERIFICATION_ORDER`.
- A project with no install command is unaffected: preparation is a no-op and
  verification runs as today.

**Tests.** `test/app/review-run.integration.test.ts` for prepared and unprepared trees;
`test/core/definition-of-done.test.ts` for the three-valued input;
`test/cli/ui.test.ts` snapshot asserting no contradictory rendering.

**Migration.** First `review` in a worktree becomes slower by one install; `review` can
now refuse before spending two model calls.

**Non-goals.** No shared or cached `node_modules` (§12).

---

### AR-05b — Autonomous corrective loop

**Objective.** A final review FAIL becomes corrected work without human debugging,
inside a mechanically-decided envelope.

**Files.** `app/corrective-round.ts` · `app/run-actions.ts` · `app/approval.ts` ·
`contracts/state.schema.ts`

**Contracts.** C-18, C-22.

**Invariants.** I-25.

**Acceptance.**
- Findings → corrective tasks → mechanical sanity → repair if needed → envelope
  evaluation → plan review → execute → re-verify, with zero human actions when every
  task is inside the envelope.
- The envelope is computed by set arithmetic over the integration diff and the SDD's
  requirement ids; each evaluation is persisted with its reason.
- Replaying AF-2026-002's three findings: all three are **inside** the envelope (they
  touch `test/cli/cli.test.ts` and `scripts/packaging-smoke.mjs`, both already changed
  by the run, and cite FR-005, FR-006 and NFR-004, all declared by the SDD), so the
  round proceeds without reopening approval.
- A synthetic finding requiring a new file under `src/contracts/` is **outside** the
  envelope and reopens approval, naming the task and the failed condition.
- A reviewer-rejected corrective plan escalates and is never self-answered.
- `maxCorrectiveRounds` exhaustion produces the C-22 escalation.
- A corrective task can never grant a permission or alter a Git safety rule.

**Tests.** `test/app/corrective-round.test.ts` for envelope inside/outside;
`test/app/run-actions.gate.test.ts` asserting approval is not cleared for an
inside-envelope round; an end-to-end test over the AF-2026-002 findings.

**Migration.** Moves a gate. Guarded by I-25, by persistence of every evaluation, and
by the budget.

**Non-goals.** No model-authored repair of a reviewer-rejected plan. No autonomous
scope expansion.

---

### AR-07 — Runtime state projection and human gates

**Objective.** One projection, two surfaces, no misleading state.

**Files.** new `core/run-projection.ts` · `server/run-reader.ts` · `server/server.ts` ·
`cli/status.ts` · `cli/ui.ts` · `core/stage-timeline.ts`

**Contracts.** C-19, C-20, C-21.

**Invariants.** I-26.

**Acceptance.**
- `resumable` is derived from the DAG; `Resume` is offered if and only if it is true,
  and `run` refuses **before** taking the execution lock otherwise — removing the
  evidence run's three empty lock cycles.
- A superseded review is never presented as current; `plan_rejected` is not the
  headline while a revision runs.
- `APPROVED` is not the headline during implementation.
- Three progress axes; none reports 100% with a later stage pending; appending
  corrective tasks never makes a reported percentage fall.
- The CLI and the HTTP API derive status from the same pure function — asserted by an
  architecture test.
- A failure card carries runner, model, effort, `failureClass` and attempt history.
- `View as DAG` is offered only once an implementation DAG exists.

**Tests.** `test/core/run-projection.test.ts` over persisted fixtures including
AF-2026-002; `test/server/isolation-read-model.test.ts` extended; CLI snapshots.

**Migration.** No persisted change.

**Non-goals.** No visual redesign. No i18n completion. No new dashboard views.

---

### AR-08 — Recovery UX and CLI ergonomics

**Objective.** Present what AR-07 projects, and remove the shell-quoting hazard.

**Files.** `cli/{status,ui,review}.ts` · `cli/render/errors.ts` · `cli/feature.ts` ·
`ui/`

**Contracts.** Rendering contracts only; no new engine behaviour.

**Acceptance.**
- `agent-flow revise --file <path>`, `--edit`, and `-` for stdin. The evidence run
  passed multi-paragraph instructions as shell arguments twice.
- Recovery is legible: what failed, what was tried, what it cost, what is next.
- `AUTO_RECOVERY_EXHAUSTED` renders the full C-22 contract.
- Attempt history is visible per task, with each attempt's log.
- Artifacts have a copy action.

**Non-goals.** **The evidence run's cosmetic defects are explicitly deferred**:
PT-BR completeness, the approval/revise modal, colour and hierarchy work. This
milestone renders recovery state and nothing else.

---

### AR-09 — Cost and context controls

**Objective.** Autonomy must not be bought with context explosion.

**Files.** `core/context-telemetry.ts` · `app/context-telemetry-recorder.ts` ·
`core/hierarchical-context-compressor.ts` · `app/prompt-loader.ts`

**Acceptance.**
- Per-stage measurement of prompt bytes attributable to: Agent Flow's own prompt, the
  advisory block, `AGENTS.md`, and the Failure Context Packet.
- Every §6.5 budget enforced, with explicit truncation markers.
- A recovered task's total token cost is reported against a first-attempt baseline.
- **The trivial executor's context is measured and reported**; a `trivial` role
  receiving more than a documented ceiling is a warning. The ≈49 k input tokens
  measured for a one-`grep` AGY call is the reason this milestone exists.
- Every §5 row whose authority is `mechanical` is asserted to spend **zero** model
  calls.

**Non-goals.** No change to MVP 3's advisory context. No prompt rewriting.

---

### AR-10 — Dogfood and autonomy benchmark

**Objective.** Prove the milestone against a real feature, measured.

**Acceptance.** §10 in full.

---

## 10. Dogfood acceptance plan

### 10.1 The scenario

Re-run the AF-2026-002 request — add `agent-flow bug "<description>"` — on a clean
checkout, with **deliberately seeded recoverable failures**, so the recovery paths are
exercised rather than merely available:

1. **Uninitialised project.** Invoke `feature` before `init`. Expect refusal, 0 tokens,
   0 runs, unchanged HEAD.
2. **`init`, then approve.** One human action: `approve`.
3. **Seeded model/effort mismatch.** Configure `executor.normal` at an effort the
   selected model does not support. Expect a clamp, a degradation, no consumed attempt,
   and no human action.
4. **Seeded environment gap.** Remove `node_modules` from the integration worktree
   before `review`. Expect automatic preparation, or `NOT_RUN` with a specific
   escalation — never four exit 127s under a `PASS` headline.
5. **Seeded validation failure.** Let one task fail its validation. Expect automatic
   retry with a packet naming the failing command, and recovery without human action.
6. **Seeded empty-diff task.** Let one agent report `COMPLETED` while changing nothing.
   Expect `acceptance_evidence_missing`, no integration, and automatic recovery.
7. **Corrective round.** Let the final review produce findings inside the envelope.
   Expect corrective tasks with overlap-derived dependencies, a passing plan review,
   execution and re-verification — with no human action.
8. **Final acceptance.** One human action: accept and merge.

### 10.2 Pass criteria

| Metric | Target |
| --- | --- |
| Manual interventions during implementation | **0** |
| Manual log inspection | **0** |
| Manual config debugging | **0** |
| Manual retry decisions | **0** |
| Manual corrective-plan editing | **0** |
| Hidden runner failures | **0** |
| Known preflight failures consuming a runner attempt | **0** |
| Recovery loops without bounded termination | **0** |
| Mechanical failures reported only as `execution_failed` | **0** where a class is known |
| Human actions total | **2** — `approve` and final acceptance |
| Tasks completed with an empty diff and no `expectsNoChange` | **0** |
| Contradictory verdicts rendered | **0** |

### 10.3 Comparative metrics, measured against AF-2026-002

| Metric | AF-2026-002 | Target |
| --- | --- | --- |
| Wall clock | 244 min | ≤ 90 min |
| Model time share | 23% | ≥ 70% |
| Manual operations | 16 | ≤ 3 |
| Manual operations after approval | 11 | **0** |
| Model calls | 21 | ≤ 24 (§6.2 ceiling) |
| Tasks credited without producing change | 3 of 6 | **0** |
| `retry --force` uses | 1 | **0** |

### 10.4 Continuous metrics to publish

Mean recovery attempts per recovered task · model calls per successfully completed
task · tokens per recovery · **share of recovery decisions taken mechanically vs by
LLM** (target ≥ 90% mechanical) · share of tasks requiring human intervention ·
recovery success rate by `FailureClass`.

The mechanical-vs-LLM share is the metric that keeps this milestone honest. If it
falls, autonomy is being bought with model calls rather than with engineering.

---

## 11. Security model — preserved and extended

Unchanged and non-negotiable:

- **Mechanical evidence outranks model claims.** AD-38 and AD-39 *strengthen* this:
  `filesChanged` and task completion move from model prose to Git object identity.
- Model output never becomes shell execution. Validation ids still resolve against
  human-authored configuration; `commands.install` is configuration, not generation.
- No destructive Git. No force-push. Worktree isolation intact. A retry still branches
  from the integration head.
- Secrets are never persisted — now enforced by an explicit redaction contract (AD-35)
  covering three new evidence channels.
- `degraded` is never a silent `PASS`. AD-45's `NOT_RUN` closes the one path where it
  was.

The recovery engine may never accept **"I fixed it"**. It requires exit codes,
validation outputs, tree hashes, Git state, required artifacts, structured evidence and
canonical transitions.

An LLM may propose a correction, classify semantically, phrase a corrective objective,
or analyse a failure. An LLM never decides whether a command passed, whether a merge
happened, whether a branch is clean, whether validation passed, whether required
evidence exists, or whether a destructive permission is granted.

**The UtilityModel's role in this milestone is none.** It remains what MVP 3 made it:
optional, advisory, untrusted, and incapable of failing the workflow. No decision in §5
may be routed to it, and an architecture test must assert that `core/recovery-policy.ts`
and `core/failure-classification.ts` have no dependency on `ports/utility-model.ts`.

---

## 12. Non-goals and deferred items

**Non-goals.** Reopening MVP 3 · replacing AgentRunner with UtilityModel · putting a
model in any mechanically-decidable decision · shell from model output · removing
worktree isolation · removing human approval · relaxing Git safety · force-push ·
persisting secrets · making AGY a core dependency · Gemini-specific architecture ·
making the UI a source of truth · unbounded retry · masking failures · treating
`degraded` as a silent `PASS` · fixing the evidence run's cosmetic UI defects.

**Deferred, with the reason.**

| Item | Why deferred |
| --- | --- |
| Shared or cached `node_modules` across worktrees | Correctness risk (hoisting, platform binaries, lockfile drift) and it would make one attempt's install observable to another. Real cost: ~2.5 GB in the evidence run. Needs its own design. |
| Hybrid clamp/refuse by role criticality | Two policies where one suffices today; the boundary must be justified role by role. Revisit if a degraded reviewer is ever observed missing a finding. |
| `approve --auto-correct=N` per-run autonomy grant | AD-46's envelope makes the *scope* question mechanical; this would refine the *budget*. Additive later. |
| Model-authored repair of a reviewer-rejected corrective plan | Lets the system talk past its own gate. Needs a mechanical arbiter first. |
| PT-BR completeness, modal redesign, colour and hierarchy | Cosmetic; AR-08 renders recovery state only. |
| Per-command validation expectations | `judgeValidation` already documents this limitation; AR-05a's diff assertion closes the case that mattered. |
| Planner guidance against unpaired RED tasks | The MVP 2 rule says a module's tests and implementation belong in one task, which is a *planning* improvement. AR-05a's C-14 makes the failure mode detectable regardless, and the guard must exist even if the planner improves. Revisit as a planning-prompt change with its own evidence. |
