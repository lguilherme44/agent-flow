# Model, role, runner, agent — four facts, and which one the dashboard leads with

Issue #21 asks for one thing: when an operator watches a run, the screen should answer
**what model is doing this work** before it answers why Agent Flow assigned the work that
way.

The audit that came first found that Agent Flow mostly already knows the answer, and that
the one surface where it does not know is the one an operator actually watches. The first
draft of this document got that backwards; what follows is what survived being refuted.

---

## The four facts, and where each is decided

```text
Role      executor.normal      the workflow's question: what kind of work is this
Runner    claude               the CLI Agent Flow spawned
Agent     backend-1            the team member the router gave it to
Model     claude-opus-5        what the invocation was pointed at
```

They are four columns of one row, and collapsing any two of them loses a question
somebody asks. `role` explains a routing decision; `runner` explains an executable and an
auth story; `agent` explains capacity and ownership; `model` explains the work.

The dashboard used to collapse two of them by accident: the task inspector's metadata row
read `Agent: claude`, which is the *runner*. One label, and it belonged to neither fact.

---

## Where a model can be configured — four places, two of which reach a record

```text
roles.<role>.model        RoleConfigSchema.model        → resolveRole → the record
teams.members[].model     TeamMember.model              → resolveRole → the record
runners.<id>.model        RunnerConfigSchema.model      → the adapter. Nothing records it.
(nothing)                 openai-compatible sends the literal string 'default'
```

`src/core/role.ts:225` is the seam, and it reads two of the four:

```ts
const model = member?.model ?? roleConfig.model;
```

`runners.<id>.model` (`src/contracts/config.schema.ts:41`) is handed straight to the
adapter by `src/adapters/runners/registry.ts:117` and used at
`src/adapters/runners/openai-runner.ts:187` — `model: input.model ?? this.model ?? 'default'`.
`resolveRole` never reads it; `rg -n "runnerConfig" src/core/role.ts` shows it consulted
for existence and `enabled` only.

**Two consequences worth stating rather than discovering.** `role.ts:228-231` claims to
resolve "with the model that will actually be used, which is the whole of AD-30" — that
sentence is false for an openai-compatible runner carrying its own model, and
`capabilitiesOf(capabilities, runnerId, model)` is then called with `undefined` where a
model id exists. And nothing tests the request body: `test/adapters/openai-runner.test.ts`
captures every request and never asserts `body.model`.

Neither is fixed here. This milestone changes no routing, no assignment and no resolution
— but a document that said "one seam, and it was already the only one" would be wrong, and
that is how the first draft of this file came to assert something unprovable.

---

## Where the model is persisted

At the moment of execution, in the artifact that records it — **three artifacts and two
schemas**, which is one more of each than it is comfortable to assume:

| artifact | schema | read onto | written by |
|---|---|---|---|
| `<task>/result.json` | `TaskResultSchema` | `TaskSummaryView.model` | `task-executor.ts`, `integrator.ts` |
| `attempt-<n>.json` | `TaskAttemptResultSchema` | `AttemptHistoryView.model` | `attempt-receipt.ts` |
| `attempt-<n>.failed.json` | `FailedAttemptSchema` | `AttemptHistoryView.model` | `task-executor.ts` |
| `events.jsonl` stage details | — | `StageViewResponse.model` | `stage-runner.ts` |

`attempt-<n>.failed.json` supplies most rows of a retried task's history, and an audit
that enumerates "TaskResult / attempt-`<n>`.json" reads as exhaustive and is not.

### What actually guarantees historical accuracy

`src/server/run-reader.ts` fills every one of those from a file on disk. No reader
re-resolves a model from configuration, and `test/architecture.test.ts` pins the only two
modules allowed to write a `TaskResult`.

But the reader's discipline is not the guarantee. The guarantee is
`src/app/run-actions.ts:810-821`, which refuses a retry of a `completed` task with
`task_completed` and says in its own comment that `--force` deliberately does not open it.
**For a `completed` task the model is doubly protected. For `failed`, `blocked`,
`interrupted` and `review_required` it is protected only by the reader** — change the
config, retry, and the newly configured model lands in the artifact and then in the read
model, correctly, because that is a new attempt.

