# M6 live dogfood — what really happened

Two scenarios, both against real repositories with real authenticated runners on two
providers. Nothing here is a scripted test, and nothing was planted: §53 says if the
reviewer finds nothing real, that is the result.

Scenario 1 is the substance. It is reported first and in full, including where it stopped
and why. Scenario 2 exists because scenario 1 stopped before the corrective loop could
execute, and §52 asks for a loop that closes.

---

## Scenario 1 — `AF-2026-006`, an order service

| | |
|---|---|
| Repository | `~/wk/m6-dogfood` — a Node order service, 8 tracked files at baseline |
| Feature | An HTML status badge and a store index, both test-first |
| Run id | `AF-2026-006` |
| Wall clock | 2026-09-02 18:08:34Z → 18:41:25Z (**32m 51s**) plus two `review --fix` invocations |
| Providers | 2 — `claude-code-cli` and `agy-cli` |
| Logical agents | 4 — `backend`, `dba` (agy); `reviewer`, `qa` (claude) |
| Context cost | **836 KB** across 17 stage prompts |
| Manual interventions | 2 — `recovery_exhausted` on TASK-002 and TASK-004 |

### Assignments

Every one by `team_match`, through the M5 policy — no new router.

| Task | Agent | Role | Score | Why |
|---|---|---|---|---|
| TASK-001 | backend | executor.normal | 0.20 | main role, no skill overlap |
| TASK-002 | backend | executor.complex | 0.66 | javascript, http, server |
| TASK-003 | backend | executor.complex | 0.00 | a role it also serves |
| TASK-004 | dba | executor.complex | 0.69 | sql, schema, persistence, indexing |

`qa` was never assigned. Correct rather than broken: the three `test-gap` findings were all
`low`, and §44 says `low` does not block, so none became work. QA participation is
scenario 2's job.

### Reviews

Both recorded **independence 3**. One of them is wrong — see defect 0: `TASK-003` ran on
`claude`, the reviewer's own provider, and the run said cross-provider.

| Review | Task | Round | Verdict | Tree | Findings |
|---|---|---|---|---|---|
| REV-0001 | TASK-001 | 1 | changes_requested | `dae9cd3b` | 3 |
| REV-0002 | TASK-003 | 1 | changes_requested | `81eeea03` | 4 |

Seven findings: 1 high, 1 medium, 4 low, 1 info. Three `correctness`, three `test-gap`,
one `requirement`.

### The finding that mattered

`FIND-0001` (high, correctness) says an acceptance criterion cannot be satisfied:

> `assert.equal(out.includes('onmouseover='), false)` is applied to the whole output, but
> with the status text escaped as FR-002 requires the substring survives *inside the
> escaped element text by design*.

It is right, and it is not a style note. The output is
`<span class="badge …">paid&quot; onmouseover=&quot;alert(1)</span>` — byte for byte the
example the SDD itself prints as correct — and it contains `onmouseover=`. No conforming
implementation can pass. The only way to green is to mutilate the status text, which
violates a different criterion.

**Three independent reviewers found it.** The per-task code reviewer raised it first; the
run-level final review found it again on a separate call and proposed a better fix; the
plan reviewer found it a third time while judging the corrected plan. The run then failed
for exactly that reason — TASK-002 exhausted both attempts. The review predicted the
failure before the implementation ran.

This answers M6-ACC-26 as strongly as it can be answered. It also answers §53's harder
question — *did the finding matter?* — with the run's own outcome.

### Quality gates

Deterministic, from the project's own commands, joined to what actually ran.

| Task | Gate | Required | Status |
|---|---|---|---|
| TASK-001 | test | yes | **failed** (exit 1, 181 ms) |
| TASK-001 | lint | yes | **not_run** |
| TASK-003 | test | yes | **failed** (exit 1, 181 ms) |
| TASK-003 | lint | yes | **not_run** |

`not_run` is reported as `not_run` and blocks exactly as `failed` does (I-45). See the
limitation below for why it stayed that way.

### The corrective loop

`agent-flow review --fix` produced three corrective tasks, two of them from code-review
findings and carrying the link:

| Task | Origin | Finding | Scope | Complexity | Risk | Depends on |
|---|---|---|---|---|---|---|
| FIX-001 | final-review | — | missing_test | trivial | low | TASK-003 |
| FIX-002 | **code-review** | **FIND-0001** | correctness | trivial | medium | TASK-001 |
| FIX-003 | **code-review** | **FIND-0004** | correctness | trivial | low | TASK-003, FIX-001 |

Both provenances in one round, each labelled with the review that asked for it. Complexity
comes from the shape of the work and risk from severity, which is AD-42 holding: a
one-line test fix for a `high` finding is `trivial`/`medium`, not `complex`.

Then the corrected plan was reviewed in its own right and **the plan review rejected it** —
correctly. FIX-002 fixes a test that TASK-002's own acceptance criteria depend on, but
nothing orders it before TASK-002, so a valid topological order can run TASK-002 against
the uncorrected test. The generator orders by declared file overlap, and the dependency
here is semantic: FIX-002 touches `test/badge.test.js`, TASK-002 touches
`src/server/badge.js`. No mechanical signal exists.

