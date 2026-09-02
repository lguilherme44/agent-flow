# M5 — live dogfood report

Two runs, real runners, two providers. `AF-2026-005` is the scenario the milestone was
judged on; `AF-2026-006` exists because the first one found a defect that needed a live
path to verify, and that path is not one a plan produces by accident.

**Six defects. Five of them were invisible to 3 657 passing tests, and two were invisible
from outside the product entirely** — the task ran, so nothing failed.

---

## What ran

A throwaway order service at `~/wk/m5-dogfood`: three areas on purpose — `src/server`,
`src/db` and `apps/web` — so ownership has something to own.

| | |
|---|---|
| Providers | Claude Code CLI (`claude` 2.1.258) and AGY (`agy` 1.1.22), both authenticated |
| Members | 3 — `backend` on claude, `dba` on agy, `frontend` on agy |
| Runs | `AF-2026-005` (5 tasks) and `AF-2026-006` (3 tasks) |
| Concurrency | 4 tasks in one wave, measured |
| Configuration | outside the repository, because an isolated run refuses a dirty tree |

---

## The six defects

Three were found before a single agent ran, by reading a real plan. Three were found by
reading what the run recorded.

### 1. A member served one role, and a real plan does not

The first plan routed **one** of its seven tasks to `executor.normal`, **four** to
`executor.complex` — the planner flagged them `crossModule` or `architectureDecision`,
and the router escalates those — and **two** to `executor.trivial`.

A team whose members each declared one role had a candidate for one task in seven. The
other six fell back to the router before anything ran.

`roles` now takes a role or a list. A person is not three people because a task carries a
flag, and a team that has to be written three times is a team nobody writes.

### 2. Two members holding one area exclusively excluded each other

Covering one area across two roles means declaring it twice, and reading the second
declaration as a rival claim left `src/db/**` with no eligible member at all.

`exclusive` means "this area takes one writer at a time, and these are who may be it".
Keeping it to one at a time is the wave constraint's job.

**Invisible from outside**: the task fell back to the router and ran.

### 3. A member's capability was resolved against the role's runner

`resolveRole` reads `roles.<role>.runner`, and on a team the member declares its own. A
member on an inference endpoint passed the implementation capability check because the
role it serves pointed at a coding agent. `AF-2026-006` shows the fix working: `dba`, on
an OpenAI-compatible endpoint, is excluded as `runner_capability` on every task.

### 4. A retry excluded its own agent

`TASK-002` was assigned to `dba`, failed its review, and its retry reported:

```
no_eligible_member — No configured member can take TASK-002: 1 capacity, 2 ownership.
```

The scheduler marks a task `running` before dispatching it, so on a retry the task is
already running *and* already carries an assignment — and counting it made its own agent
look full. **A capacity-1 member could never retry its own work.**

**Invisible from outside**: the retry ran on the router's role and completed.

My own crash suite asserted this exact scenario and passed, because it asserted the
policy with an empty in-flight map rather than the executor's counting. The fixture
agreed with the bug.

### 5. The explanation was false

The run printed, for `backend` on a task routed to `executor.complex` — a role `backend`
serves:

```
role is not the one the router would have chosen
```

Chasing it found the term underneath was also wrong. `riskFitOf` re-routed the task to
compare against, when `requirements.role` already *is* `routeTask`'s answer; and as
specified the term asked a question eligibility already answers, so among eligible
candidates it was constant. It now asks whether the routed role is the member's *main*
one, and says so:

```
backend scored 0.54 — skills javascript, http, server of backend, javascript, http,
server; ownership 0.50; this is a role it also serves
```

### 6. The M4 deadlock came back

**One implementation prompt in six went out with no mention of the coordination channel.**

| | bootstrap bytes |
|---|---|
| TASK-001, 003, 004, 005 and TASK-002's first attempt | 772 |
| TASK-002's retry | **0** |

`contextFor` looked the agent up in the roster and returned silence when it found nobody,
and the bootstrap was composed after that lookup. The path needs three things at once: a
team, a task no member can take, and a fallback role that a member *does* staff — because
a team roster carries a legacy role identity only for the roles no member staffs.

This is §0's first fact, reintroduced through a seam M5 added. `AF-2026-006` was built to
reproduce it and confirms the fix live: `TASK-001` falls back with
`no_eligible_member — 2 ownership, 1 runner capability`, and its prompt carries 772 bytes
of bootstrap.

---

## What the runs measured

### Assignment