Two related facts, so nobody has to rediscover them: `TeamMemberView.model` and
`AgentView.model` *are* config-sourced and *are* served on run-scoped endpoints — the
contract says so at `api.schema.ts:852-856`, "a view of what the run would resolve rather
than of a record". And `run-reader.ts` renders one genuinely config-sensitive sentence
about a finished run already, via `describeIsolation` — "your configuration now says
`useWorktrees: <current>` — it does not apply to this run". So "a run-scoped read model
contains nothing config-sourced" is false. "A *task's* model is never config-sourced" is
true.

---

## The defect this milestone actually fixes: the worktree write-gate

`src/app/task-executor.ts:864-877` writes `result.json` **only in sequential mode**. In
worktree mode the only writer is the Integrator's success path (`integrator.ts:914`), and
its own docstring says it: an isolated run "does not write `result.json` at all".

So in worktree mode **every `failed` and every `review_required` task has no
`result.json`, forever** — which means `TaskSummaryView.runner` and `.model` are both
absent, on the board, for a task that ran.

This is not a hypothetical. Two of the eight real tasks in this repository's own
`.agent-flow/runs/` are in exactly that state right now:

```text
AF-2026-005/TASK-001   review_required, attempts: 2, no result.json
                       attempt-1.json + attempt-2.json both "runner": "agy"

AF-2026-006/TASK-004   review_required, attempts: 2, no result.json
                       attempt-1.failed.json + attempt-2.json both "runner": "claude"
```

All four runs in this repository are `"isolationMode": "worktree"`, and
`validationJudgement` is `unsatisfied` on both, so even the compensating
`awaitingIntegration` flag is false. The row is bare: a state, an attempt count, and
nothing about what ran.

**And the same reader already has the answer.** `run-reader.ts:710-711` and `:734-735`
read the runner and model off those very attempt artifacts to build
`AttemptHistoryView` — it simply does not put them on the summary row.

`tasks()` therefore backfills `runner`, `model` and `reasoning` from the newest attempt
artifact when no `result.json` exists. Artifact to artifact, no configuration, no new
persistence. Without it, a model-first board would answer Issue #21's question with
"not reported" on the most common real configuration — which is more confidently wrong
than the silence it replaced.

---

## Two states, not three

The first draft of this document proposed a three-way vocabulary, and the middle row was
a fabrication:

```text
model absent, runner present  →  "Runner default"    ← unprovable. Deleted.
```

Every link in the chain behind it breaks somewhere:

- `task-executor.ts:324` persists `failure?.execution ?? execution ?? plannedExecution(role)`,
  and `plannedExecution` (`stage-runner.ts:304-309`) is `resolveRole` with **no member** —
  so a `result.json` can carry a runner nothing spawned, and a member's pinned model is
  dropped from the record while the role's runner is written in its place.
- `runners.<id>.model` is a pinned model no record sees, as above.
- `openai-runner.ts:187` sends the literal string `'default'`, so "the CLI used its own
  default" is not even true of that runner.

So there are two states, and the honest one is short:

```text
model present and not blank  →  the model id, verbatim
otherwise                    →  not reported
```

**Blank is a fourth state the schemas allow.** `result.schema.ts` and `attempt.schema.ts`
declare `model: z.string().optional()` with no `.min(1)`, unlike their config counterparts
at `config.schema.ts:41,52`. An empty string parses, and `run-reader.ts`'s `=== undefined`
guard projects it as *present*. `modelIdentity` treats blank as absent, with a test that
says so.

### `modelIdentity` returns a discriminant, not prose

`src/contracts/model-identity.ts` exports `modelIdentity()`, which returns
`{ kind: 'model', model } | { kind: 'not_reported' }`. Three reasons it is not a string:

- The dashboard enforces en/pt-BR key parity (`i18n.test.ts`), and English prose returned
  from `src/contracts` would pass that test while leaving the screen half-translated.
- The CLI renders the same facts and already spells the absence a fourth way —
  `resolved.model ?? '(runner default)'` in `cli/feature.ts:357` and `cli/doctor.ts:198`.
  A discriminant is renderable by all three; a sentence is renderable by one.