Nothing was silently wrong. A model proposed, the gate refused, and the run stopped with a
precise explanation. That is the design working, and it is also a real limitation — see
below.

### Collaboration

**Four outbox attempts, by two agents on two providers, all refused as `schema_invalid`.**

Across M4, M5 and the M5 gap closure, 21 agent invocations produced exactly one message.
Phase A added the handoff form and the ownership boundaries to the bootstrap, and in the
six implementation prompts of this run the channel was used four times. So the protocol is
now *reachable* — agents try. They just cannot produce the shape from prose.

No handoff and no reassignment occurred. TASK-002 and TASK-004 each failed twice with the
same agent and stopped at `recovery_exhausted`, which is the recovery ladder deliberately
asking a human rather than silently rerouting. §55's requirement is therefore **not met**,
and is reported as such rather than manufactured.

---

## Scenario 2 — `AF-2026-001`, a slug module

Sized to *close* the loop rather than to stress it: one pure module, work an implementer
finishes in one attempt.

| | |
|---|---|
| Repository | `~/wk/m6-dogfood2` — a single ES module, 2 tests at baseline |
| Feature | `uniqueSlug(title, taken)` with a numeric suffix, test-first |
| Run id | `AF-2026-001` |
| Wall clock | 19:55:32Z → 20:28:08Z (**32m 36s**) plus two `review --fix` and one `revise` |
| Providers | 2 — `claude-code-cli` and `agy-cli` |
| Logical agents | 3 — `dev` (agy); `reviewer`, `qa` (claude) |
| Context cost | **582 KB** across 16 stage prompts |
| Tasks | 3, all completed |

### QA picked up QA work, through the same policy

| Task | Agent | Score | Why |
|---|---|---|---|
| TASK-001 *(write failing tests)* | **qa** | **0.91** | testing, test-gap, missing-test, coverage |
| TASK-002 *(implement)* | dev | 0.86 | javascript, strings, correctness |
| TASK-003 *(verify no collateral)* | dev | 0.00 | a role it also serves |

0.91 is the highest assignment score in either scenario. §33–§35 asked for QA to be a team
member with QA skills rather than a tenth `WorkflowRole`, and a test-writing task routed to
it through the M5 policy with no QA-specific code anywhere. **M6-ACC-15, answered live.**

### Reviews

| Review | Task | Author | Independence | Verdict | Findings |
|---|---|---|---|---|---|
| REV-0001 | TASK-001 | qa | **1** | changes_requested | 1 medium, 1 low |
| REV-0002 | TASK-002 | dev | **3** | approve | 1 low, 1 info |

Independence 1 on the first — recorded rather than hidden, which is what §12 asks for, and
also wrong: `qa` declares `claude` but `executor.normal` sent the work to `agy`, so it was
cross-provider. Defect 0 has the full correction.

`REV-0002` is an **approval** — the only one across both scenarios; the other three live reviews all asked for changes.
Two findings, both non-blocking, and the change proceeds — §44's severity policy doing the
thing it exists to do rather than blocking everything.

The reviewer found the same *class* of defect it found in the other repository, unprompted:

> `assert.equal(result.endsWith('-1'), false)` can never fail. Line 27 already pins
> `result` to the exact string.

Two repositories, two assertions that cannot fail, found by a reviewer nobody told to look
for them.

`FIND-0004` (info) is worth quoting for a different reason:

> The checked-out working tree does not contain this change. `src/slug.js` on master has
> only slugify, `git status` is clean.

I read this at the time as the reviewer being careful. **It was the reviewer reporting a
product defect** — it was reading the working tree and not the integration branch, because
nothing gave it the integration checkout. See defect -1.

### Quality gates — the first green ones

| Task | Gate | Required | Status |
|---|---|---|---|
| TASK-001 | test | yes | failed (exit 1) — correct: the task expects a red suite |
| TASK-001 | lint | yes | **not_run** |
| TASK-002 | test | yes | **passed** (exit 0) |
| TASK-002 | lint | yes | **passed** (exit 0) |

Both required gates green on TASK-002, from the project's own commands. **M6-ACC-17,
answered live.** `lint` is `not_run` on TASK-001 for the reason described under limitations.

### The Definition of Done, held open by exactly one thing

```
✓ SDD approved
✓ all tasks completed
✓ lint, tests and build passing
✓ final review PASS
✗ no blocking review finding is open — still open: FIND-0001
```

Every condition M4 knew about passed. Without the fifth — added in this milestone because
§43 asks for it — **this run would have been declared DONE with a blocking finding open**.
That is the defect and the fix, on one screen, from a real run.

---

## Scenario 3 — `AF-2026-002`, the completion pass

Run on the completion charter's build, and it produced the milestone's two clearest pieces
of evidence.

