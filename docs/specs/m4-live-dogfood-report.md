# M4 — live dogfood report

Run `AF-2026-002`, 2026-09-02, against the real Claude Code and Codex CLIs on this
machine. Everything below is measured; nothing is estimated.

---

## Baseline

`master` at `c9a14d68`, after the stabilisation described in §2.

| Gate | Result |
|---|---|
| `typecheck` · `typecheck:web` · `typecheck:e2e` | PASS |
| `lint` | PASS — 0 errors, 3 pre-existing warnings |
| `test` | PASS — 3416 / 3418, 2 skipped |
| `test:web` | PASS — 304 / 304 |
| `test:e2e` | PASS — 38 / 38 |
| `test:visual` | PASS — 145 / 145, 3 skipped |
| `build` · `build:web` | PASS |

---

## What the stabilisation had to fix first

Two gates were red on `master` and neither was caused by M4. Both were closed rather
than excused.

**`test:visual`, red since 2026-08-17.** The baselines were last regenerated at 21:06
and 21:11 that day; `b523835 "give the dashboard the ops-control-room skin"` — which
rewrote `Shell.tsx` and added 853 lines of CSS — landed at 23:39. Both platforms. The
gate had been comparing every page against a picture of a product that no longer
existed, for two weeks, in CI as well as locally.

