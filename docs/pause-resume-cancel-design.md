# AF-L03 — Pause, resume and cancel, by design

**Status: design only. Nothing in this document is implemented, and
`RUN_STATUSES` is unchanged.**

§86 lists these three endpoints. They do not exist because the core has no
semantics for any of them, and an endpoint that set a status field would be a
button that lies about what it did. This is what the semantics would have to be.

## What exists today

- `RUN_STATUSES` — `running`, `waiting_for_approval`, `plan_rejected`, `approved`,
  `completed`, `failed`. No paused, no cancelled.
- `TASK_STATES` and the §22 transition table, enforced in `StateStore.updateRun`.
  A task may be `queued`, `ready`, `running`, `completed`, `failed`, `blocked`,
  `review_required`, `interrupted`.
- `Scheduler.run(plan, runId, sdd, previous, options)` — runs to completion. It has
  no abort signal and no return path between tasks.
- `TaskExecutor` awaits `ProcessRunner.run`, which spawns a CLI and waits. A
  running task is a child process this tool is blocked on.
- `interrupted` already exists and already means the right thing: a task found in
  `running` that nothing is executing, recorded when a later run notices. That is
  the state a killed process leaves behind, and it is the hook the whole design
  below hangs from.

## The decision that comes first

**Pause and cancel are not the same kind of operation, and conflating them is the
trap.** Pause is cooperative: it asks the scheduler to stop starting work. Cancel is
destructive: it ends work that is already running. They need different machinery and
should not ship together.

Nothing below requires terminating an agent mid-flight *for pause*. That is what
makes pause the cheap one and cancel the expensive one.

## pause

### What happens to a task that is running?

Nothing. It finishes.

The alternative — killing it — throws away work that has already been paid for and
leaves the repository in whatever half-edited state the agent had reached. A task is
the unit of atomicity in this workflow: its result file is written once, at the end,
and there is no partial result to keep. So pause means "stop starting tasks", and the
in-flight one runs to its natural end.

That makes the observable behaviour "pausing…" then "paused", and the UI has to show
both. A pause that claimed to be immediate would be the same lie the endpoint was
avoiding.

### When does the scheduler stop?

At the top of its dispatch loop, between tasks. Which requires the one change to the
core this feature actually needs:

```text
Scheduler.run(..., options: { signal?: AbortSignal })
```

checked before each dispatch, not during. On abort, the scheduler stops dispatching,
awaits whatever is in flight, and returns its `SchedulerOutcome` with a new
`haltedBy: 'paused'`. No task state changes, because no task was interrupted.

### Where does "paused" live?

**Not in `RUN_STATUSES`.** A run's status describes where it is in the workflow, and
"paused" describes what an operator asked for — those are different axes, and adding
a sixth status would make `waiting_for_approval` and `paused` mutually exclusive when
they are not.

Instead: a pause *request* on the run, e.g. `pauseRequestedAt` alongside
`approvedAt`. The scheduler reads it, the UI reads it, and the status field keeps
meaning what it means. This is a `RunStateSchema` addition rather than a
`RUN_STATUSES` change, and it needs its own approval.

### Who honours it?

Both entry points, or neither. The pause request is on disk, so a CLI `agent-flow
run` started after a pause must refuse to start — which means the pause check belongs
in the `start` use case, next to the approval gate, not in the server. That is the
same rule AF-L01 followed and for the same reason.

## resume

### Which states may resume?

A run with a pause request and no active execution lock. That is the whole
precondition, and both halves matter:

- **A pause request**, or there is nothing to resume — a run that was never paused
  should be started, not resumed, and the two commands should not be aliases.
- **No lock**, or something is still running. Resume must not mean "start a second
  scheduler", which is precisely what AF-L01 exists to prevent.

Resume clears `pauseRequestedAt` and calls the same `start` use case. It is not a
separate execution path; if it were, the gates would have to be duplicated into it.

Tasks left in `interrupted` — from a paused run whose in-flight task was killed by
something else — are already handled: the scheduler requeues them, and the attempt
counter has already moved, which is what stops that becoming an unbounded loop.