| | |
|---|---|
| Repository | `~/wk/m6-dogfood2` |
| Feature | `truncateSlug(title, maxLength)`, test-first |
| Providers · agents | 2 · 3 (`dev` on agy; `reviewer`, `qa` on claude) |
| Context cost | **402 KB** across 13 stage prompts |
| Reviews | 3 · independence 1, 3, 1 |
| Findings | 6 — 1 critical, 1 high, 2 low, 2 info |

### The review caught a green gate that was lying

`TASK-002` reported completion. Its two required gates both passed, exit 0. The reviewer
read the tree and returned `blocked`:

> **[critical] FIND-0004** — `truncateSlug` does not exist. `src/slug.js` ends at line 11
> with the original slugify function.
>
> **[info] FIND-0006** — The reported green gate cannot distinguish 'implemented correctly'
> from 'not implemented'.

The second finding is the diagnosis of the first: the tests never imported the function, so
`npm test` passed by not exercising anything. A deterministic gate said yes about work that
did not exist, and a semantic review is what noticed — which is §9–§12's whole argument,
arrived at from the other direction.

Then the Definition of Done:

```
✓ SDD approved
✓ all tasks completed
✓ lint, tests and build passing
✓ final review PASS
✗ no blocking review finding is open — still open: FIND-0004, FIND-0005
```

**Every condition M4 knew about passed on a tree where the feature does not exist.** Without
the fifth — added in this milestone because §43 asks for it — this run ships as DONE with
nothing implemented. That is the milestone justified in five lines of its own output.

### The runner fix, before and after in one log

`qa` declares `runner: claude`. `executor.normal` points at `agy`.

```
TASK-001  runner=agy       ← old build: the role won
TASK-002  runner=agy
TASK-003  runner=agy
FIX-001   runner=claude    ← after the fix: the member wins
```

Same run, same config, same member. **M6-ACC-03, answered live.**

### Why four milestones of silence — answered

The refusal diagnostic added earlier in this milestone finally said what a malformed outbox
got wrong:

```
entries.0.affects.0: invalid_value
entries.0.affects.2: invalid_value
entries.1.affects.1: invalid_value
```

The QA agent wrote two well-formed blackboard entries and the *only* invalid thing in the
file was one field. `affects` takes the nine workflow roles; the bootstrap sketched it as
`"affects":["<role>"]` and never said what a role is, while everything else in the same
block names members by id — which is what a team makes natural to write there.

So the channel was not unused. It was unusable, over an enum nobody was shown. The
bootstrap now lists the nine values, at ~120 bytes on a 32–50 KB prompt. `affects` still
rejects a member id, which is the follow-up: widening it is an M4 contract change and the
audience filter has to learn about members.

### Two more defects, both found by running it

**The corrective task took the whole validation registry.** The plan review named the
consequence exactly: `install` resolves to `npm install`, this repository has no
dependencies, npm writes a `package-lock.json` that `.gitignore` does not cover, and
TASK-003's change-surface criterion then fails. Every human-planned task omitted `install`;
every generated fix put it back. A correction now validates with what the corrected task
validated with — the third thing it inherits, after its origin and its expectation.

**A revision plus a block crashed the run.** `agent-flow revise` gave the already-completed
TASK-003 a dependency on FIX-001; FIX-001 blocked; the cascade returned TASK-003; the
scheduler wrote `completed → blocked`; the state machine refused, correctly, and the
unhandled `TaskStateError` killed the run *after* the corrective task had done its work.
The cascade's own comment said "none of them ran, so this is dependency-derived by
construction" — and a revision is exactly the case where that stops being true.

## Scenario 4 — `AF-2026-003`, the first valid review

Run after defect -1, and its only job was to answer one question: does the reviewer read
the tree it names?

`REV-0001` on `TASK-001`, verdict **approve**, tree `5eeb0314`, two `low` findings:

> Nenhum teste cobre o caso em que APENAS UM dos lados sluga para vazio.
>
> O teste de simetria (**linhas 29-34**) compara duas chamadas entre si sem fixar o valor
> esperado, então não pode falhar por resultado errado — só por assimetria.

**It cites lines 29–34 of a file that has eleven lines on `master`.** Those lines exist only
on the integration branch, written by the task under review. Before the fix the reviewer
could not have seen them; here it read them, and reasoned about what they assert.

The second finding is also the third independent time a reviewer has caught an assertion
that cannot fail, in a third repository, unprompted.

`REV-0002` on `TASK-002` is the other half of the answer: **`approve`, independence 3, zero
findings.** The first clean review in the milestone, from a reviewer on the other provider
from the author, reading the implementation it was given. §62 says do not invent a finding
if there is none; here there was none, and the run said so.

Two approvals, one with two non-blocking findings and one with nothing — §44's severity
policy doing the thing it exists to do rather than blocking everything (M6-ACC-07, live).

And the runner, in both directions in one run: `TASK-001` on `claude` because `qa` declares
it, `TASK-002` on `agy` because `dev` does, with the `roles:` table pointing at `agy` for
both. Defect 0, closed and visible.

