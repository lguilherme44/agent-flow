# Roadmap

What is done, what is being built now, and what is deliberately not being built.

The normative source for MVP 2 is
[`specs/mvp2-safe-parallel-execution.md`](specs/mvp2-safe-parallel-execution.md).
Where this page and that document disagree, the specification wins — and where the
specification and the code disagree, **the code is the current truth**.

```text
MVP 1  ─────────────────────────────────►  the execution foundation, complete
MVP 2  ────────────►                       Git-isolated execution, in progress
                    ▲
                    you are here: M2-06 done, M2-07 next
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

## MVP 2 — Safe Parallel Execution · in progress

**The order matters and is not negotiable: isolation first, parallelism last.** The
milestone raises the concurrency ceiling in its *eleventh* item, after every guarantee
that makes raising it safe is in place. Until then `effectiveConcurrency` resolves to
1 however `parallelism.maxTasks` is written.

| | Milestone | Status |
|---|---|---|
| M2-00 | Current concurrency safety (baseline, landed before the milestone) | **done** |
| M2-01 | Pure worktree policies and naming | **done** |
| M2-02 | `GitCommand` and `GitWorkspaces` | **done** |
| M2-03 | Run identity capture and `planningBase` gates | **done** |
| M2-04 | Workspace lifecycle and setup cleanliness | **done** |
| M2-05 | `TaskAttemptResult`, trusted receipt, marker | **done** |
| M2-06 | Deterministic Integrator and integration-tree verification | **done** |
| M2-07 | Crash recovery | **next** — not started |
| M2-08 | Retry semantics and attempt retention | not started |
| M2-09 | Git-aware cleanup | not started |
| M2-10 | Read models, CLI and Web observability | not started |
| M2-11 | Parallel scheduler activation | not started |
| M2-12 | E2E, dogfood and documentation | not started |

### What each of the completed items actually delivered

**M2-00 — the baseline.** `StateStore.updateRun` serialised per state file so two
read-modify-writes cannot lose an update; an attempt spent by explicit dispatch rather
than by observing `running`; and `parallelism.maxTasks` separated into *intent* and
*instruction*, with the reduction recorded on the run as a `parallelism_clamped`
degradation instead of happening quietly.

**M2-01 — the naming, as pure functions.** `repoKey`, `gitRunKey`, ref names and
workspace-relative paths all decided in `src/core/worktree-policy.ts`, with no
filesystem and no Git, so they can be tested exhaustively against traversal and
injection payloads. The new state fields are additive and optional, so a run written
before MVP 2 still loads.

**M2-02 — one Git spawner.** Every internal Git invocation goes through
`GitCommand`, which takes its subcommand from a closed list and injects an owned,
empty `core.hooksPath` *before* the subcommand — so no caller argument can override
it. No user Git hook fires inside an Agent Flow operation. The Git floor was
determined empirically rather than assumed: **2.33.0**, the release where
`git worktree add --lock` learned `--reason`.

**M2-03 — a run is born with its identity.** `gitRunKey`, `planningBase` and
`isolationMode` are captured by `createRun`, together, and never rewritten.
`git.useWorktrees` is read in exactly one module at exactly one moment; every later
reader takes `state.isolationMode`. Execution preconditions are a check that writes
nothing, so a refusal costs a run nothing and the next attempt is free.

**M2-04 — a prepared workspace, or no run.** Each dispatched attempt gets its own
locked worktree, asserted clean on checkout, set up with the project's install
command, and asserted clean again. A failed preparation refuses the task without
invoking the agent. `doctor` gained an install-cleanliness probe, because the default
`npm install` rewrites `package-lock.json` and would otherwise make worktree mode look
broken on first contact.

**M2-05 — the trust root.** Validation runs, the expectation is judged, *then* the
tree is captured and a 128-bit nonce is minted — so the nonce does not exist while the
agent is alive. The attempt artifact is written once, atomically, outside every
worktree. The marker commit is built with `commit-tree` from that artifact, which
makes it a deterministic function of persisted state rather than of whatever an index
happened to hold.

**M2-06 — deterministic integration.** Integration is serial, in the plan's stable
topological order, in a dedicated integration worktree — never the user's working
tree. The Integrator is the **only** writer of `completed`: a task is complete when
its work is on the integration branch, not when its agent exited. Final verification
and final review both run against that one tree, under the run execution lock, and the
commit they describe is recorded on the run as `integrationHead`.

### M2-07 — crash recovery · next

Every crash window enumerated in §17.3 of the specification gets a defined, tested
resolution, driven by a deterministic injected fault against real Git. The rule is
receipt-first: recovery reads the attempt artifact and uses the repository only to
confirm what the artifact already claims. A ref, a trailer or a commit message is
never sufficient on its own.

### The remaining items, and why they are ordered this way

- **M2-08** — a retry must always be a new attempt, on a new branch, in a new
  worktree, and must never destroy the previous attempt's evidence.
- **M2-09** — `agent-flow clean` becomes Git-aware: it reclaims worktrees and attempt
  refs, touches nothing foreign, and keeps an unmerged integration branch, because
  that branch is the run's product rather than its debris.
- **M2-10** — the CLI and the dashboard learn to show what an isolated run is doing.
  A parallel run whose state cannot be read is a parallel run nobody can debug, which
  is why this lands *before* parallelism rather than after it.
- **M2-11** — `effectiveConcurrency > 1`. One edit plus its wiring, and the last
  functional item on purpose. Landing it early would be the M2-00 defect with extra
  steps.
- **M2-12** — E2E, dogfooding on two stacks, and the documentation the milestone owes:
  every refusal code and its fix, the new test layers, and what dogfooding revealed.

---

## Explicitly out of scope for MVP 2

Named because they were considered and decided, not because they were forgotten.

```text
automatic conflict resolution          model escalation after repeated failure
cloud / remote workers                 distributed scheduler
GitHub PR automation                   monorepo-aware scheduler
cross-machine execution                remote auth
automatic config writes                npm publishing
pause / resume / cancel                per-wave verification as a gate
```

`cancel` was examined against this milestone's safety requirements and found not to be
required by it: a killed coordinator is already a first-class case, so the failure mode
`cancel` would introduce is one recovery already has to handle. §30 of the
specification lists the rejected designs and the evidence behind each rejection.

---

## Beyond MVP 2

Not specified, not committed to, listed so the boundary is visible:

- model escalation after repeated failure
- monorepo workspaces
- publishing to npm, and a tagged release