## cancel

The expensive one, and the one with a real decision in it.

### Is a running task terminated?

Yes, or cancel means nothing. And this is where cancel stops being cheap:
`ProcessRunner` already terminates process *trees* on timeout — SIGTERM, then
SIGKILL after a grace period, to the whole group — because a runner CLI spawns
children of its own and killing the parent leaves them running. Cancel reuses
exactly that path. It must not grow a second termination mechanism.

What the tool cannot do is un-edit files. A cancelled task may have written half its
changes to the repository, and Agent Flow does not own the working tree. So cancel
has to be honest about leaving the repository in an unknown state, and the
confirmation dialog has to say so in those words. This was the strongest argument for
worktrees, and MVP 2 has since built them: in worktree mode a cancelled task's edits
are confined to its own workspace, so cancel could discard one instead of leaving them
in a tree somebody is working in. That does not make cancel cheaper on the sequential
path, which is still the default and where this paragraph still applies in full.

### What state does the terminated task get?

`interrupted`. It already exists, it already means "was running and nothing is
executing it", and `interrupted → queued` is already legal. Inventing `cancelled`
for tasks would add a state whose only difference is *why* it stopped — and the why
belongs in the event log, which is where `run_cancelled` would go.

### What do queued tasks get?

They stay `queued`. They never started; there is nothing to record about them, and
moving them to a terminal state would lose the plan's remaining work. A cancelled run
that is later resumed should pick up exactly where it stopped.

### What state does the run get?

This is the one place a new `RUN_STATUSES` member is genuinely justified —
`cancelled` — because it is a terminal outcome that is neither `completed` nor
`failed`, and reporting a cancelled run as failed would make every dashboard, the
Definition of Done and `status --json` describe an operator's decision as a defect.

It is also the change that must not be made without approval, because
`RUN_STATUSES` is consumed by the state machine, the API contract, the runs list
filter, the analytics aggregate and the CLI. Adding a member is a contract change
across all of them.

## Process termination and the ProcessRunner

Cancel needs the scheduler's abort to reach `ProcessRunner`. The mechanism exists
and is already tested against grandchildren; what is missing is plumbing:

```text
cancel → AbortSignal → Scheduler (stop dispatching)
                    → TaskExecutor (abort the in-flight task)
                    → ProcessRunner (SIGTERM tree → grace → SIGKILL tree)
```

`ProcessSpawnOptions` would take the signal; the timeout path becomes one caller of
the same termination code rather than the only one. The result written for the
aborted task carries `errorCode: 'interrupted'` so provenance survives — actual
execution provenance always wins over configured intent, and "this was cancelled" is
provenance.

## Resume after a process crash — how it differs from pause

They arrive at the same place by different routes, and the difference is what the
run knows about itself.

- **Paused**: `pauseRequestedAt` is set, tasks are in coherent states, and the
  execution lock was released cleanly. Resume is a normal start.
- **Crashed**: no pause request, a task is stuck in `running`, and the execution lock
  is stale — its pid is gone. AF-L01 already supersedes the stale lock, and the
  scheduler already recovers the orphaned task to `interrupted` and requeues it.

So a crash needs no new command: `agent-flow run` already resumes it, and that is
worth preserving rather than replacing. The distinction to keep visible is that a
crashed run *lost* something — an attempt was spent with nothing to show — while a
paused run lost nothing. The event log already records enough to tell them apart, and
after AF-L01 it records the stale lock recovery too.

## Order of work, if this is approved

1. `pause` — `pauseRequestedAt` on the run, an `AbortSignal` on the scheduler
   checked between tasks, and the check in the `start` use case so both entry points
   honour it. No task is ever interrupted. No new run status.
2. `resume` — clears the request and calls `start`. Nothing new.
3. `cancel` — the signal through `TaskExecutor` into `ProcessRunner`'s existing
   tree-termination, `interrupted` for the running task, `queued` untouched, and a
   new `cancelled` run status. This is the step that changes a contract, and it needs
   its own approval.

Until step 1 lands, the endpoints stay absent and the architecture test that fails on
a `/pause` route stays green.