---

## Defects this dogfood found

Every one of them survived 3893 green tests, and every fix carries a positive control.

### -1. The reviewer read the wrong tree — BLOCKER, fixed

**The worst defect in the milestone, and it invalidates the *content* of every live review
before the fix.** Not the mechanism — a review was requested, assigned, run and recorded
correctly every time — but what the model actually looked at.

The reviewer ran in the project directory. In worktree mode that is the operator's own
checkout, which does not have the change in it. So every per-task review judged a tree
without the work.

`reviewedTree` was recorded correctly the whole time. That is what made this dangerous
rather than obvious: the audit trail named the right commit while the model had read a
different one. §4 asks for `reviewedTree == tree intended for review`; the record satisfied
it and the reading did not, and no test could tell, because every test checked the field.

**The product said so twice and I read it as cleverness.** Scenario 2's reviewer filed this
as `info`:

> The checked-out working tree does not contain this change. `src/slug.js` on master has
> only slugify, `git status` is clean.

I recorded that above as "I-41 landing in the reviewer's own understanding". It was the
reviewer reporting a product defect. Scenario 3 then produced `[critical] truncateSlug does
not exist, src/slug.js ends at line 11` about a function sitting on the integration branch,
and the QA agent sent back to fix it refused, with `git log -S truncateSlug` naming the two
commits that had added it — **a corrective task correctly declining to correct a false
positive.**

Fixed: the review runs in the checkout `openForReview` prepares, the same one the run-level
review and the Definition of Done already use. A preparation that cannot be opened skips
the review rather than running it against the wrong tree. Three architecture rules hold it,
including one requiring that exactly one place in the product opens an integration
checkout.

**What this costs the earlier evidence.** The findings quoted from scenarios 1–3 were formed
against the pre-change tree, so a finding about *what the diff added* may be wrong.
`FIND-0001` in scenario 1 survives on its own terms — it is an argument about an acceptance
criterion's text, which the reviewer could read either way — and the same is true of the
"assertion that cannot fail" findings. Anything asserting a file's *contents* does not.

### 0. A team member's declared runner was fiction at execution time — BLOCKER, fixed

**The independence figures in this report are unreliable, including the ones above.** They
are corrected in the table below.

A team member declares `runner:`. `resolveRole` accepts a member override and its own
comment says why — "who answers a role is not always what `roles:` says". The capability
check uses it. The independence calculation uses it. **The execution path does not**:
`stageRunner.run` is handed a `role` and no override, so the runner comes from the `roles:`
table and the member's declaration is ignored.

Caught by one line of the live log:

```
task_assigned   task=FIX-001 agent=qa   role=executor.trivial
task_finished   task=FIX-001 status=completed runner=agy
```

`qa` declares `runner: claude`. `executor.trivial` points at `agy`. The work ran on agy and
every downstream calculation believed claude.

What that does to the evidence:

| Review | Member (declared) | Role → actual runner | Recorded | Actual | |
|---|---|---|---|---|---|
| s1 REV-0001 | backend (agy) | executor.normal → agy | 3 | cross-provider | ✅ |
| s1 REV-0002 | backend (agy) | executor.complex → **claude** | **3** | **same-provider** | ❌ |
| s2 REV-0001 | qa (claude) | executor.normal → **agy** | **1** | **cross-provider** | ❌ |
| s2 REV-0002 | dev (agy) | executor.normal → agy | 3 | cross-provider | ✅ |
| s2 REV-0003 | qa (claude) | executor.trivial → **agy** | **1** | **cross-provider** | ❌ |

Three of five are wrong, and one of them is wrong in the direction that matters: s1
REV-0002 recorded *maximum* independence for a review where the same provider wrote the
code and judged it — the exact situation I-42 exists to prevent, reported as its opposite.

**Fixed.** It was left standing at the end of the first pass, on the reasoning that an M5
execution-path change should not be smuggled into M6. The completion charter's §8 settles
it the other way — "o sistema deve persistir o nível *efetivo*" — and an effective level is
only persistable if the effective runner runs.

`StageRunOptions` now carries the assigned member, and `stageRunner.run` passes it to
`resolveRole` as the override that function has accepted since M5. A run with no team is
byte-for-byte unchanged: the override is absent and the role resolves as it always did.
Two architecture rules hold the thread, one at each end, because a rule checking one end is
how it broke.

### 1. A code-review finding could never become work — BLOCKER

`correctiveSelection` was written, reviewed and covered by tests, and **no production code
called it**. Seven findings, one of them a blocking `high`, and zero corrective tasks.

Worse, `corrective_task_created` — which `projectFindings` reads to derive `fixed` — was
declared in the event vocabulary, consumed by the projection, and **never emitted**. Both
links in `open → fixed → verified` were missing, so no finding in a real run could ever
leave `open`.

The tests could not see it. Every one of them called the selector directly and supplied
the event itself. This is exactly the question §70 asks: *could every test pass while no
real agent reaches this path?*