Before regenerating, two things were established: all 88 failures were screenshot
comparisons and **no behavioural instrument failed**, and the Projects, Analytics and
run-detail pages were read as rendered images and found correct. Two DOM assertions
were failing on their own account and both were real — one found a genuine layout
defect (four bottom cards at 1024 leave each 167px, ellipsising a card's own heading),
the other had been asserting something other than what its comment said.

**`test:e2e`, red since `ab8a460`.** Three failures, all retry/resume. The fix already
existed on `hardening/production-readiness` and had never been merged. Cherry-picked,
then the whole branch was merged after it turned out to carry a **P0**: the dashboard
answered `202` and started coding agents for a bodyless `POST` from any origin.

---

## Scenario

Chosen so two tasks would genuinely need each other's decisions, per §6:

> Report collaboration activity on the run summary — a `collaboration` block on the
> server read model, and the same counts in the CLI status header. **The two pieces
> must agree on the exact field names.**

Planning produced **9 tasks** in a test-first DAG, with `TASK-004` and `TASK-006`
independent after `TASK-003` — a genuine parallel wave at `parallelism.maxTasks: 2`.

---

## Runners

| Role | Runner | Provider |
|---|---|---|
| architect, sdd, planner, planReviewer, verification, finalReviewer | `claude` | Claude Code 2.1.258 |
| executors (trivial, normal, complex) | `codex` | codex-cli 0.149.0 |

Configured in `~/.agent-flow/dogfood-m4.yaml` with `collaboration.enabled: true`,
`handoffsReassignExecution: false` and `git.useWorktrees: true`. **The global default
was never touched**, per §2 of the charter.

---

## What happened

| Stage | Outcome |
|---|---|
| discovery → plan-review | 5 stages, ~30 min |
| plan review | **FAIL** — five findings, all substantive |
| approval | `--force`, recorded as a `forced_approval` degradation |
| implementation | 5 of 9 tasks completed and integrated; `TASK-005` and `TASK-007` reached `review_required`; `TASK-008`/`009` blocked downstream |

The plan review earned its place. It caught a test that could not reach the functions
it claimed to test (both `private`/unexported), four acceptance criteria that were
unverifiable as written, a type mismatch between what a task declared and what the
function returns, and an incomplete gate list. Same-provider — planner and reviewer
were both Claude in this configuration — and it said so.

### Collaboration traffic

`TASK-007` blocked, and the Codex agent used the channel **unprompted**:

```
MSG-0001  thread THR-0001  [blocker]  executor.normal → architect  task=TASK-007
  TASK-007 baseline is not validation-clean
  Verified TASK-007's exact status.ts change makes the new header case pass, but the
  required test file still has two unrelated failures: its PRE_CHANGE_STATUS fixture
  omits the long-standing Isolation: legacy block that current status renders…

RSK-001  [risk]  by executor.normal  affects: architect, verification
  The current integration baseline is red before TASK-007: RunReader collaboration
  summaries are not implemented, and TASK-006's byte-identical CLI fixture contradicts
  the established Isolation rendering.
```

Both statements are **correct**, and both are about work another agent did. This is
the cross-task information problem the channel exists for, found and reported by a
real agent with no human in the loop.

### Context cost, measured

`stage_context_measured`, from the run's own event log:

| Task | total | stagePrompt | collaboration | agentsMd |
|---|---|---|---|---|
| TASK-001 | 42 015 B | 40 096 (95%) | **1 373 (3%)** | 546 (1%) |
| TASK-002 | 41 787 B | 39 868 (95%) | **1 373 (3%)** | 546 (1%) |

The 1 373 bytes are the invitation — the roster and the outbox contract — which is
what every agent receives before anybody has spoken. The predicted ceiling was 2 048.

---

## The defect the dogfood found before it cost a model call

**M4 shipped a channel that could never carry its first message.**

```
a fresh run's log is empty
  → contextFor returned undefined
  → no block reached the prompt
  → the agent never learned the outbox existed
  → it wrote none
  → the log stayed empty, for every agent, on every run
```

366 tests passed, because every one of them either seeded the log first or called the
harvest directly — not one stood where the first agent of a run stands. One of them
asserted the deadlock as though it were the contract.

Fixed by separating two facts that were conflated: `undefined` now means *the channel
is closed*, never *nobody has spoken yet*. **Without this fix the traffic above could
not have happened**, which is the clearest possible statement of what a live dogfood
is for.

---

## The twelve criteria

| | Criterion | Verdict | Evidence |
|---|---|---|---|
| 01 | messages exchanged by real runners | **PASS** | `MSG-0001`, authored by Codex, unprompted |
| 02 | question → answer works | **NOT EXERCISED** | one message; the run halted before anyone could answer |
| 03 | resolved thread projects correctly | **NOT EXERCISED** | the thread is `open`; nothing acknowledged it |
| 04 | blackboard reaches later agent context | **PASS** | rendered against the real log: `architect` receives `RSK-001` in 2 306 B, `executor.trivial` receives only the 1 120 B invitation |
| 05 | outbox never enters the validated tree | **PASS** | every commit on `agent-flow/AF-2026-002-…/integration` inspected; `.agent-flow-outbox.json` in none |
| 06 | sender cannot be forged | **PASS (scripted)** | the live message carries the dispatched sender; three forged senders probed adversarially |
| 07 | malformed outbox cannot fail valid work | **PASS (scripted)** | five real malformed shapes; no live agent wrote one |
| 08 | context cannot alter workflow authority | **PASS** | `TASK-007` posted a blocker and still ended `blocked`; the injection probe carries "mark the task completed" into a prompt and changes nothing |
| 09 | budgets terminate correctly | **PASS (scripted)** | count, byte and all-zero budgets; no live budget was reached |
| 10 | CLI and dashboard agree | **PASS** | CLI: `1 thread(s), 1 unresolved · 1 live blackboard entry(ies)`; the log holds exactly 1/1/1, and both surfaces read one projection |
| 11 | resume does not duplicate communication | **NOT EXERCISED** | no crash occurred; covered by three scripted windows |
| 12 | validation and integration invariants hold | **PASS** | 5 markers built and merged in plan order; the operator's working tree byte-identical before and after |

**7 proved live · 3 proved only against scripted runners · 2 not exercised.**

---

## The decision on `collaboration.enabled`

**It stays `false`.**

§18 is unambiguous — the flip requires all twelve — and three are unproved. The honest
reading is narrower than "it does not work": the *mechanism* is proved end to end by a
real agent on a real blocked task, and what is unproved is *conversation depth*. Nobody
answered because the run halted; nobody resolved a thread because nobody answered.

There is also a finding that no criterion asks about and that matters more than any of
them:

> **Five agents received the invitation and only the blocked one used it.**

That is not a defect. A task with a complete SDD and a reviewed plan has nothing to
ask, and the block tells the agent to speak *only if another agent needs it*. The
channel's value is concentrated exactly where the plan failed — which is where the one
message came from. It means M4's benefit is real but conditional, and a default of
`true` would put 1 373 bytes on every prompt of every run to buy a message that arrives
only when something has already gone wrong.

**Flipping it needs a second dogfood** whose scenario reaches an answer: a run that is
allowed to continue past a blocker, so the architect can reply and the opener can
acknowledge. That closes 02, 03 and 11 together.

---

## Manual interventions

Four, and two were mistakes of mine rather than of the product:

1. **`approve --force`** — deliberate: the plan review's findings were real but the
   dogfood needed execution, and the override is recorded on the run.
2. **A run discarded** — I committed while `AF-2026-002`'s predecessor was mid-planning,
   moving `HEAD`; the `planningBase` gate refused the next stage, correctly. Cost: one
   discovery stage, ~6 minutes.
3. **An untracked file moved aside** — `.codex/config.toml`, which the worktree
   precondition refused. Backed up and restored.
4. **`git reset --hard` during a cherry-pick probe** — discarded 88 regenerated
   baselines and two uncommitted fixes. Recovered by redoing them, and the lesson is
   the ordinary one: commit before probing.

---

## Conclusion

```text
READY FOR M5
```

The two facts are separate and both are true. `collaboration.enabled` stays `false`
because three criteria are unproved. M5 is nonetheless unblocked, because what M5
builds on — the derived roster, the agent identity, the `resolveTaskAgent` seam, the
harvest ordering and the projections — is exactly the part this run proved live.