- `src/contracts` holding display copy is a layer violation nobody would notice for a year.

It is a **leaf module that imports nothing**. `apps/web/vite.config.ts` states that every
import through the `@contracts` alias is type-only "so nothing from the core is bundled",
and `zod` is not a dependency of `apps/web` — importing the barrel for a value would pull
zod into the browser bundle. Web code imports the leaf directly.

The name is `modelIdentity` and not `describeModel` because
`src/app/stage-runner.ts:713-715` already has a private `describeModel`. One word, one
meaning.

---

## What is *not* claimed, and the `effectiveModel` that does exist

No **runner** adapter in this repository reports back which concrete model it used. All
six `AgentRunner` implementations were read: the envelope interfaces declare no model
field, and `BaseRunner.run()` emits no provenance at all. `RunProvenance.model` is written
only by `FallbackRunner` from its *own* resolved config — a substitution record, not a
self-report. So `stage-runner.ts:727-731`'s comment, "The runner's own account wins where
it exists", describes an account no runner has.

**But "there is no reported model anywhere" is false, and the first draft of this file
asserted it.** Two things exist:

- `src/adapters/utility-model/openai-utility-model.ts` reads `data.model` off the response
  body, governed by `UtilityModelProvenance` (`ports/utility-model.ts:167-178`), which was
  written precisely to distinguish observation from intent. It reaches `events.jsonl` as
  `effectiveModel` (`contracts/context-telemetry.schema.ts:217`) — a shipped field with
  the exact name this document once denied existed.
- `openai-runner.ts:141-148` observes the endpoint's served model ids into
  `RunnerHealth.version`, which reaches `doctor` and the health payload.

Neither reaches an execution record, so the task and attempt surfaces are unaffected. Two
properties of that one self-report are worth writing down anyway:

- **It cannot disagree with the request.** `execution-context.ts:223-226` sets the
  allowlist to `[config.global.utilityModel.model]` — one element, the requested model —
  and `context-telemetry.ts` drops anything outside it, returning an *empty* set when no
  trust object is passed. The mechanism can only confirm or discard. It looks like
  verification and cannot fail.
- **A runner self-report is structurally barred.** `context-telemetry.schema.ts:320-333`
  restricts `effectiveModel` to `utility_model | aggregate | repository_retrieval`. The
  vocabulary for a primary-runner observation exists and cannot hold one.

The Claude and OpenAI adapters are not missing the data — they discard it. The captured
real envelope at `test/fixtures/responses/claude/success-json.json` carries
`modelUsage.<model>.canonicalModel`, `docs/runner-capabilities.md:96` cites that very
field as proof of model selection, and `claude-code-runner.ts` already `JSON.parse`s the
whole envelope into an interface of five fields that does not declare it. Same shape in
`openai-runner.ts`, where the chat-completions top-level `model` is omitted from
`ChatResponse`.

That is a real, cheap, and *separate* milestone: capturing it introduces a genuine
requested-vs-reported distinction, which is the only condition under which a second field
earns its place. Until then there is one field with one meaning — **the model this
invocation was pointed at, or nothing** — and no `reportedModel`, `effectiveModel` or
`modelSource` on an execution record.

---

## Why the rule lives in `src/contracts` and not in `apps/web`

The browser renders facts. It does not decide that `claude` means Opus or that `agy` means
Gemini — a mapping like that would have to be edited to add a runner, which is the property
`src/core knows no provider` exists to protect, one layer up.

`apps/web/src/lib/model-provenance.ts` broke that:

```ts
if (runner === 'agy') return { display: 'Unobservable', … }
```

Three things wrong. It is a provider name in the browser deciding a model question. It is
**false** — `AgyRunner` passes `--model` straight through and its capability table is keyed
by real model families like `gemini-3.1-pro`, so AGY's model is exactly as observable as
any other runner's. And its sibling branch returned `isObserved: true` with the tooltip
"Observed effective model" over `RoleRouteView.resolved.model`, which is a static
configuration projection — for a role route `resolved.model` *is* `configured.model`, since
`resolveRole` clamps reasoning and never changes the model. The one thing on that page the
word "observed" was true of is the utility model's `effectiveModel`, which that module
never touched.