Fixed in `5b296b5`. The general form is now an architecture rule: an export under
`src/core/review/` with no transitive caller in shipped code fails the suite, and `test/`
is excluded from the reachable set on purpose.

### 2. A run could be `completed` with a blocking finding open — HIGH

`checkDefinitionOfDone` knew four conditions and none of them were findings. §43 says the
quality decision is every required gate passing, no blocking finding, the review approved
*and* the Definition of Done satisfied — and only three of the four were being asked.

Fixed in `5b296b5`. It fired live on the next run:

```
✗ no blocking review finding is open — still open: FIND-0001, FIND-0004
```

### 3. A refused outbox said nothing about itself — MEDIUM

Four attempts refused as `schema_invalid`, the event recording only that, the file deleted
before anything could read it, and no copy in the logs. The one signal saying the protocol
is not landing carried nothing to act on.

Fixed in `e81d0ea`. The refusal now names the fields in the schema's own vocabulary — paths
from `AgentOutboxSchema`, codes from the validator, segments sanitised, capped at four. No
agent-authored text passes through: a rejection is still not a channel.

### 4. A fix was born expecting a green suite the cycle requires to be red — HIGH

**Both** live corrective rounds, in two different repositories, were rejected by the plan
review with the same reasoning:

> TASK-001 deliberately leaves the suite RED (its own expectation is `fail`). So FIX-001
> becomes eligible the moment TASK-001 finishes, and in that window `npm run test` cannot
> pass. The task only works by accident, if the runner happens to serialize in array order.
> A parallel scheduler produces a false failure and burns retry attempts on a task whose
> content is correct.

Two of two is not a scenario artifact. A corrective task took the schema default of `pass`
whatever it was correcting, so every fix to a test-first task's tests was born expecting
green from a red suite.

Fixed by inheriting the expectation of the task whose finding it corrects: a correction
occupies that task's position in the cycle, because that is what it corrects.

### 5. `review --fix` twice generated two tasks for one finding — HIGH

A finding is `fixed` only once its corrective task *completes*. Between generating that
task and running it the finding is still `open`, so the selector — which reads status —
selected it again. The live run produced FIX-001 and FIX-003 with byte-identical
descriptions and the same `FIND-0001`, and the plan review caught it:

> Three tasks for one assertion. Whichever runs first satisfies the criterion, so the other
> two are no-ops. FIX-003 makes it worse: it depends on FIX-001 and FIX-002 yet declares
> `validationExpectation: "fail"`, so the last task in the plan is scheduled to demand a
> failing gate on a change that is already green.

Fixed: the selector reads the plan for findings that already carry a corrective task,
whether or not it has run. One task per finding, ever.

### 6. Corrective tasks were ordered only against each other — MEDIUM

`applyFixes` derived file-overlap ordering among the new tasks only, reasoning that an
existing task has already run. `review --fix` on a run that *halted* falsifies the premise:
three tasks had never run, four fixes declared the same files, and `checkPlan` refused the
entire plan for contention. The corrective round produced nothing.

Fixed by deriving against the whole plan. Safe because the helper only adds edges from
later entries to earlier ones and the fixes are appended last, so every edge points from a
fix into the plan and never the reverse.

### 7. Four event types stored a status the design says must be derived — MEDIUM

Found by auditing the vocabulary after defect 1, not by the run itself. Five review event
types were declared and emitted by nothing. Four of them — `finding_acknowledged`,
`finding_disputed`, `finding_fixed`, `finding_verified` — are *statuses*, and I-43 says a
finding's status is derived and never stored. An event carrying one would have been a
second answer to a question the projection already answers, and the two would disagree the
first time a run resumed.

Removed. The suite now requires an emitter for every type in `REVIEW_EVENT_TYPES` — the
reachability rule of defect 1, applied to data instead of to code.

---

## Acceptance criteria, one by one

Twenty-eight, and every tag is greppable in `test/` so this table can be checked rather
than believed.