```
AF-2026-005
TASK-001 → dba       team_match          dba scored 0.74 — skills sql, schema, persistence
                                         of database, sql, schema, persistence;
                                         ownership 0.50; this is its main role
TASK-003 → backend   team_match          role executor.complex, served as a secondary
TASK-004 → backend   team_match          score 0.00 — frontend scored 0.738 and was full
TASK-005 → frontend  team_match          role executor.normal
TASK-002 → dba       team_match          then, on retry, no_eligible_member (defect 4)
```

Four tasks ran in one wave, on two providers. `TASK-002` was held for ownership:

```
wave_deferred_for_ownership: TASK-002 waits for TASK-001
  TASK-002 and TASK-001 both write into src/db/**, which is declared exclusive.
  One writer at a time was the point of declaring it.
```

Neither task names a path the other names. **File overlap sees nothing there**; only the
declaration does, which is the whole reason ownership is a separate question.

### Prompt cost

| | AF-2026-005 | AF-2026-006 |
|---|---|---|
| implementation prompts | 6 | 3 |
| bootstrap, bytes/task | 772 | 772 |
| context, bytes | 0 | 0 |
| tasks receiving a payload | 0 of 6 | 0 of 3 |
| M4 would have spent | 8 238 B | 4 119 B |
| M5 spent | 3 860 B | 2 316 B |
| **saved** | **53 %** | **44 %** |

The 53 % includes the missing bootstrap on the retry, so the honest post-fix figure is the
44 %: the channel now costs 772 bytes a task instead of 1 373, unconditionally, and
nothing more unless something relevant exists.

The scripted ten-task measurement, where two tasks *do* have relevant history, reports
**M4 13 730 B · M5 9 308 B · saved 32 %** — lower than the live figure precisely because
two of its ten tasks earn a payload and none of these nine did.

---

## The nine questions

**Did assignment choose the agent a human would expect?** Eight of nine, yes, and the
reasons read correctly. The ninth is below.

**Was the explanation correct?** Not at first — defect 5. It is now, and the sentence is
the thing that made the defect findable at all.

**Did capacity serialize only what needed serialization?** Yes, and once it did something
a human would question. `TASK-004` — `apps/web/format.js` — went to `backend` with a
score of **0.00**: no matching skills, no ownership, a secondary role. `frontend` scored
0.738 and was excluded for capacity.

That is the design working as written: a member with room takes it rather than the task
waiting. But **"the best available" and "good enough" are different claims, and the
policy currently makes only the first.** A task assigned at 0.00 is one nobody on the team
is suited to; running it anyway is a choice, and right now it is an implicit one. A floor
below which the policy prefers to wait a wave is the obvious answer and it is a design
decision, not a bug fix — recorded here, not taken.

**Did ownership prevent a real conflict?** Yes. Two files under one exclusive directory,
sharing no path, split across two waves. Overlap could not have caught it.

**Was useful parallelism preserved?** Yes — four of five tasks in one wave, across two
providers, with the fifth held for a stated reason.

**Did any agent need collaboration?** **No. Not one, across nine tasks.** Nine agents were
told the channel exists and none wrote an outbox — which is the same answer M4 got from
five, and now costs 772 bytes a task to keep asking instead of 1 373.

**How many received full context?** Zero of nine. Nothing was ever said, so nothing was
ever relevant. The mechanism is proved by the scripted ten-task test, where the two tasks
that have history get a payload and the eight that do not get none.

**What was the prompt byte cost?** 772 bytes a task for availability; 0 for relevance,
because there was none. Against M4's 1 373 unconditional.

**Did any routing decision surprise the operator?** Three.

1. Six of seven tasks falling back on the first configuration (defect 1).
2. `TASK-004` at 0.00 rather than waiting for the member that scored 0.738.
3. `TASK-002`'s retry being refused by its own occupancy (defect 4).

---

## What the run did not exercise

- **Handoffs.** No agent asked for one. Fabricating a dialogue to trigger the path would
  have proved that the fabrication works, so the handoff paths remain covered by the
  scripted suites alone.
- **Reassignment.** Same reason.
- **A collaboration payload.** Nothing was said, so nothing was relevant.

## Manual interventions

- Four planning cycles were spent before one produced a plan that both satisfied the
  overlap gate and had parallel structure. Two were refused by gates working correctly:
  one by `checkPlan` (three independent tasks writing one test file) and one by the plan
  reviewer, with verified findings about acceptance criteria satisfiable by tests that
  cannot fail.
- `AF-2026-004` was approved with `--force` over a `FAIL` verdict whose findings were
  about acceptance-criteria strength rather than the DAG. Recorded on the run, and the
  run was superseded before it executed.
- The project's `install` command was changed from `npm install`, which wrote a
  `package-lock.json` into every fresh worktree and tripped the setup check — correctly.