The module is deleted, along with its test file. `AgentsPage`'s utility-model panel keeps
its `Not observed` wording, because there it is earned.

`test/architecture.test.ts` gains a rule that fails if a provider name decides a model
question under `apps/web/src`. Four things about how it is written, each of which would
otherwise make it useless or wrong:

- **It reads `withoutComments`, not `codeOnly`.** `codeOnly` blanks string literals, so a
  rule looking for `=== 'agy'` written against it reads `=== ''` and passes by looking at
  nothing. The M8 rules learned this; this one inherits it.
- **It excludes `*.test.tsx?`**, following the precedent already in the file. Twelve files
  under `apps/web/src` carry provider names and eleven of them are tests building fixtures.
  After the deletion, non-test `apps/web/src` is clean — measured, not assumed.
- **`'agy'` is not in a substring needle list**, because it is a substring of `legacy`.
- **The matcher is self-checked against synthetic strings**, following the precedent at
  `architecture.test.ts:1807-1810`: a rule that cannot see what it forbids passes forever.
- **And it is proved by mutation.** Planting `if (facts.runner?.toLowerCase() === 'agy')`
  back into `model-label.ts` turns the rule red and names the file and the literal;
  removing it turns the rule green again. A rule nobody has seen fail is a rule nobody has
  evidence for.

The browser has a second rule of its own, and it had to be amended rather than satisfied.
`apps/web/src/lib/architecture.test.ts` forbade *any* value import from `@contracts`, for
two stated reasons: Zod in the bundle, and the browser becoming a second validator.
`model-identity.ts` is neither — but a blanket rule cannot tell. The exemption is
**structural rather than a list of names**, because a list of names is how a rule dies: a
value import is allowed only from a contracts module that imports nothing and mentions no
schema, which `model-identity.ts` is deliberately and which the barrel is not.

Its own positive control caught two bugs in that predicate before it caught anything else.
The barrel has no `import` line at all — it is twenty-one `export * from` — so an
import-only check declared the whole schema surface a leaf. And `model-identity.ts`
explains itself by quoting the declarations it reasons about, so a scan over raw text found
`z.` in its prose and refused the one module the exemption exists for.

The existing `src/core knows no provider` rule is **not** switched to `withoutComments`
here, and that is deliberate rather than an oversight: it would go red today on
`process-environment.ts`'s `CLAUDE_*` / `OPENAI_*` / `CODEX_*` environment names,
`context-telemetry.ts`'s `'openai-compatible'` and a failure-classification comment. That
rule has passed its whole life because the helper blanks exactly what it forbids — a live
instance of the defect class — and correcting it is a separate, argued change.

---

## What changed on screen

| surface | before | after |
|---|---|---|
| board task card | agent name only | model, then the agent name and the lane facts |
| task inspector | `Agent: claude`, `Model: …` | `Model` / `Role` / `Runner` / `Agent`, model first, only what is known |
| Tasks table header | `AGENT / MODEL` | `MODEL / RUNNER` |
| Tasks table cell | `no model` | one wording, shared |
| attempt history | `claude · claude-opus-5` | the model, runner beneath it |
| graph node | `agentName ?? model ?? runner ?? 'no model yet'` | never the runner id as an identity |
| Team | `executor.normal · claude` | the configured model, labelled as configured |
| Agents & Models | `Unobservable` / `Observed effective model` | the configured model, or `no model pinned` |

**The mislabel was in two places, not one.** The inspector's metadata row captioned
`task.runner` as `Agent`; the table's column header said `AGENT / MODEL` over a cell that
has never held an agent — its two lines are the model over `runner · effort`. One wrong
word, twice, belonging to neither fact beneath it.

The graph node is worth naming too. `dag-view.tsx` read
`{agentName ?? task?.model ?? task?.runner ?? 'no model yet'}`, so a node fell through to
the **runner id** in the identity slot — `claude` presented where a model belongs, which is
the one substitution Issue #21 forbids by name.