| | Criterion | Status | Where |
|---|---|---|---|
| 01 | implementation receives independent reviewer | ✅ | `review-acceptance`, live in both runs |
| 02 | reviewer cannot equal implementation invocation | ✅ | `assignment.ts` `is_author`, architecture test |
| 03 | provider independence preferred, degradation recorded | ✅ | wrong 3 times in 5 until defect 0 was fixed |
| 04 | structured finding is persisted | ✅ | 11 findings across 4 live reviews |
| 05 | invalid finding paths refused/dropped safely | ✅ | `normalise.ts`, adversarial suite |
| 06 | blocking finding prevents review approval | ✅ | live: the DoD held two runs open |
| 07 | non-blocking finding does not block | ✅ | live: REV-0002 approved with 2 findings |
| 08 | developer response uses collaboration, no second store | ✅ | `findings.ts` reads messages only |
| 09 | developer cannot self-verify a finding | ✅ | `verifierOf` requires a different tree |
| 10 | corrective task passes through AssignmentPolicy | ✅ | it is an ordinary plan task |
| 11 | corrective task passes through scheduler/worktree/validation | ✅ | same |
| 12 | re-review observes the corrected tree | ✅ | `reviewedTree` identity |
| 13 | review goes stale after the tree changes | ✅ | `freshnessOf` |
| 14 | a stale review satisfies no final gate | ✅ | `decideQuality` condition 4 |
| 15 | QA can create and execute test work | ✅ | **live: TASK-001 → qa at 0.91** |
| 16 | QA output alone cannot pass a quality gate | ✅ | gates read command results, not verdicts |
| 17 | required validation gate executes mechanically | ✅ | **live: TASK-002 lint+test passed** |
| 18 | `NOT_RUN` is never `PASS` | ✅ | live: `lint not_run` blocked, twice |
| 19 | review loop budget terminates | ✅ | enforced before the call is spent |
| 20 | crash/resume duplicates no review, loses no finding | ✅ | `review-crash` suite |
| 21 | CLI, API and dashboard use one projection | ✅ | `projectReviews`, architecture test |
| 22 | M4 collaboration invariants survive | ✅ | regression suite |
| 23 | M5 assignment/ownership/capacity invariants survive | ✅ | regression suite |
| 24 | **live handoff/reassignment demonstrated** | ❌ | **not met** |
| 25 | **live collaboration payload changes downstream behaviour** | ❌ | **not met** |
| 26 | live review finds a real issue | ✅ | `FIND-0001`, confirmed by three reviewers |
| 27 | live corrective loop fixes and verifies that issue | ◐ | executed, integrated, re-reviewed live; `fixed` proven by test only |
| 28 | all mandatory quality gates green | ✅ | 3917 · 343 · 38 e2e · 175 visual · lint · 3 typechecks · 2 builds |

### Where 24 and 25 stand

The completion charter released both. **§53:** module decomposition tracks the ownership
boundary in this repository, four independent plans showed it, and fabricating a bad plan
to produce a handoff is forbidden — "isso NÃO bloqueia M6 se o mecanismo permanecer seguro
e testado". **§54:** the same for dialogue. Both mechanisms keep their scripted coverage,
and neither was observed live.

What follows is what the runs actually showed, because "not observed" and "cannot happen"
are different facts.



**M6-ACC-24.** §55 required this dogfood to include a real handoff or reassignment, because
Phase A did not produce one. It did not happen. In scenario 1 both failing tasks stopped at
`recovery_exhausted` — the ladder asking a human, which is its documented behaviour and not
a reassignment. In scenario 2 nothing failed.

The honest part: I did not design a scenario that *forces* the conflict. Both plans
decomposed by module, and a module boundary is the ownership boundary, so the situation a
handoff resolves was resolved upstream — the same result Phase A got from four independent
plans. The experiment that would settle it is a single task whose declared files straddle
two members' exclusive patterns, dispatched with `agent-flow task` so no planner can
decompose the conflict away. That was not run.

**M6-ACC-25.** Not observed, and by the end of the completion pass the reason is known
rather than guessed — which is the useful part, and it took three attempts to get.

Through M5 the answer was "nobody uses the channel". Phase A added the handoff form and
stated ownership, and agents then used it in **four of six** implementation prompts in
scenario 1 — all four refused as malformed, with the event recording nothing about why.
The refusal diagnostic added in this milestone was written for exactly that gap, and in
scenario 3 it answered:

```
entries.0.affects.0: invalid_value
entries.0.affects.2: invalid_value
entries.1.affects.1: invalid_value
```

One field. `affects` takes the nine workflow roles; the bootstrap sketched it as
`"affects":["<role>"]` and never said what a role is, while every other line in the same
block names members by id. The agent wrote what the protocol taught it to write and the
schema rejected the file.

So the channel was never unused — it was unusable, over an enum nobody was shown. The nine
values are now listed in the bootstrap. Whether that produces a delivered message is the
first thing to measure in M7, and `affects` accepting a member id is the follow-up that
would make the natural thing to write also the correct one.

### The corrective loop, end to end and live

`FIX-001` ran. The whole chain, from the run's own event log:

```
corrective_task_created   FIX-001 ← FIND-0001, origin code-review
task_workspace_created    its own branch, based on the integration head
task_assigned             FIX-001 → qa, 0.80, skills test-gap, testing, missing-test
task_attempt_validated    judgement satisfied, ids [install, lint, test]
task_finished             completed
task_integrated           merge 1c0ab6bf
reviewer_assigned         REV-0003, reviewer, author qa
review_started            tree 1c0ab6bf   ← the corrected tree
finding_raised            FIND-0005 medium test-gap
review_completed          changes_requested
quality_gate_evaluated    install passed · lint passed · test passed
```

A finding raised by a live reviewer became a task, the task was **routed to QA by the
finding's own category** — `test-gap` is a skill `qa` declares, and nothing QA-specific
exists in the router — executed in an isolated worktree, validated, integrated, and
**re-reviewed against the corrected tree**. Three gates green. **M6-ACC-10, 11, 12 and 15,
all answered by one task.**

