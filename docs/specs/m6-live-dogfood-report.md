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

Both by `reviewer` on the other provider from the author, so **independence 3** — the
maximum, and a fact rather than a configuration aspiration.

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

## Defects this dogfood found

Every one of them survived 3893 green tests, and every fix carries a positive control.

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

### 4. Corrective tasks were ordered only against each other — MEDIUM

`applyFixes` derived file-overlap ordering among the new tasks only, reasoning that an
existing task has already run. `review --fix` on a run that *halted* falsifies the premise:
three tasks had never run, four fixes declared the same files, and `checkPlan` refused the
entire plan for contention. The corrective round produced nothing.

Fixed by deriving against the whole plan. Safe because the helper only adds edges from
later entries to earlier ones and the fixes are appended last, so every edge points from a
fix into the plan and never the reverse.

---

## Limitations, stated rather than fixed

### A required quality gate no task runs stays `not_run` forever

`lint` is `required: true`, and the planner gave TASK-001 and TASK-003 `validation: ['test']`.
So `lint` never ran for them, the projection reports `not_run`, and — correctly — that
blocks. But nothing forces a required gate onto a task, so those two tasks can never reach
a quality decision, and no command in the product resolves it.

Not changed, deliberately. The behaviour **fails safe**: nothing is falsely green, the
`✗` is visible, and a person sees exactly which gate did not run. Making a task's validation
the union of its declared ids and the applicable required gates is the right fix and it is
a change to execution semantics — the wrong thing to land late in a milestone on the
evidence of one scenario. Recommended for M7.

### A corrective task is not ordered against the criteria that depend on it

Described above. The generator orders by declared file overlap; a fix to a *test* that an
*implementation* task's acceptance criteria reference shares no file with it. The plan
review catches it, which costs a model call and a human revision. Making it mechanical
would mean reading acceptance-criteria prose for task references, which is exactly the kind
of inference this product refuses to make silently.

### `collaboration.enabled` — the recommendation, with the data

| Milestone | Invocations | Messages delivered | Outbox attempts |
|---|---|---|---|
| M4 | 12 | 1 | 1 |
| M5 + gap closure | 9 | 0 | 0 |
| M6 scenario 1 | 6 | **0** | **4** |

The earlier conclusion was "nobody uses it". That is now wrong. After Phase A gave the
bootstrap a handoff form and stated ownership, agents used the channel in four of six
implementation prompts — and the product rejected all four as malformed.

So the honest reading is not *unused*, it is **unusable as specified**: the shape is
described in prose and cannot be reproduced from prose. Defect 3 above is what will produce
the evidence to fix it; until a run shows which fields agents actually get wrong,
`collaboration.enabled` stays `false` and the cost stays measured — 910–1081 bytes per
implementation prompt, about 2% of a 50 KB prompt.

### What review actually costs

| Stage | Prompts | Bytes | Per prompt |
|---|---|---|---|
| implementation | 6 | 317,811 | 52,969 |
| **code-review** | **2** | **13,679** | **6,840** |
| final-review | 2 | 131,326 | 65,663 |

The spec's own §17 critique argued that per-task review doubles the model calls and that
nobody had priced it. Priced: it doubles the *calls* and adds **13%** of an implementation
prompt in context. The selective review context of §45 is why — the reviewer sees the
change and the criteria, not the repository.