**The team panel's model is intent, not record**, and it is labelled that way. It comes
from `loadConfig` at read time, and rendering it in the same visual language as a task's
persisted model would recreate the confusion this document exists to remove. The word
`configured` rides on a *value* and not on an absence: printing it unconditionally made
the reviewer row read `no model pinned configured`, two words arguing with each other —
which the screenshot showed and no assertion would have.

Roles were not removed anywhere. A role still explains the routing, and the Agents &
Models page is still organised by role, because that page's question is "what would this
role run" rather than "what ran".

### One thing fixed that is not about models

`task-inspector.tsx` listed `completed` among the retryable states, so the Retry control
rendered on a completed task — and `run-actions.ts` refuses that request before anything
else, with `task_completed`, and says in its own comment that `--force` deliberately does
not open it. The dialog stated three irreversible consequences and the server said no,
every time. That is the exact failure the list's own rationale names: a button that
teaches people to ignore refusals. Same file, same read of the same surface, so it is
fixed here and committed on its own.

---

## What the visual gate cannot see, measured

`playwright.config.ts` sets `maxDiffPixelRatio: 0.002`. At 1440×900 that is **2592
pixels** of tolerance — about a 50×50 block, which is more than a column header.

It is not a hypothetical. `run-tasks.png` compared green against a baseline reading
`AGENT / MODEL` with `TASK-004` on `GPT-5.6 Sol` while the app rendered `MODEL / RUNNER`
with `not reported`. **Two text changes in one frame, tolerated, twice, across two
`--update-snapshots` runs** — Playwright rewrites a baseline only when the comparison
fails, so a tolerated change is a baseline that stays stale and a picture that contradicts
the code it is supposed to document.

Deleting the file was the only way to get it rewritten. Doing that for every surface this
milestone touches found **102 baselines that differ from a fresh render, where the gate
had flagged 44**. The regeneration is not noisy — `review-panel.png`, on an untouched
surface, came back byte-identical — so the other 58 were genuinely stale.

The tolerance is not changed here. It exists for a stated reason ("antialiasing differs by
a hair between runs"), tightening it touches all 322 baselines on two platforms, and that
is a decision with its own evidence to gather. What this milestone can say is the number:
**0.002 of a 1440×900 frame is enough to hide a label**, and a green visual lane is
therefore evidence about layout rather than about wording. Wording needs an assertion —
which is why `model-identity.test.tsx` exists and asserts the strings the baselines
cannot.

---

## What is not covered

- **The reviewer's execution model, and the blocker is named.** `ReviewRecordSchema` keeps
  no runner or model, and `review-service.ask()` drops `StageResult.execution` on the
  floor, so a per-task code review's model is not recoverable for history. (`plan-review.json`
  and `final-review.json` *do* persist it; `verification.json` does not.) Persisting it on
  the record was planned for this pass and **withdrawn**: `codeReviewStage` runs as
  `role: 'finalReviewer'` and `review-service` passes no `member`, while the record's
  `independence` was computed from the selected member's *declared* runner and model
  (`core/review/reviewer.ts:134-135`). Persisting the execution without also passing the
  member would write an append-only record whose `reviewer` and `execution` contradict each
  other, and then render both next to a number computed from the third thing. Fixing it
  means passing `member` the way `task-executor.ts:305-311` already does for
  implementation — which is a change to review assignment, out of scope here. The gap and
  its fix belong to one commit, in a milestone that owns review routing.
- **A run whose runner reports its own model.** The data exists in two adapters and is
  discarded; see above. Capturing it is the milestone that earns a second field.
- **Display names.** `claude-opus-5` renders as `claude-opus-5`. A registry mapping ids to
  marketing names goes stale in a direction nobody notices, and the issue asks for accuracy
  over prettiness first.
- **`?model=` as a filter.** The task filter is status and text. Filtering by model is a
  question about many runs, which is the Analytics page's shape rather than this one's.
- **The four configuration places, reduced to two.** `runners.<id>.model` remaining
  invisible to `resolveRole` is a real defect with a false docstring above it. Named here,
  fixed elsewhere.