The re-review asked for changes rather than clearing `FIND-0001`, and raised a new
`FIND-0005` instead. That is the design, not a disappointment: a re-review judges the tree
in front of it. `verified` is reserved for a review that reads a *different* tree and lets
it go, and this one did not.

**What did not happen: `FIND-0001` never reached `fixed`.** The `corrective_task_created`
events on disk carry `task:`, written before the key mismatch was found; the projection
reads `correctiveTask:`. The pairing is proven by a test that drives the real emitter into
the real projection, and it is *not* proven by this run, whose log predates the fix. Said
plainly rather than glossed: the lifecycle's last step has a test behind it and no live
observation.

---

## Manual interventions, all of them

Seven, and none of them silent.

| # | Where | What | Why |
|---|---|---|---|
| 1 | Scenario 1 | `recovery_exhausted` on TASK-002 | two attempts spent; the ladder asks a human |
| 2 | Scenario 1 | `recovery_exhausted` on TASK-004 | same |
| 3 | Scenario 1 | `review --fix`, twice | the second only after fixing the ordering defect it exposed |
| 4 | Scenario 2 | first run discarded | I ran `feature`/`run` without `--config`, so the team config was never loaded and no review happened at all — my error, not the product's |
| 5 | Scenario 2 | `review --fix`, twice | the second exposed the duplicate-task defect |
| 6 | Scenario 2 | `agent-flow revise` | the documented path after a plan review rejects |
| 7 | Scenario 2 | `approve --force` | see below |

The `--force` deserves its own line, because the product is right to make it loud. The
revised plan's review returned `FAIL` on one `medium` finding: FIX-001's added assertion
uses a contiguous `taken` run, so it cannot distinguish "first free candidate" from a
step-by-2 loop. That is a fair criticism of the *test* the correction adds, not a reason
the plan is unsafe to run, and executing it is what this dogfood exists to do. The
abandoned guarantee is recorded on the run, which is exactly the behaviour that makes using
it acceptable.

## Two more things the runs said

**"Its findings are above."** `agent-flow revise` prints that line after a rejecting plan
review, and prints no findings. The verdict is in
`.agent-flow/runs/<id>/reviews/plan-review.json` and nowhere on screen — so the one command
whose output tells you what to fix tells you to look at nothing. Minor, and worth a line in
M7.

**The final review can be confidently wrong about the tree.** Scenario 2's second `--fix`
generated FIX-002 from a final-review finding whose premises the plan review then
demolished: "it claims `git log` shows commits for TASK-001/002/003 — checked: `git log`
is scaffolding, test-script fix, baseline; `src/slug.js` is 11 lines and exports only
slugify". A model asserted verified fact about a tree it had misread, and a *different*
model caught it. Nothing downstream trusted the first one. That is the review layer
working, and it is also the clearest argument in either scenario for why §9–§12 insist
semantic review, QA and deterministic validation are not equivalent.

---

## Score-floor evidence (§57, §58)

Every assignment in the three scenarios, with the score it won on and the best candidate it
beat. §57 says do not implement a threshold without evidence; this is the evidence, and it
does not support one.

| Task | Chosen | Score | Next best | Outcome |
|---|---|---|---|---|
| s2 TASK-001 | qa | **0.91** | dev 0.29 | changes_requested, 1 medium |
| s2 TASK-002 | dev | **0.86** | qa 0.34 | approve |
| s2 TASK-003 | dev | **0.00** | qa 0.00 | no review (no change) |
| s2 FIX-001 | qa | **0.80** | dev 0.11 | changes_requested, 1 medium |
| s3 TASK-001 | qa | **0.91** | dev 0.29 | approve, 2 low |
| s3 TASK-002 | dev | **0.86** | qa 0.34 | blocked, 1 critical ← *and the review was reading the wrong tree* |
| s3 FIX-001 | qa | **0.67** | dev 0.11 | blocked twice |

**No relationship is visible, and one row explains why looking is premature.** The worst
outcome in the table belongs to a 0.86 assignment, and the finding that produced it was a
false positive caused by defect -1. Two of the three `0.00` rows are tasks whose scope
matched nobody's skills — a documentation check and a hygiene pass — and both completed.

A floor would have changed nothing here and would have blocked TASK-003 for no reason. The
decision stays deferred, and the unblocking condition is unchanged: enough runs on a build
whose reviews are valid to correlate score with *review outcome*. None of these three
qualify, because in all three the reviewer read the wrong tree.

---

## Collaboration default decision (§56)

`collaboration.enabled` stays **`false`**.

| | Invocations | Outbox attempts | Delivered |
|---|---|---|---|
| M4 | 12 | 1 | 1 |
| M5 + gap closure | 9 | 0 | 0 |
| M6 s1 | 6 | 4 | 0 |
| M6 s2 | 3 | 0 | 0 |
| M6 s3 | 5 | 4 | 0 |
| **total** | **35** | **9** | **1** |

The cost is measured: 1 034 bytes of bootstrap on every implementation prompt, about 2–3%
of one. The reason to keep it off is no longer "nobody uses it" — nine attempts in two M6
scenarios — but that nothing has yet come out the other side. The enum fix landed after the
last attempt, so the next run is the first that can produce a delivered message. Turning
the default on before that would be turning on a channel whose only observed behaviour is
refusal.

---

## Known limitations

1. **`affects` rejects a member id.** The one field that names an audience takes workflow
   roles, and everything else in the protocol names members. Widening it is an M4 contract
   change and the audience filter has to learn about members.
2. **A required gate no task runs stays `not_run` forever.** The planner chooses a task's
   validation ids; nothing forces the required gates onto it. It fails safe — nothing is
   falsely green — and no command resolves it.
3. **A corrective task is not inserted into the chain.** It inherits its origin, its
   expectation and its validation from the corrected task, but not its position: a fix to a
   test that a later task's criteria depend on lands beside that task rather than ahead of
   it. Needs task states in the generator.
4. **A corrective task's acceptance criterion is the finding's `suggestedAction`.** When a
   reviewer writes that action to a coordinator — "send TASK-002 back" — the generated task
   is unverifiable. The plan review catches it; nothing mechanical does.
5. **Dispute routing is specified and not built** (§32), because the trigger reaches Agent
   Flow only through the collaboration outbox and nothing has ever come through it.
6. **Independence is measured, not enforced.** A team with one provider gets level 1 and a
   recorded degradation, which is the honest answer, not a block.
7. **Per-task review costs 13% of an implementation prompt** — 6.8–7.4 KB against 32–53 KB,
   measured across all three scenarios. It doubles the model *calls*, which the spec's own
   §17 critique worried about and nobody had priced. Selective review context (§45) is why
   the number is that low: the reviewer sees the change and the criteria, not the
   repository.

---

## Deferred to M7

- `ForgeProvider`, GitHub PRs and Issues, CI integration, remote review comments — §72,
  untouched.
- The six limitations above, in the order they are listed.
- The score-floor decision, with its unblocking condition restated: runs whose reviews were
  valid.
- Measuring whether a delivered collaboration message now happens, which is the only thing
  that can move `collaboration.enabled`.

---

## Verdict

Twenty-eight criteria: **25 met, 1 partial, 2 released by the completion charter.**

| | |
|---|---|
| M6-ACC-03 | ✅ was wrong three times in five; fixed in this pass (defect 0) |
| M6-ACC-24 | ⊘ released by §53 — module decomposition tracks the ownership boundary here, and fabricating a bad plan to force a handoff is forbidden |
| M6-ACC-25 | ⊘ released by §54 — and the *cause* is now known rather than guessed, which is the useful part |
| M6-ACC-27 | ◐ the loop ran end to end live; `fixed` deriving is proven by a test that drives the real emitter into the real projection, not by a run |

### What the completion pass changed

The first pass ended `M6 INCOMPLETE` on three counts. Two of them (§53, §54) the charter
released. The third was mine to fix and is fixed. Then running it again on the fixed build
found four more, of which one was worse than anything in the first pass:

**The reviewer had been reading the wrong tree.** Not the record — `reviewedTree` named the
right commit every time — the *reading*. In worktree mode the reviewer ran in the
operator's own checkout, which does not contain the change. The mechanism was correct and
the content was formed against the wrong bytes, and no test could see it because every test
checked the field.

The product had said so twice. Scenario 2's reviewer filed it as `info` — "the checked-out
working tree does not contain this change" — and I wrote that up as the model being
careful. Scenario 3 then produced a `critical` about a function that existed, and the QA
agent sent to fix it refused with `git log -S` to prove the finding false. **A corrective
task correctly declining to correct a false positive** is not a demonstration anyone plans
for, and it is the sharpest thing either pass produced.

### What M6 delivered

Eleven defects across the two passes, every one of them past a suite that was green, every
fix carrying a positive control that fails when the fix is reverted. Four were the same
shape — **written, tested, and unreachable**: a function nothing called, an event nothing
emitted, a key the emitter and reader disagreed about, and a runner override the dispatch
never passed. Two of the eleven were found in the *test suite itself*: a walker reading
none of the dashboard's 47 components, and fixtures that hand-wrote the event an emitter
was supposed to produce.

Five architecture rules now ask the question mechanically — reachable exports, emitted
events, browser-side derivation, both ends of the runner thread, and one place that opens
an integration checkout.

And the evidence a milestone is for, in five lines of a real run's own output:

```
✓ SDD approved
✓ all tasks completed
✓ lint, tests and build passing
✓ final review PASS
✗ no blocking review finding is open — still open: FIND-0004, FIND-0005
```

Every condition M4 knew about passed on a tree where the feature did not exist. The gate
that held it open is the one this milestone added.

### What M7 inherits

The six limitations above, `affects` accepting a member id first — it is the difference
between a protocol agents can obey and one they cannot, and after this pass it is the only
thing between the channel and its first delivered message.
