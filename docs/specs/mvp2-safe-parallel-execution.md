# MVP 2 — Safe Parallel Execution

## 0. Status and scope

**Status: in implementation. M2-00 … M2-06 have landed; M2-07 … M2-12 have not.**

Per-item status is recorded on each work item in §28 and summarised in
[`../roadmap.md`](../roadmap.md). **The design in this document is unchanged by
implementation** — where a probe changed a decision, the item says so in its own
*What landed* note, and the body was amended at the same time. Sections describing
items that have not landed still describe a design rather than the code.

Baseline commit: `e24dd48` (`fix: harden task concurrency before worktree isolation`).
At that commit `MAX_SUPPORTED_TASK_CONCURRENCY = 1`, no production path creates a
worktree, and an architecture test fails if one appears.

**`effectiveConcurrency` is still 1.** `MAX_ISOLATED_TASK_CONCURRENCY = 8` exists in
`core/concurrency.ts`, and `execution-context.ts` deliberately does **not** pass the
mode into the resolver — an architecture test fails if it starts to. That edit is
M2-11 (§29), and it is the eleventh of twelve items on purpose.

This document is the implementable contract for this milestone. It supersedes
§19 and §47–§48 of [`implementation-spec-v3.md`](implementation-spec-v3.md) wherever
the two disagree — that document describes worktrees under `.agent-flow/worktrees/`
and a scheduler that creates them, and both decisions have since been rejected on
evidence. Spec v3 remains the historical record of what was designed and shipped for
MVP 1; **the code is the current truth, and this document is the current design.**

Keywords **MUST**, **MUST NOT**, **SHOULD**, **MAY** are used in the RFC 2119 sense.
Three labels separate the timeframes and are used throughout:

| Label | Meaning |
|---|---|
| **current** | True at `e24dd48`. Do not re-implement. |
| **MVP 2** | What this milestone builds. |
| **deferred** | Deliberately not built. Named so the boundary is visible. |

### What this milestone delivers

Independent tasks of an approved plan execute concurrently, each in its own locked
Git worktree, are integrated serially in a deterministic order onto a single
integration branch, and survive a crash at any point through evidence written to
disk rather than through inference from repository shape.

### What it does not deliver

No automatic conflict resolution, no model escalation, no remote or distributed
execution, no PR automation, no monorepo scheduler, no `pause`/`resume`/`cancel`.
See §30.

### Priority order

```text
safety  >  determinism  >  auditability  >  recovery  >  correctness  >  throughput
```

Throughput is last on purpose. A milestone that made runs faster and made one run in
fifty produce an unexplainable tree would be a regression, and isolation has value
even where it produces no speedup at all (§27).

---

## 1. Why this milestone exists

**Current.** Every task of a run writes to the same working tree. That is why
`parallelism.maxTasks: 4` is accepted, recorded as intent, and resolved to one at
runtime. Raising it without isolation would give four implementation agents one
working tree, one `git status`, one `AGENTS.md` and one set of validation commands —
and each agent's validation would be judging a tree the other three were editing.

Isolation is the point; parallelism is the consequence. Three properties the
sequential mode does not have today follow from worktrees alone, and would be worth
building even at concurrency 1:

- **The user's working tree stops being the build surface.** Today an implementation
  run edits the tree the user has open in their editor. Under MVP 2 it does not
  (§19.3).
- **A task's diff is separable.** Today the accumulated diff at review time is every
  task's work superimposed. Under MVP 2 each task has a tree, a base and a marker.
- **A failed task leaves evidence rather than debris.** Today a task that failed
  halfway leaves its partial edits in the shared tree, mixed with the successful
  tasks' work.

---

## 2. Existing baseline — M2-00

**M2-00 — Current Concurrency Safety · STATUS: COMPLETED BEFORE MVP 2 IMPLEMENTATION**

M2-00 landed at `e24dd48` and is **not** a work item of this milestone. It MUST NOT be
re-implemented, and this specification depends on it.

| Sub-item | What it delivered | Where |
|---|---|---|
| M2-00.1 | `StateStore.updateRun` serialised per state file, so two read-modify-writes cannot lose an update. §22 transition machine enforced in the same place. `appendEvent` deliberately *not* serialised. | `src/app/state-store.ts`, `src/app/state-write-queue.ts` |
| M2-00.2 | An attempt is spent by an explicit dispatch, not derived from observing `running` during a write. | `Scheduler.persist(runId, states, dispatched)` |
| M2-00.3 | `parallelism.maxTasks` is intent; `resolveTaskConcurrency` produces the instruction. Runtime ceiling is 1. The reduction is recorded on the run as the `parallelism_clamped` degradation. | `src/core/concurrency.ts`, `src/app/execution-context.ts`, `src/app/run-actions.ts` |

Consequences this specification relies on:

- Workers **MAY** call `StateStore` concurrently. The single-writer queue is the
  protection, and MVP 2 **MUST NOT** add a second one (§18).
- The attempt counter already means "times this task was dispatched", so retry
  semantics (§16) inherit a counter that is already correct under fan-out.
- Raising the effective ceiling is a single edit in one pure module, which is why it
  can be the last step of the milestone (§29).

---

## 3. Invariants

These hold for the whole milestone. Every one of them has a test in §26 and most
have an architecture test in §26.1. A change that violates one is a change to this
specification, not an implementation detail.

**I-1 — `StateStore` is the source of truth; `events.jsonl` is the audit trail.**
Neither becomes a Git index. `StateStore` executes no Git command and imports
nothing from `src/adapters/git/`.

**I-2 — There is one DAG implementation** (`src/core/dag.ts`), one scheduler
(`src/app/scheduler.ts`), one inter-process run lock (`src/app/run-execution-lock.ts`)
and one project registry. MVP 2 adds no second workflow engine, no distributed
scheduler and no additional database.

**I-3 — No task reaches `TaskState.completed` before its work is on the integration
branch.** In worktree mode `completed` means *integrated*. Only the Integrator
(§14) may write it.

**I-4 — A validation expectation is judged exactly once**, inside the task's own
worktree, against that task's base. It is never re-judged after integration (§13).

**I-5 — Evidence precedes trust.** Recovery reads the attempt artifact first and
uses the repository only to confirm what the artifact already claims. A ref, a
trailer or a commit message is never sufficient on its own (§17).

**I-6 — A marker commit's tree is the validated tree.** `rev-parse <marker>^{tree}`
MUST equal `attempt.receipt.validatedTree`, and a mismatch is a refusal, never a
repair.

**I-7 — No Git hook runs inside an Agent Flow Git operation.** Every internal
invocation goes through one wrapper that injects an owned empty `core.hooksPath`
(§12.3). Agent Flow never writes to `git config`.

**I-8 — The browser supplies ids, never paths, refs, branches or commands.** The
server resolves every trusted value from run state and the Git registry (§21, §22).

**I-9 — Integration order is the plan's stable topological order**, never completion
order (§14.2).

**I-10 — The user's working tree is not written to during implementation** (§19.3).

**I-11 — `effectiveConcurrency > 1` is possible only when a run is admissible for
worktree mode.** Without isolation the resolver returns 1 however the configuration
is written (§4.4, §29).

**I-12 — Every attempt is a fresh worktree and a fresh branch.** A retry never
reuses a previous attempt's workspace, and never overwrites its evidence (§16).

**I-13 — A run's isolation mode is captured when the run is created, and is
immutable.** `git.useWorktrees` is read once, by `createRun`, before anything observes
the repository. No later configuration change moves a run between modes, no execution
chooses a mode, and a precondition refusal does not change one (§6.1, §6.4).

---

## 4. Execution architecture

### 4.1 Component map

```text
CLI / HTTP  ──►  app/run-actions.ts  ──►  Scheduler ──► TaskWorkspaces ──► TaskExecutor
                        │                    │                │                  │
                        │                    └──► Integrator ─┤                  │
                        ▼                                     ▼                  ▼
                   StateStore                            GitWorkspaces      StageRunner
                (source of truth)                              │            (agent, cwd =
                                                               ▼             the worktree)
                                                          GitCommand
                                                    (the only spawner of `git`)
```

New modules introduced by MVP 2:

| Module | Layer | Responsibility |
|---|---|---|
| `src/core/worktree-policy.ts` | core, pure | `repoKey`, `gitRunKey` validation, ref names, workspace-relative paths. No I/O. |
| `src/core/concurrency.ts` *(extended)* | core, pure | Resolves a configured limit against a declared isolation mode. |
| `src/adapters/git/git-command.ts` | adapter | The single hook-isolated `git` spawner. |
| `src/adapters/git/git-workspaces.ts` | adapter | Worktree add/lock/remove/prune, `write-tree`, `commit-tree`, `update-ref`, `merge`, ancestry, `cat-file`. |
| `src/app/run-git-identity.ts` | app | Captures `gitRunKey`, `planningBase` and `isolationMode` at run creation — the only reader of `git.useWorktrees`; evaluates execution preconditions. |
| `src/app/task-workspaces.ts` | app | Attempt workspace lifecycle: create → assert clean → setup → assert clean. |
| `src/app/attempt-receipt.ts` | app | Nonce, validated tree, attempt artifact, marker construction. |
| `src/app/integrator.ts` | app | Serial deterministic integration and the only writer of `completed` in worktree mode. |
| `src/app/worktree-recovery.ts` | app | Receipt-first crash recovery. |
| `src/contracts/attempt.schema.ts` | contracts | `TaskAttemptResultSchema`. |

### 4.2 Two workspace modes, one executor

`TaskExecutor` **MUST NOT** know about the DAG, about waves, or about worktrees. It
receives a workspace and uses it.

```ts
export interface TaskWorkspace {
  /** Absolute path the agent and the validation commands run in. */
  readonly path: string;
  /** Which attempt this is. Matches the persisted attempt counter. */
  readonly attempt: number;
  /** Present only in worktree mode. */
  readonly isolation?: {
    readonly base: string;        // 40-hex commit
    readonly branch: string;      // agent-flow/<gitRunKey>/<taskId>/attempt-<n>
    readonly relativePath: string;// <repoKey>/<gitRunKey>/<taskId>/attempt-<n>
  };
}
```

- **Sequential mode (current, preserved).** `path` is the project directory,
  `isolation` is absent. Behaviour is byte-for-byte what `e24dd48` does.
- **Worktree mode (MVP 2).** `path` is the attempt worktree, `isolation` is present.

`TaskExecutor` changes in exactly three places: the agent's `workingDirectory`, the
validation `cwd`, and where `AGENTS.md` is read from. All three become
`workspace.path`.

> **This is load-bearing.** Today `AGENTS.md` is read from the mutable project
> directory (`task-executor.ts:198`). In worktree mode a task **MUST** observe the
> `AGENTS.md` of its own base, not whatever the user happens to have saved in their
> editor while four agents are running.

**Configuration resolution is deliberately *not* moved into the worktree.**
`.agent-flow/config.yaml` continues to be read from the project directory, once, when
the execution context is assembled — with one field exempt from that sentence.
**`git.useWorktrees` is not resolved per execution at all**: it is read by `createRun`
and captured on the run (§6.1, I-13), and every later reader takes
`state.isolationMode` instead. It is the one setting whose value must describe the run
rather than the machine, because changing it mid-run does not change a preference, it
changes which tree the work is built in. Reading the project overlay from the worktree
while the global layer necessarily comes from `~/.agent-flow/config.yaml` would give
one effective config assembled from two different points in time, and the merge
result would depend on which half moved. The SDD, the plan and the run's artifacts
all come from `.agent-flow/runs/<runId>/`, which is immutable run state, so the
mutable surface is exactly one file and it is the one a human owns.

### 4.3 Wave semantics

**MVP 2 keeps the current batch/barrier scheduler.** No rolling dispatch.

```text
ready set (DAG, over the whole graph)
  └─ stable selection (topological order)
       └─ take up to effectiveConcurrency
            └─ create one isolated workspace per selected task
                 └─ execute all attempts concurrently
                      └─ wait for ALL of them
                           └─ serial deterministic integration, in topological order
                                └─ next wave
```

Rolling dispatch was considered and rejected for this milestone: it would let a task
of wave N+1 start against an integration head that a still-unintegrated wave-N
sibling is about to move, which reintroduces exactly the ordering question the
barrier answers for free. It is **deferred**, not forbidden.

**Every task in one wave shares one base**: the integration branch's HEAD as observed
at the start of that wave, read once and held for the wave. A dependent task
**MUST NOT** start until every dependency is `TaskState.completed`, and in worktree
mode `completed` means integrated (I-3) — so a dependent task's base always contains
its dependencies' work.

### 4.4 Where isolation becomes concurrency

`core/concurrency.ts` stays pure. It gains a discriminant, not a probe:

```ts
export type IsolationMode = 'none' | 'worktree';

export const MAX_SUPPORTED_TASK_CONCURRENCY = 1;   // isolation: 'none'
export const MAX_ISOLATED_TASK_CONCURRENCY = 8;    // isolation: 'worktree'

export function resolveTaskConcurrency(
  requested: number,
  isolation: IsolationMode = 'none',
): ConcurrencyDecision;
```

- `isolation: 'none'` behaves exactly as today.
- `isolation: 'worktree'` permits up to `MAX_ISOLATED_TASK_CONCURRENCY`.

The ceiling on the isolated path is **not** unbounded, and the reason is not
timidity: each concurrent task is one agent process, one full repository checkout and
one install of the project's dependencies. Eight is a number with a stated basis
(§24) and a single edit to change.

**The declared mode is `state.isolationMode`, read from the run — never
`config.global.git.useWorktrees`, and never a probe's answer** (§6.1, I-13). Core answers a
policy question about a mode it is handed; the application answers a factual question
about a repository (§6.3), and neither of them decides which mode the run is in.

---

## 5. Git identity model

### 5.1 `repoKey`

**Decision: worktrees live outside the repository and outside `.git`.**

`.git/agent-flow/...` was probed empirically and rejected: Codex writes there;
**Claude Code refuses to write inside `.git`**, so a placement that worked with one
runner silently failed with the other. Placing worktrees *inside* the repository was
also rejected — a worktree inside the working tree is content the outer `git status`
sees, which is precisely the surface this milestone exists to keep clean.

```text
~/.agent-flow/worktrees/<repoKey>/<gitRunKey>/<taskId>/attempt-<n>/
~/.agent-flow/worktrees/<repoKey>/<gitRunKey>/integration/
```

`repoKey` identifies a repository on this machine. It is local identity, not
distributed identity — two clones of the same upstream on one machine are two
repositories and MUST get two keys.

```text
canonicalRoot :=
    realpath( dirname( git rev-parse --path-format=absolute --git-common-dir ) )

repoKey := <slug> "-" <hash12>

slug   := basename(canonicalRoot), lowercased, [^a-z0-9] → "-", runs collapsed,
          leading/trailing "-" trimmed, truncated to 24 characters;
          "repo" when the result is empty
hash12 := sha256(canonicalRoot).hex[0..12]
```

Requirements and how each is met:

| Requirement | How |
|---|---|
| same repo path → same `repoKey` | `realpath` is deterministic for an existing path |
| different repo paths → practically distinct | 48 bits of SHA-256 over the canonical root |
| no raw absolute path in the directory name | only a basename-derived slug survives |
| safe characters only | `[a-z0-9-]` by construction |
| reasonable Windows path length | slug capped at 24, hash at 12 → `repoKey` ≤ 37 |

Three decisions inside that derivation:

1. **`--git-common-dir`, not `--show-toplevel`.** When Agent Flow is started from a
   linked worktree, the toplevel is that worktree; the common dir points at the main
   repository. Two invocations of Agent Flow from two worktrees of one repository
   MUST agree on `repoKey`. *This is the only use of `--git-common-dir` in the
   design, and it is used to **identify** a repository, never as a place to write
   into.*
2. **The canonical root is hashed verbatim — it is not case-folded.** On a
   case-insensitive filesystem `realpath` already resolves both spellings to the
   name stored on disk, so folding buys nothing and would collide two genuinely
   different directories on a case-sensitive one. If `realpath` fails, worktree mode
   is refused with `repository_root_unresolvable` rather than guessed.
3. **The slug is for humans.** Nothing derives meaning from it; it exists so
   `ls ~/.agent-flow/worktrees` is readable. Only the hash carries identity.

### 5.2 `gitRunKey`

Every run has two identifiers:

```text
runId      AF-2026-001                       displayed everywhere, stable, human
gitRunKey  AF-2026-001-0f3a91c4bd27e615      the Git namespace for this run
```

The suffix is **64 bits of randomness**, generated by the application layer at the
moment the run is created, from a cryptographic source. It exists so that a run
namespace cannot collide with a stale namespace left by a previous run whose state
was deleted but whose refs were not — the failure mode where a new `AF-2026-001`
adopts a dead `AF-2026-001`'s branches.

**Layer contract:**

| Layer | Responsibility |
|---|---|
| application (`run-git-identity.ts`) | Generates the key, captures `planningBase`, and reads `git.useWorktrees` **exactly once** to produce `isolationMode`. Passes all three to `StateStore.createRun`, which writes them together (§6.1). |
| `StateStore` | Persists an opaque, schema-validated string. **Executes no Git. Knows nothing about refs.** (I-1) |
| `GitWorkspaces` | Derives the namespace, checks for a real collision, refuses on collision, **never regenerates silently.** |

Schema:

```ts
GitRunKeySchema = z.string().regex(/^AF-\d{4}-\d{3}-[0-9a-f]{16}$/)
```

`GitWorkspaces` **MUST** re-validate the key against that pattern immediately before
it appears in any ref name or path, even though `StateStore` already validated it on
load. This is the ref-injection defence (§22) and it must not depend on a caller
having done its job.

**Invariant:** `gitRunKey` MUST begin with the run's own `runId` followed by `-`.
Checked when a run enters worktree mode; a mismatch is a refusal, never a repair.

### 5.3 Namespace

```text
agent-flow/<gitRunKey>/                              the run's namespace
agent-flow/<gitRunKey>/integration                   the integration branch
agent-flow/<gitRunKey>/<taskId>/attempt-<n>          one attempt's branch
```

**Collision check — four states on disk, three of which look alike.**

An existing namespace means opposite things depending on how it got there: someone
else's wreckage, this run's own namespace on a resume, or this run's own namespace
created moments before a crash. Getting the distinction wrong in one direction makes
every resumed run refuse itself; in the other, it makes a run build on refs it does
not own.

The discriminator is `state.integrationHead` (§6.1). It is **not** `events.jsonl`: a
decision input read from the audit trail would make the audit trail a second source of
truth, which I-1 forbids. `integration_branch_created` (Appendix B) remains the
human-readable record of when the namespace appeared, never the thing that is
consulted.

It is deliberately *not* `state.isolationMode` either — that is captured at run
creation and is present from the run's first moment, long before any ref exists. And
it is deliberately **not a dedicated "namespace created" field**, for a reason worth
stating because the obvious design has it backwards:

> **Creating the branch and writing the state are two operations, and a crash fits
> between them.** A field that means "I created the namespace" is absent in exactly
> the case where the namespace exists — so a resume after that crash would read
> *first entry*, find the run's own integration branch, and refuse it as a collision
> with itself. The initialisation algorithm below is written so that this window is a
> **recoverable state**, not a refusal.

**Initialisation, evaluated under the run execution lock (§18.2):**

| | State | Repository | Action |
|---|---|---|---|
| **A** | `integrationHead` absent | the namespace is empty | Create the branch at `planningBase`; create the integration worktree; persist `integrationHead = planningBase`. |
| **B** | `integrationHead` absent | the namespace contains **only** `…/integration`, it resolves **exactly** to `planningBase`, there are no attempt refs, no attempt artifact and no integrated task | A crash during initialisation. **Adopt it** — recreate the integration worktree if it is gone (§14.1) — and persist `integrationHead = planningBase`. **Not a collision.** |
| **C** | `integrationHead` absent | anything else in the namespace: an attempt ref, an integration branch at a commit other than `planningBase`, or a worktree directory whose contents do not match B | Refusal `git_run_key_collision`. |
| **D** | `integrationHead` present | — | Resume. The branch MUST exist, and `integrationHead` MUST be an ancestor of it. |

**Why B is safe to adopt rather than a collision.** The branch is at `planningBase`
and nothing else in the namespace exists — which is to say it contains no work. Every
distinguishing fact matches what step A would have produced and nothing matches what a
*different* run would have left, because a different run that got anywhere would have
moved the branch or created an attempt ref. Adopting it is therefore identical to
creating it, and re-creating it would be identical too; the reason to adopt rather
than delete-and-recreate is that deleting a ref to reach a state you already have is
a destructive operation performed for no gain.

**Under D, the two failures are different and neither is repairable.**

- The branch is **absent** → `namespace_missing`. Work that was recorded as integrated
  is gone from the repository, and re-creating the branch from `planningBase` would
  silently discard it.
- The branch exists but `integrationHead` is **not an ancestor** of it →
  `integration_head_diverged`. The branch was rewound, reset or replaced under a
  running run. The state's claim and the repository's shape cannot both be true, and
  choosing one of them by guessing is how a run finishes green over a tree that lost
  half its work.

`integrationHead` being *behind* the branch head is **not** a failure: that is
§17.3 window 7 — the merge landed and the process died before the state write —
and recovery reconciles it forward.

Agent Flow **MUST NOT** generate a new key to get past a collision: a 64-bit
collision is not a random event, it is evidence that something is wrong with the
state on disk, and papering over it would hide exactly the case the key exists to
detect.

---

## 6. `planningBase` and repository gates

### 6.1 The fields, and the one moment they are captured

```ts
// RunStateSchema, additive and optional. The first three are written by
// createRun, together, and never written again.
planningBase:  z.string().regex(/^[0-9a-f]{40}$/).optional(),
gitRunKey:     GitRunKeySchema.optional(),
isolationMode: z.enum(['none', 'worktree']).optional(),

// Mutable, and the only Git fact this run persists. Written when the namespace
// is initialised (= planningBase, §5.3) and advanced by each merge, in the same
// write that completes the task (§14.3). §19.2 pins verification and review to it.
integrationHead: z.string().regex(/^[0-9a-f]{40}$/).optional(),
```

**`createRun` captures the first three, before discovery, architecture analysis or
planning observes the repository:**

```text
isolationMode := config.global.git.useWorktrees ? 'worktree' : 'none'
planningBase  := HEAD, whenever HEAD resolves
gitRunKey     := runId + 64 random bits                (§5.2)
```

`EffectiveConfig` is `{ global, project? }`, and `global` is already the merged
result — defaults, then the global file, then the project overlay for every
overridable key (`src/config/loader.ts`). So `config.global.git.useWorktrees` **is**
the effective value including the project's override; there is no second `config.git`
shape and this document must not invent one.

**The branch name is derived, never stored:**

```text
agent-flow/<gitRunKey>/integration
```

`gitRunKey` is on the run, the ref name is a pure function of it (§5.3), and
persisting the name as well would create a second copy of the same fact that a bug
could make disagree with the first.

**These are immutable properties of the run.** Nothing later writes them: not an
execution, not a retry, not a resume, and above all not a configuration change. `run
--dry-run`, `status` and the read model all *report* the mode; none of them derives
it.

> **`git.useWorktrees` is read in exactly one place, at exactly one moment.** That is
> the whole mechanism, and §26.1 pins it with an architecture test whose allowlist is
> a single module. Everything else in this document reads `state.isolationMode`. A
> config flag consulted at each execution is a property of *the machine at that
> moment*; a field captured at creation is a property of *the run*, and a run is the
> thing this specification makes promises about.

**`config.global.git.useWorktrees` is the fully resolved value** — the global layer with the
project overlay applied, exactly as every other setting is resolved (§4.2) — read at
`createRun`. Reading only the global layer was considered and would silently ignore a
per-project `useWorktrees: true`, which no other setting in this tool does; the
property that matters is *when* the value is read, not *which layer* supplies it.

`planningBase` is the commit the repository was on **when the run was created**. It is
captured for every run, in either mode: in worktree mode it is the base the
integration branch is cut from, and in sequential mode it is what
`planning_base_observation` (§6.2) compares against.

"Whenever HEAD resolves" is the only qualification, and it decides one case:
**a run being born `worktree` in a repository that cannot supply a base is refused at
creation, not at execution.** The structural preconditions — not a Git repository,
bare, unborn HEAD, submodules, Git below the floor, unresolvable root, projected path
too long — are facts no user action during the run will change, so evaluating them at
`createRun` costs the user nothing and saves them a discovery pass, a planning pass
and a plan review before the refusal arrives. §6.3 keeps them too, because a run can
be resumed on a different machine.

> **This preflight runs only when `isolationMode` resolves to `'worktree'`, and that
> restriction is a compatibility guarantee, not an optimisation.** A run being born
> sequential is asked nothing about Git: not whether the directory is a repository,
> not what version is installed, not whether HEAD exists. Agent Flow has always run
> in directories that are not repositories, and §25 promises that mode is unchanged.
> A preflight that refused there would break every such project on upgrade, in a
> milestone whose whole subject is a feature those projects did not turn on.
> `planningBase` is simply absent for them, which is the honest value.

**There is exactly one base field.** `implementationBase` was considered and is
**rejected** (§30.1): two base fields make "which commit was this plan written
against" a question with two answers, and the whole value of the field is that it has
one. The integration branch is created from `planningBase`, so the tree the plan was
written against is the tree the work is built on.

All four fields are **optional in the schema** so that runs created before MVP 2 still
parse. A run with `isolationMode` and `planningBase` both absent is a **legacy run**,
and that shape is load-bearing rather than incidental (§25.2).

### 6.2 The invariants

For a run whose `state.isolationMode` is `'worktree'`, at each of these moments the
repository MUST satisfy `clean && HEAD == planningBase`:

| Moment | Why here |
|---|---|
| planning start | The map, the SDD and the plan describe one tree. |
| between planning stages | A stage that observed a different tree from its predecessor produces an artifact that silently disagrees with the one before it. |
| approve | The gate binds a human decision to a plan; a plan written against a tree that has since moved is a decision about something else. |
| implementation start | The integration branch is cut from `planningBase`. If HEAD moved, the work would be built on a commit nobody planned against. |

Refusals: **`planning_base_moved`** and **`working_tree_dirty`**. Neither is
forcible. There is no `--force` for either, and adding one would be adding a flag
whose only function is to produce an unexplainable tree.

> **Deviation from the brief, stated rather than absorbed.** These gates are
> **enforced when `state.isolationMode === 'worktree'`** and **evaluated but
> non-blocking otherwise**. Enforcing them unconditionally would mean that after this
> milestone lands, every existing user who plans a feature on a dirty working tree —
> which sequential mode has always allowed and which is the normal way people work —
> is refused. That is a breaking behaviour change to the mode §25 promises to keep
> compatible. For a run in sequential mode the checks still run and their result is
> written to `events.jsonl` as `planning_base_observation`, so the information exists
> without the refusal.

**The condition is `state.isolationMode`, never `config.global.git.useWorktrees`, and the
difference is the whole reason §6.1 exists.** A gate keyed on the live config is a
gate that can be off while planning observes the repository and on by the time
implementation starts:

```text
useWorktrees: false        run is created
dirty working tree         gates are observational — planning proceeds
                           discovery, the SDD and the plan describe the DIRTY tree
git stash                  the tree is now clean; HEAD never moved
useWorktrees: true         the user flips the flag
agent-flow start           clean, and HEAD === planningBase — every check passes
                           the integration branch is cut from planningBase
                           → the work is implemented against a tree the plan
                             was never written against, and nothing reports it
```

Every individual check in that sequence answers correctly. The defect is that the
question *"is this run isolated?"* was asked twice, at two moments, of a source that
could change in between. Captured once at creation, the first line of the sequence
decides all of them: the run is `none`, it stays `none`, and flipping the flag does
nothing to it.

### 6.3 Execution preconditions

`app/run-git-identity.ts` no longer chooses anything. §6.1 chose. It answers a
narrower question: **can this run execute, right now, in the mode it was born in?**

```ts
export type WorktreePreconditions =
  | { readonly satisfied: true }
  | { readonly satisfied: false; readonly code: RefusalCode; readonly detail: string };
```

It is evaluated only when `state.isolationMode === 'worktree'`. A run in sequential
mode has no preconditions to satisfy — it executes the way this tool has always
executed — and a legacy run (§25.2) is sequential by shape.

Checked, in this order, cheapest and most conclusive first:

1. Not a Git repository → `not_a_git_repository`.
2. Bare repository → `repository_is_bare`.
3. No commits (unborn HEAD) → `repository_has_no_commits`.
4. Submodules present → `repository_has_submodules` (§23).
5. Git older than the supported floor → `git_version_unsupported`.
6. Projected worst-case worktree path exceeds the platform limit → `worktree_path_too_long` (§23).
7. `state.gitRunKey` absent or not prefixed by `runId` → `git_identity_missing`.
8. Agent Flow's own run state is not ignored by the repository →
   `agent_flow_state_not_ignored`.
9. Working tree dirty → `working_tree_dirty`.
10. `HEAD !== planningBase` → `planning_base_moved`.
11. The namespace does not match `state.integrationHead` under the initialisation
    algorithm (§5.3) → `git_run_key_collision` (case C), `namespace_missing` or
    `integration_head_diverged` (case D). Cases A and B are not refusals.

**Checks 1–6 are structural** — no action taken during the run makes them true or
false — which is why §6.1 also evaluates them at `createRun`, where the refusal is
free. They are repeated here because a run can be resumed on another machine, with
another Git, at another path length.

**Checks 7–11 are per-entry** and are the reason this function still exists.

**Check 8 exists because without it the run refuses itself.** `init` appends
`.agent-flow/runs/`, `.agent-flow/cache/` and `.agent-flow/current-run` to
`.gitignore`. If any of them is not ignored — an old project, a hand-edited
`.gitignore`, a `.gitignore` the user reverted — then the run's own state files make
the working tree dirty, and check 9 refuses the run while naming files Agent Flow
itself just wrote. That is a message that teaches the user the tool is broken.
Detected with `git check-ignore -q` on each of the three paths, and refused with a
code whose fix is one line in `.gitignore`.

Checks 9 and 10 apply on **every** entry, including a resume. A user who moved HEAD
or dirtied the tree between two `start` invocations changed the ground the integration
branch was cut from, and the run must stop rather than build on it.

### 6.4 A refusal is temporary; the run's mode is not

**Nothing in §6.3 writes to run state.** A precondition refusal reports that the
repository is not ready. It does not record a decision, does not downgrade the run,
and does not consume anything.

```text
run.isolationMode = 'worktree'
    dirty tree      → working_tree_dirty, ActionError, run untouched
    user cleans it
    start again     → still 'worktree', executes
```

That asymmetry is the point: **the repository's readiness is a moment; the run's
intent is a fact.** A design in which a refusal settled the mode would make "I forgot
to commit before starting" permanently reclassify the run, and the user's only
recourse would be to throw the plan away.

The three things a refusal is **not**:

| Not | Because |
|---|---|
| a downgrade to sequential | The run was created isolated. Executing it in the user's working tree is not a smaller version of what was asked for; it is a different thing (§6.2). |
| a degradation | Nothing executed. A degradation describes how a run ran, and this one did not. |
| permanent | Every per-entry code (7–11) names a repository state the user changes with one command. |

**Where `parallelism_clamped` is recorded, and where it is not.** The degradation
belongs to a run that *executes* with less concurrency than it asked for — knowable at
creation, from the same two values:

```text
isolationMode === 'none'      AND maxTasks > 1                            → clamped
isolationMode === 'worktree'  AND maxTasks > MAX_ISOLATED_TASK_CONCURRENCY → clamped
otherwise                                                                 → no degradation
```

A run created `maxTasks: 1` with worktrees off lost nothing and is not degraded;
recording one would put a complaint on every sequential run this tool has ever
executed. **No new degradation kind is added** (§25.1).

**A configuration change never reaches an existing run.** Both directions, stated so
that neither is left to inference:

| Change after `createRun` | Effect on the run | What the user does |
|---|---|---|
| `none`, config now `true` | none — the run stays sequential | start a new run to get worktrees |
| `worktree`, config now `false` | none — the run stays isolated | let it finish, or abandon it and start a new one |

The second row is the one that surprises people, so `status` and `run --dry-run` MUST
say it in words: *this run was created in worktree mode; the current configuration
does not apply to it* (§21.4). A surprise the tool names is a fact; the same surprise
unexplained is a bug report.

**There is no `isolation_mode_changed` refusal, and nothing for one to detect.** A
refusal code exists to report a conflict; capturing the mode at creation removes the
conflict rather than reporting it. Choosing the mode at the first successful execution
— the design this section replaces — is rejected in §30.1, and the sequence it admits
is written out in §6.2.

---

## 7. Worktree placement and lifecycle

### 7.1 Layout

```text
~/.agent-flow/
├── no-hooks/                                     owned, empty, mode 0755  (§12.3)
└── worktrees/
    └── <repoKey>/
        └── <gitRunKey>/
            ├── integration/                      integration branch checked out
            ├── TASK-001/
            │   ├── attempt-1/
            │   └── attempt-2/
            └── TASK-002/
                └── attempt-1/
```

`~` is the user's home directory as resolved by the `Host` port, never
`process.env.HOME` read directly.

### 7.2 What is persisted, and what is not

**Absolute worktree paths are never persisted and never leave the process except in
CLI output.** The attempt artifact records the *workspace-relative* path
(`<repoKey>/<gitRunKey>/<taskId>/attempt-<n>`); the absolute root is a machine fact
`GitWorkspaces` resolves. This makes the leak in §21 structurally impossible rather
than a rule someone has to remember.

`state.json` and `events.jsonl` contain **no** worktree paths at all.

### 7.3 Locking

Every worktree Agent Flow creates is created locked. An attempt worktree creates its
branch in the same command, at the wave base; the integration worktree checks out a
branch that already exists (§14.1):

```bash
# attempt: branch and worktree in one transaction, rooted at the wave base
git worktree add --lock --reason "agent-flow <gitRunKey> <taskId> attempt-<n>" \
    -b agent-flow/<gitRunKey>/<taskId>/attempt-<n> <path> <waveBase>

# integration: the branch exists; the worktree is a checkout of it
git worktree add --lock --reason "agent-flow <gitRunKey> integration" \
    <path> agent-flow/<gitRunKey>/integration
```

**`-b` rather than `git branch` followed by `worktree add`.** Two commands leave a
window in which the branch exists and nothing is checked out — which on a crash is
indistinguishable from an attempt whose worktree was pruned, and would need a
recovery window of its own. The integration branch is deliberately the other way
round, because there the branch outliving its worktree is the *designed* state
(§14.1): a checkout is recreatable, the work is not.

The lock is not concurrency control — the run execution lock is (§18.2). It is
protection against `git worktree prune` reclaiming a live workspace while an agent is
writing into it, which is exactly what a user running `git worktree prune` in another
terminal would otherwise do.

Unlocking happens only in cleanup (§20), immediately before removal, by the module
that owns the removal.

### 7.4 Lifecycle

```text
created ──► prepared ──► executing ──► validated ──► marked ──► integrated ──► reclaimable
   │            │            │             │            │
   └── failed ──┴────────────┴─────────────┴────────────┴──► retained for diagnosis
```

A worktree in any state other than `integrated` is **retained**. A retained worktree
is the only remaining copy of what an agent produced, and deleting it to save disk
would be deleting the evidence that explains the failure.

---

## 8. Workspace preparation

### 8.1 The sequence

```text
git worktree add --lock -b <branch> <path> <waveBase>      §7.3
        ↓
assert clean                              phase: "checkout"
        ↓
project.commands.install                  only when configured
        ↓
assert clean                              phase: "setup"
        ↓
invoke the agent
```

**`project.commands.install` is reused. `git.worktreeSetup` is rejected** (§30.1): a
second configuration key for "how do I make this project buildable" would be a second
answer to a question the project config already answers, and the two would drift.

Setup runs through `ProcessRunner` with `cwd` = the worktree, the same path as the
validation commands, under the same timeout policy. It is a command a human wrote in
a config file; nothing model-authored reaches a shell (V-01, unchanged).

### 8.2 "Clean" is defined exactly once

```bash
git status --porcelain=v1 --untracked-files=all
```

Empty output, and only empty output, is clean. That includes:

- staged changes
- unstaged modifications to tracked files
- untracked files that are **not** ignored

Ignored files do not count and MUST NOT be reported — `node_modules/`, `.dart_tool/`,
`build/` and every other install artifact is exactly what setup is supposed to
produce.

**MVP 2 creates no synthetic commit and no stash to make a tree clean.** Either the
tree is clean or the attempt is refused.

### 8.3 Failure semantics

Any non-empty status at either assertion:

```text
error code:  task_workspace_preparation_failed
detail:      { phase: "checkout" | "setup", changes: [<path> ...] }
task state:  failed
agent:       NOT INVOKED
worktree:    retained, locked
attempt:     spent (the counter already moved at dispatch — M2-00.2)
```

The agent is not invoked, and that is the point: an agent that starts in a dirty
workspace produces a validated tree containing changes nobody attributed to the task,
and those changes then enter the marker (§12) and the integration branch, with a
receipt saying they were validated. A dirty setup is the single most direct route
from "a tool wrote a lockfile" to "a commit nobody can explain".

### 8.4 The failure everyone will hit first

**The default Node install command is `npm install`, and `npm install` rewrites
`package-lock.json` whenever the lock is even slightly out of date with
`package.json`.** That is a tracked modification, so it fails the post-setup
assertion, so worktree mode refuses every task in the project.

This is the gate working correctly. A silently rewritten lockfile entering forty
attempt trees is precisely what §8.3 exists to prevent. But it means the milestone
ships a wall that most Node projects walk into on their first run, so:

- **`doctor` MUST detect it before a run starts, not at attempt time.** A dry-run
  install in a throwaway worktree, once, reported as a warning naming the changed
  paths and the fix.
- **The fix is a lockfile-respecting install** — for Node, `commands.install: npm ci`,
  which also matches what CI does and fails loudly when the lock is genuinely stale.
- **`init` SHOULD emit the lockfile-respecting form for newly detected stacks**
  (`src/config/stack-detection.ts`). This changes what new projects get and MUST NOT
  rewrite any existing `.agent-flow/config.yaml`.
- For Flutter, the correct invocation MUST be determined by the dogfood run (§27),
  not asserted here: `flutter pub get` may rewrite `pubspec.lock`, and the flag that
  prevents it has not been probed on the versions this project targets.

---

## 9. Wave execution semantics

### 9.1 One wave, step by step

1. **Read the wave base.** `git rev-parse refs/heads/agent-flow/<gitRunKey>/integration`.
   Read once. Every task in this wave uses this commit. On the first wave the
   integration branch has just been created from `planningBase`, so the wave base
   *is* `planningBase`.
2. **Select.** `readyTasks(dag, states)`, filtered by `options.only`, sliced to
   `effectiveConcurrency`. `core/dag.ts` already sorts its frontier, so the selection
   is deterministic for a given plan and state (I-9).
3. **Dispatch.** `Scheduler.persist(runId, states, batch)` — states to `running`,
   attempts incremented for the batch. Unchanged from M2-00.2.
4. **Prepare and execute, concurrently.** One `TaskWorkspace` per task (§8), then
   `TaskExecutor.execute(task, runId, sdd, workspace)`.
5. **Barrier.** Await all.
6. **Integrate, serially, in topological order** (§14).
7. **Persist and repeat.**

### 9.2 Halting

The current rule is preserved: the run halts on the first task that does not reach a
successful outcome, rather than pressing on with independent branches.

Under fan-out this needs one clarification the sequential mode never needed:
**a wave completes before the run halts.** If task A fails and task B succeeds in the
same wave, B's attempt is still validated, marked and integrated, and *then* the run
halts. Discarding B's work because a sibling failed would throw away an agent
invocation that was already paid for and that produced a validated tree — and would
make the failure mode depend on which task finished first, which is exactly the
nondeterminism this milestone is built to avoid.

Tasks blocked by the failure are marked `blocked` as they are today.

---

## 10. Task attempt model

### 10.1 `TaskAttemptResult` is not `TaskResult`

**`TaskResultSchema` MUST NOT be reused for attempts.** It carries
`status: TaskState`, and a file on disk saying `"status": "completed"` for a task that
has not been integrated is a lie that recovery would believe (I-3).

Two artifacts, two meanings:

| Artifact | Path | Means |
|---|---|---|
| `TaskAttemptResult` | `.agent-flow/runs/<runId>/tasks/<taskId>/attempt-<n>.json` | One local execution and its validation evidence. Immutable once written. |
| `TaskResult` | `.agent-flow/runs/<runId>/tasks/<taskId>/result.json` | The task's final outcome. In worktree mode written **only after integration**. |

### 10.2 Schema

```ts
export const ValidationJudgementSchema = z.enum([
  'satisfied',    // the expectation was met, inside this worktree, against this base
  'unsatisfied',  // validation ran and the expectation was not met
  'not_reached',  // setup failed, the agent failed, or the agent reported BLOCKED
]);

export const AttemptReceiptSchema = z.object({
  /** 128 random bits, hex. Generated only after the agent process has exited. */
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
  /** `git write-tree` over the validated worktree. */
  validatedTree: z.string().regex(/^[0-9a-f]{40}$/),
  /** Also the marker's author and committer date — see §12.2. */
  issuedAt: IsoTimestampSchema,
});

export const TaskAttemptResultSchema = z.object({
  run: RunIdSchema,
  task: AnyTaskIdSchema,
  attempt: z.number().int().min(1),

  base: z.string().regex(/^[0-9a-f]{40}$/),
  branch: z.string().min(1),
  /** Workspace-relative. Never absolute — see §7.2. */
  workspace: z.string().min(1),

  // Provenance: what actually ran, not what was configured.
  runner: z.string().min(1),
  model: z.string().optional(),
  reasoning: ReasoningLevelSchema,
  reasoningClamped: z.boolean().default(false),
  fallback: z.object({ from: z.string().min(1), errorCode: RunnerErrorCodeSchema }).optional(),

  startedAt: IsoTimestampSchema,
  finishedAt: IsoTimestampSchema,

  filesChanged: z.array(z.string()).default([]),
  agentReport: z.object({
    status: z.enum(['COMPLETED', 'BLOCKED']),
    notes: z.array(z.string()).default([]),
    deviations: z.array(z.string()).default([]),
  }),

  validation: z.object({
    expectation: z.enum(['pass', 'fail', 'none']),
    passed: z.boolean(),
    ids: z.array(z.string()).default([]),
    commands: z.array(CommandResultSchema).default([]),
  }),
  validationJudgement: ValidationJudgementSchema,

  /** Present if and only if validationJudgement === 'satisfied'. */
  receipt: AttemptReceiptSchema.optional(),

  errorCode: z.string().optional(),
}).refine(
  (a) => (a.validationJudgement === 'satisfied') === (a.receipt !== undefined),
  { message: 'a receipt exists exactly when the validation judgement is satisfied' },
);
```

**There is no `status` field, deliberately.** Nothing in this artifact can be
confused with `TaskState`, and no future reader can mistake an attempt for an
outcome. The `.refine` is what makes "receipt implies satisfied" a property of the
data rather than a convention — an artifact with a receipt and an unsatisfied
judgement does not parse.

### 10.3 `TaskResult` in worktree mode

`TaskResultSchema` gains one optional block, additive:

```ts
integration: z.object({
  attempt: z.number().int().min(1),
  branch: z.string().min(1),          // the integration branch
  marker: z.string().regex(/^[0-9a-f]{40}$/),
  mergeCommit: z.string().regex(/^[0-9a-f]{40}$/),
  base: z.string().regex(/^[0-9a-f]{40}$/),
  validatedTree: z.string().regex(/^[0-9a-f]{40}$/),
  integratedAt: IsoTimestampSchema,
}).optional(),
```

Absent in sequential mode. Present on every `completed` task in worktree mode — and
its presence is the on-disk statement of I-3.

---

## 11. Trusted validation receipts

### 11.1 The threat

An implementation agent runs with write permission inside its worktree. Its output —
files, commits, a report block — is the raw material of the task. **The orchestrator's
evidence that validation happened must be structurally impossible to confuse with
that output.**

Without a separating mechanism, "the branch has a commit that looks like a marker" is
the only recovery signal, and a commit that looks like a marker is a commit an agent
can write.

### 11.2 The sequence

```text
agent process exits                         ← nothing below can start earlier
        ↓
validation commands run (orchestrator, ProcessRunner, cwd = worktree)
        ↓
judgeValidation(expectation, outcome) === satisfied
        ↓
git add -A                                  stage everything in the worktree
git write-tree                            → validatedTree
receiptNonce = 128 random bits              ← the nonce first exists HERE
        ↓
write attempt-<n>.json atomically           ← THE authority
```

Three properties this ordering buys:

- **The nonce does not exist while the agent is alive.** There is no moment at which
  a running agent could read it, guess it or copy it.
- **The tree is captured after validation, not before.** What is recorded is the tree
  the validation commands actually ran against.
- **The artifact is written atomically, once, by the orchestrator, outside the
  worktree.** `.agent-flow/runs/` is in the project directory, not in any worktree,
  and `.agent-flow/runs/` is gitignored — so it is not part of any checkout an agent
  receives.

`git add -A` runs against the worktree's own index. It stages ignored files? No —
`add -A` honours `.gitignore`, which is why `node_modules/` does not enter the tree.
An attempt whose project fails to ignore its build output is caught earlier, at §8.3.

### 11.3 What the receipt actually guarantees — and what it does not

**It guarantees:** given an attempt artifact this process wrote, recovery can decide
whether a ref in the repository is the marker for that artifact, because the binding
runs artifact → nonce + tree → marker, and both halves must agree (I-5, I-6).

**It does not guarantee unforgeability against an agent that escapes its worktree.**
An agent that can write into `<projectDir>/.agent-flow/runs/` can write a fabricated
attempt artifact and a matching ref, and no scheme available to a local-first tool
without a secret store changes that. The same capability lets it write `state.json`
directly, at which point the orchestrator has no defences left at all.

So the honest claim, and the one the spec makes: **the receipt raises the bar from
"structurally indistinguishable from normal agent output" to "requires escaping the
worktree and writing into orchestrator-private state".** Containment of the agent
remains the runner's job (AD-14), unchanged. This limitation MUST be stated in
[`docs/security.md`](../security.md) when the milestone lands.

Defences in depth that are cheap and MUST be implemented:

- Run artifacts live outside every worktree (structural, already true).
- The attempt artifact is written with `writeFileAtomic` and never rewritten. A
  second write to an existing `attempt-<n>.json` is a refusal, not an overwrite.
- The `.refine` in §10.2 makes a half-forged artifact unparseable.
- Recovery cross-checks nonce **and** tree; matching one is not enough (§17.3).

---

## 12. Marker commits

### 12.1 Construction

```bash
marker=$(git commit-tree <validatedTree> -p <base> < message)
git update-ref refs/heads/agent-flow/<gitRunKey>/<taskId>/attempt-<n> $marker
```

- **`git commit` MUST NOT be used.** It reads the index of a checked-out worktree, it
  runs hooks, and it would make the marker a function of whatever the worktree's
  index happened to contain at that instant rather than of the validated tree.
- **`--allow-empty` MUST NOT be used, and is not needed.** `commit-tree` has no
  emptiness check at all: a marker whose tree equals its base is a legitimate,
  representable commit. A task that validated without changing a file is a real
  outcome (a task whose work was already done, a `validationExpectation: none` task),
  and it MUST be representable.
- `update-ref` is used rather than `branch` so that the operation is a single
  reference transaction with no working-tree implications.

### 12.2 The marker is a deterministic function of persisted state

Author and committer are fixed, and the timestamps come from
`receipt.issuedAt` — read back from the artifact, **not** from "now":

```text
author    = committer = "Agent Flow <agent-flow@local>"
GIT_AUTHOR_DATE = GIT_COMMITTER_DATE = receipt.issuedAt
```

This is not cosmetic. Because every input to `commit-tree` (tree, parent, message,
identity, dates) is read from the persisted artifact, **re-running `commit-tree`
after a crash produces the same commit SHA.** Git stores it once and `update-ref`
becomes idempotent. That single property closes the "crashed after `commit-tree`,
before `update-ref`" window (§17.4) with no bookkeeping at all.

The identity is fixed rather than taken from the user's `user.name`/`user.email`
because a marker is a machine-made snapshot, and attributing it to a person is a
statement that is not true. It is set with `-c user.name=… -c user.email=…` on the
invocation. **Agent Flow never writes to `git config`** (I-7).

### 12.3 Internal Git hook isolation

**Every Git command Agent Flow issues goes through one wrapper**
(`src/adapters/git/git-command.ts`), and that wrapper injects:

```bash
git -c core.hooksPath=<~/.agent-flow/no-hooks> …
```

The directory is owned by Agent Flow, created empty, and never written to.

**`--no-verify` is rejected as the mechanism** (§30.1). It is not a weaker version of
the same thing; it covers a different and smaller set. Three hooks this milestone
would otherwise fire are not affected by `--no-verify` at all:

| Operation | Hook it fires | `--no-verify` covers it? |
|---|---|---|
| `git worktree add` | `post-checkout` | no — the flag does not exist there |
| `git update-ref` | `reference-transaction` | no |
| `git merge` | `pre-merge-commit`, `post-merge` | partially, and only for some invocations |
| `git commit` | `pre-commit`, `commit-msg`, `post-commit` | yes — but §12.1 forbids `git commit` |

`core.hooksPath` on the command line has the highest configuration precedence, so it
overrides a repository-level `core.hooksPath` as well as `.git/hooks`.

**Scope, stated precisely.** Hook isolation applies to Agent Flow's own Git
invocations. It does **not** apply to `project.commands.*` — those are the user's
commands, they run as the user wrote them, and if `npm test` runs Git internally that
is the project's business. And the user's hooks continue to work normally when *they*
merge the integration branch, because nothing in the repository's configuration was
changed. `doctor` MUST state this policy.

### 12.4 Message and trailers

```text
agent-flow: TASK-003 attempt 2

Validated tree for TASK-003, attempt 2, of run AF-2026-001.

Created by Agent Flow from the tree that its validation commands ran against.
This is a snapshot of that tree onto its base, not the coding agent's commit history.

Agent-Flow-Run: AF-2026-001
Agent-Flow-Run-Key: AF-2026-001-0f3a91c4bd27e615
Agent-Flow-Task: TASK-003
Agent-Flow-Attempt: 2
Agent-Flow-Base: 4a1c…
Agent-Flow-Tree: 9be2…
Agent-Flow-Receipt: 7d41c0a9f2b85e6304ac71bd9e2f5a18
Agent-Flow-Validation: satisfied
Agent-Flow-Validation-Expectation: pass
Agent-Flow-Validation-Ids: lint,test
```

**The trailers are for humans and for `git log`. They are never the authority.**
Recovery reads the artifact first and uses the trailers only to confirm it (§17.3).
A marker whose trailers are perfect and whose tree does not match the receipt is
refused (I-6).

### 12.5 Commits the coding agent created

Coding agents commit. Some do it habitually, some when asked, some not at all. Agent
Flow does not depend on any of it.

> **Commits created by the coding agent during an attempt are intermediate
> implementation, not validation provenance.**

Because the marker is built as `commit-tree <validatedTree> -p <base>`, it is a
**logical squash of the attempt's entire validated tree onto its base**. The agent's
own commits are not in the marker's ancestry, and therefore not in the integration
branch's ancestry.

**This is deliberate.** Three reasons:

1. The unit that was validated is a *tree*, not a sequence. Preserving a history
   whose intermediate states were never validated would put commits on the
   integration branch that no test ever saw.
2. Agents commit inconsistently. A design that depended on their history would behave
   differently per runner, which violates provider-agnosticism (§3, §58 of Spec v3).
3. The reviewable unit of this workflow is the task. One task, one marker, one merge
   is what makes the integration branch legible.

The agent's commits remain reachable from the attempt branch's reflog and in the
retained worktree until it is reclaimed. They are diagnostic material, not product.

---

## 13. RED/GREEN semantics

### 13.1 What is preserved

`validationExpectation: 'pass' | 'fail' | 'none'` is unchanged, and
`judgeValidation` is unchanged.

**The expectation is evaluated exactly once (I-4):** inside the task's worktree,
against that task's base, immediately after the agent exits. It is **never**
re-evaluated after integration.

### 13.2 What is explicitly not built

**There is no union-of-validation-ids gate at integration.** The rejected design was:
collect every validation id from the wave, run them all against the integration tree,
require all to pass. It is rejected because it directly contradicts I-4 and the whole
`validationExpectation` model — a task with `expectation: 'fail'` is *supposed* to
have a failing validation id at the moment it completes, and a union gate would
either fail the wave for a task that behaved exactly as planned, or would need a
per-id exception table that reimplements the expectation model at a layer that cannot
see the task.

**There is no integration validation gate of any kind.** Integration checks
*mechanical Git integrity* — receipt, marker, tree binding, merge success — and
nothing else. No validation command runs during integration.

### 13.3 Where "everything is green" is decided

**The final deterministic `runVerification`, over the complete integration tree,
in the integration worktree (§19).** That is the only authority, and it was already
the only authority before this milestone; MVP 2 changes where it runs, not what it
means.

The consequence, stated plainly so nobody is surprised by it:

> `validationExpectation: 'fail'` does **not** mean "this test may still be red at
> the end of the run". It means "at the moment this task completed, this test was
> expected to fail". A plan whose RED task is never paired with a GREEN task that
> makes it pass will fail final verification, and that is correct.

### 13.4 Per-wave verification as a signal

Running `runVerification` on the integration tree after each wave would be useful
observability: it would name the wave in which the tree went red.

It is **deferred**. It is not a gate, it must never become one, and it costs a full
lint/typecheck/test/build per wave — which on a real project is the dominant cost of
the run. If it is built later it MUST be opt-in and MUST be recorded as a signal, not
as a state transition.

### 13.5 `redTasksIntegrated`

**Status: DEFERRED. Not built in MVP 2.**

The idea was a diagnostic list of completed tasks whose `validationExpectation` was
`fail`, with their validation ids, so a person could see what is expected to be red.

It is deferred because the same information is already derivable — `plan.json` has
every task's expectation, `result.json` has every completed task — and a
purpose-built field with no closing mechanism invites exactly the misreading it is
supposed to prevent: it looks like a debt ledger, so somebody eventually treats it as
a gate. It is **not** a gate, **not** proof, **not** a Definition-of-Done condition
and **not** a causal map from a red test to the task that will fix it.

If it is ever built, it belongs in the read model (§21) as a derived projection, not
in `state.json`.

---

## 14. Deterministic integration

### 14.1 The integration worktree

The integration branch is checked out in its own worktree for the life of the run:

```text
~/.agent-flow/worktrees/<repoKey>/<gitRunKey>/integration/
```

created at implementation start, by case A or B of §5.3:

```bash
git branch agent-flow/<gitRunKey>/integration <planningBase>
git worktree add --lock <integration path> agent-flow/<gitRunKey>/integration
```

Merges happen there. Final verification happens there (§19). It is never the user's
working tree (I-10).

**It is recreatable, and the branch is not.** If the integration worktree is missing
on resume — pruned, removed by hand, on a machine whose home directory was cleaned —
it is re-created from the existing branch, with no loss. If the *branch* is missing,
that is `namespace_missing` (§5.3) and the run halts: a worktree is a checkout, a
branch is the work.

That asymmetry is why the initialisation sequence above is safe to interrupt anywhere.
Neither of its two commands is the thing that must not be repeated: `git branch` on an
existing branch at the same commit is refused harmlessly and case B adopts it, and the
worktree is recreatable by definition. The state write that follows is what makes the
run stop asking.

### 14.2 Order

**Integration order is the plan's stable topological order, restricted to the tasks
of the wave that produced a satisfied attempt.** Never completion time.

`topologicalOrder(dag)` in `core/dag.ts` is already Kahn's algorithm over a sorted
frontier and is documented as deterministic; MVP 2 reuses it and adds no ordering
logic of its own (I-2, I-9).

Two runs of the same plan, with the same agent outputs, produce the same integration
branch: the same markers — identical SHAs, because every input to `commit-tree` comes
from the artifact (§12.2) — merged in the same order, producing the same trees.

**The merge commits themselves are not SHA-identical across runs**, and the claim is
deliberately not made: `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` for a merge come from
the injected `Clock` (§14.5), so two runs an hour apart differ in the merge commits'
timestamps and therefore in their hashes. What is reproducible is the branch's *shape
and content* — the same sequence of merges, each with the same two parents and the
same resulting tree — which is what "deterministic integration" is for. A design that
merged in completion order would lose even that, and make the resulting tree a
function of how fast each CLI happened to respond that afternoon.

### 14.3 Per task

Serially, holding the in-process integration mutex (§18.2):

1. **Load the attempt artifact.** Absent or unparseable → the task did not produce
   evidence; it is not integrated.
2. **Validate the receipt.** `validationJudgement === 'satisfied'` and `receipt`
   present. The `.refine` guarantees these agree.
3. **Validate the marker.** The attempt branch exists and resolves to a commit; that
   commit has **exactly one** parent and it is `attempt.base` — the parent count is
   the structural discriminator (§14.7), so "first parent" is not the check; the
   trailers agree with the artifact.
4. **Validate the tree binding (I-6).**
   `git rev-parse <marker>^{tree}` MUST equal `receipt.validatedTree`. Mismatch →
   refusal, no repair.
5. **Check ancestry first.**
   `git merge-base --is-ancestor <marker> <integration>` — if the marker is already
   an ancestor, the merge already happened (a crash-recovery path, §17.3 window 7);
   skip to 7.
6. **Merge** (§14.5).
7. **On success:** write `TaskResult` with the `integration` block (§10.3), transition
   the task to `completed` **and advance `state.integrationHead` to the new merge
   commit — in one `StateStore` write**, release its dependents, and mark the attempt
   worktree reclaimable. Splitting that write would create a second version of
   §17.3 window 7 for every merge, and the single-writer queue (M2-00.1) makes one
   write the cheaper option anyway.
8. **On conflict:** §15.

**No validation command runs anywhere in this sequence.**

### 14.4 The only writer of `completed`

In worktree mode, `app/integrator.ts` is the only module that may write
`TaskState.completed` (I-3). `TaskExecutor` returns an attempt outcome and never a
completed task.

An architecture test pins this (§26.1). Without it, the invariant is one careless
`status: 'completed'` away from being false, and the failure would be silent: the DAG
would release dependents against an integration branch that does not contain their
dependency's work.

### 14.5 Merge strategy

**Frozen: `git merge --no-ff <marker>`, with hooks disabled by the wrapper (§12.3).**

```bash
git -c core.hooksPath=<no-hooks> \
    -c user.name='Agent Flow' -c user.email='agent-flow@local' \
    merge --no-ff --no-edit -m "<message>" <marker>
```

- **`--no-ff` always**, including the first merge of a wave where the marker's parent
  *is* the integration head and a fast-forward would be possible. A fast-forward
  would make the shape of the integration branch depend on how many tasks were in the
  wave, and "was this task integrated" would sometimes be answered by a merge commit
  and sometimes by ancestry alone. One task, one merge commit, always.
- **`--no-edit`** and an explicit `-m`: no editor, no interactive path.
- Author and committer as in §12.2; `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` from the
  injected `Clock`.

### 14.6 Merge message

```text
agent-flow: integrate TASK-003 (attempt 2)

Agent-Flow-Run: AF-2026-001
Agent-Flow-Run-Key: AF-2026-001-0f3a91c4bd27e615
Agent-Flow-Task: TASK-003
Agent-Flow-Attempt: 2
Agent-Flow-Marker: 3c8f…
Agent-Flow-Receipt: 7d41c0a9f2b85e6304ac71bd9e2f5a18
Agent-Flow-Wave-Base: 4a1c…
```

### 14.7 Telling the two kinds of commit apart

Both carry `Agent-Flow-*` trailers, so provenance needs an unambiguous discriminator:

| | marker | integration merge |
|---|---|---|
| subject | `agent-flow: <taskId> attempt <n>` | `agent-flow: integrate <taskId> (attempt <n>)` |
| parents | exactly one (`base`) | exactly two |
| `Agent-Flow-Tree` trailer | present | absent |
| `Agent-Flow-Marker` trailer | absent | present |
| reachable from `…/integration` | only through a merge | directly |

**The structural discriminator is the parent count**, and code MUST use it. Subjects
and trailers are for people; a parser that decided on the subject line would be
text-matching on a message, which this project has already been bitten by (Findings
§4).

---

## 15. Conflict and failure semantics

Two independent tasks touching the same lines is not a bug — it is a plan whose
independence analysis was wrong, and the run must say so rather than guess.

```text
git merge --no-ff <marker>
  → conflict
        ↓
git merge --abort                  the integration worktree returns to its pre-merge state
task  → review_required
run   → halted
```

Recorded, in `events.jsonl` as `integration_conflict` and in the task's `TaskResult`:

- conflicting paths (from `git diff --name-only --diff-filter=U`)
- task id, attempt number
- the attempt's base and marker
- the integration head at the moment of the attempted merge
- the previously integrated sibling whose merge moved that head, when there is one —
  this is usually the actual answer to "why did this conflict"

**MVP 2 does not:** resolve conflicts with an LLM, generate a corrective task, or
fall back to another model. All three are ways of making a wrong plan look like it
worked.

**Recovery is human.** A person resolves the overlap — usually by revising the plan
so the tasks are genuinely independent, or by making one depend on the other — and
retries. A retry creates a new attempt against the *current* integration head, where
the sibling's work is already present, so the conflict is gone by construction (§16).

---

## 16. Retry

```text
retry TASK-003
    ↓
attempt := n + 1
branch  := agent-flow/<gitRunKey>/TASK-003/attempt-<n+1>       new
worktree:= <repoKey>/<gitRunKey>/TASK-003/attempt-<n+1>        new
base    := current integration HEAD                            not the old base
```

**A defective worktree is never reused (I-12).** Reusing it would mean the new
attempt starts on top of the previous attempt's partial edits, and its validated tree
would contain work the new agent never saw and nobody attributed.

**A retry never overwrites a previous attempt's evidence.** `attempt-1.json` is
immutable; `attempt-2.json` is a new file. Logs are already attempt-addressable via
`logs/implementation-<taskId>.log` and MUST become
`logs/implementation-<taskId>-attempt-<n>.log` so the same rule holds for them.

The old branch `…/attempt-1` is retained. It is the only durable record of what the
failed attempt produced.

`retry.maxAttempts` continues to bound this, using the counter M2-00.2 made correct.

---

## 17. Crash recovery

### 17.1 The rule

**Receipt-first (I-5).** Recovery reads the attempt artifact, then asks the
repository to confirm it. It never does the reverse.

The forbidden shape, written out so it is recognisable in review:

```text
FORBIDDEN:
  look at refs/heads/agent-flow/<key>/<task>/attempt-<n>
  → it exists and its message looks like a marker
  → trust it
```

That shape trusts a ref, and a ref is something an agent with a shell in a worktree
can create.

The permitted shape:

```text
read attempt-<n>.json
  → required: parses, validationJudgement === 'satisfied', receipt present
  → required: git cat-file -e <receipt.validatedTree>^{tree}
  → required: marker exists AND rev-parse <marker>^{tree} === receipt.validatedTree
  → required: marker's Agent-Flow-Receipt trailer === receipt.nonce
  → only then: treat the marker as this attempt's marker
```

Both the tree check and the nonce check are required. Either alone is insufficient:
the tree alone would accept any commit that happens to have the right tree; the nonce
alone would accept a commit whose trailers were copied.

### 17.2 Entry point

Recovery runs at the start of `start`, before any wave, under the run execution
lock — so no other process is touching this run (§18.2). It extends the existing
`Scheduler.recoverInterrupted`, which already brings orphaned `running` tasks back
through `interrupted`; MVP 2 adds the Git half.

### 17.3 The windows

For each task not in a terminal state, in topological order:

Window 0 is not per task — it is the run's own initialisation, and it is checked once
before the loop below.

| # | Window | Detection | Resolution |
|---|---|---|---|
| 0 | **Crashed during namespace initialisation** | `state.integrationHead` absent; the integration branch exists at `planningBase` with nothing else in the namespace | Case B of §5.3. Adopt the branch, recreate the integration worktree if needed, persist `integrationHead = planningBase`. **Never a collision** — the run must not refuse its own branch. |
| 1 | **Crashed during the agent** | task `running`; no `attempt-<n>.json` | The attempt's work was never observed. Task → `interrupted` → requeued as attempt *n+1* within `maxAttempts`. Old worktree retained. |
| 2 | **Crashed after validation, before the receipt was written** | task `running`; no `attempt-<n>.json` | Indistinguishable from (1), and correctly so: with no artifact there is no evidence, and the milestone does not infer evidence from a worktree's contents. Same resolution as (1). |
| 3 | **Crashed after the receipt, before the marker** | `attempt-<n>.json` with a receipt; branch absent | The tree object still exists (checked). Re-run `commit-tree` → the *same* SHA (§12.2) → `update-ref`. Continue to integration. |
| 4 | **Crashed after `commit-tree`, before `update-ref`** | as (3): the commit object exists, the ref does not | Identical handling. `commit-tree` is idempotent by SHA, so this window does not need to be distinguished from (3) at all. |
| 5 | **Crashed after the marker, before the merge** | receipt + valid marker; marker not an ancestor of integration | Verify tree binding and nonce (§17.1), then merge (§14.3 step 6). |
| 6 | **Crashed during the merge** | the integration worktree has an in-progress merge (`MERGE_HEAD` present, or `git status` reports merging) | `git merge --abort`, then re-attempt from a clean integration worktree. If the abort fails, refuse with `integration_worktree_unavailable` and halt — never force. |
| 7 | **Crashed after the merge, before `StateStore` recorded completion** | `git merge-base --is-ancestor <marker> <integration>` is true; task is not `completed`; `integrationHead` is behind the branch | The merge happened. Do **not** merge again. Write `TaskResult` with the integration block (reconstructed from the artifact and the merge commit found by walking integration for a merge whose second parent is the marker), transition to `completed`, and advance `integrationHead` — the same single write as §14.3 step 7. |
| 8 | **Crashed after completion, before cleanup** | task `completed`; its attempt worktree still registered | Cleanup only. Reclaimable, not required — a leftover worktree costs disk, never correctness. |
| 9 | **Sibling workers still alive** | another process holds the run execution lock | Not a recovery case. The second process is refused with `run_busy` (§18.2). Recovery only ever runs in a process that holds the lease. |
| 10 | **Receipt tree pruned before the marker existed** | `git cat-file -e <validatedTree>^{tree}` fails | The validated tree is gone (a `git gc` between the crash and the resume; the tree was never referenced). The attempt cannot be reconstructed. Requeue as a new attempt, event `attempt_tree_missing`. **Never fabricate a tree.** |
| 11 | **Marker exists but does not match the receipt** | tree or nonce mismatch | Refusal `attempt_marker_mismatch`. Task → `review_required`, run halted. This is the forged-or-corrupted case and it MUST NOT be repaired automatically. |

### 17.4 Idempotency primitives

The whole recovery design rests on four Git operations that are safe to repeat:

```bash
git cat-file -e <oid>                          does this object exist
git rev-parse <commit>^{tree}                  structural tree identity
git merge-base --is-ancestor <a> <b>           has this already been merged
git merge --abort                              return to the last consistent state
```

plus one property of Git itself: **content-addressed commit identity**, which is what
makes re-running `commit-tree` free (§12.2).

Nothing in recovery depends on a timestamp, a lock file, a marker file, or a
"we got this far" flag. Every one of those would be a second source of truth that can
disagree with the repository.

---

## 18. `StateStore` and the execution lock

### 18.1 `StateStore`

**Unchanged.** M2-00.1 serialised `updateRun` per state file; that is the protection
and MVP 2 adds none.

MUST NOT be introduced:

- a second state database
- per-worktree state files
- scheduler-owned persisted state
- any Git call inside `StateStore` (I-1)

Workers **MAY** call `StateStore` concurrently. `appendEvent` stays unserialised, and
the reason M2-00.1 gives becomes load-bearing rather than theoretical: once tasks
genuinely run at the same time, the order two of their events were written in *is*
information, and a queue that tidied it would make the audit trail describe a
sequence that did not happen.

### 18.2 The execution lock

**AF-L01 is unchanged.** The generational algorithm is not touched.

```text
one RunExecutionLock holder (a process)
        └── N in-process workers
```

- Workers **MUST NOT** take filesystem locks of their own. They are inside the
  lease-holding process.
- **Integration uses an in-process mutex**, not a file lock. A file lock to order two
  callbacks in one event loop would be a syscall standing in for a promise, and a
  second locking mechanism to keep in step with AF-L01 — an architecture test already
  forbids `createExclusive` outside the lock module and MUST keep forbidding it.
- A concurrent CLI or server acting on the same run continues to get `run_busy`.

The one thing that changes is what the lease *means*. Today it means "one process
schedules this run". Under MVP 2 it also means "one process owns this run's Git
namespace and its integration worktree" — which is why recovery (§17) can assume no
other process is mid-merge.

**That widened meaning adds one command to the lease, and it is `review`.**

At `e24dd48` the lease is taken by `approve`, `reject`, `retry`, `run` and `revise`
(`withExecutionLock` in `src/app/run-actions.ts`). `review` is deliberately outside
it, and today that is correct: `review` only reads the user's working tree, so it
cannot collide with anything.

Under MVP 2 that stops being true. §19.1 moves `runVerification` and the reviewer's
`GitClient` into **the integration worktree** — the same checkout the Integrator
merges into. A `review` that runs while the scheduler holds the lease would run
`lint · typecheck · test · build` over a tree that a merge is rewriting underneath
it, and would report a result for a tree that never existed at any single instant.
Worse, window 6 of §17.3 detects a crashed merge by observing `MERGE_HEAD` in that
worktree — a concurrent `review` observing the same worktree mid-merge would see the
same evidence and reach a conclusion about a run that is perfectly healthy.

So, in worktree mode:

- **`review` MUST take the run execution lock**, through the same `withExecutionLock`
  as every other write action, and a concurrent `review` gets `run_busy` like
  everything else.
- In sequential mode `review` MAY keep running without the lease, because there it
  still only reads the project directory. The lease is taken for what the command
  touches, not for what it is called.

---

## 19. Final verification and review

### 19.1 Where

**In the integration worktree, against the final integration branch.** Never in the
user's working tree.

Today `agent-flow review` builds a `GitClient` on `globals.cwd` and runs
`runVerification({ cwd: globals.cwd })` (`src/cli/review.ts`). In worktree mode both
MUST become the integration worktree path, and **the command MUST hold the run
execution lock while they do** (§18.2): it is no longer a read of the user's tree, it
is a read of the tree the Integrator writes.

### 19.2 One tree, verified and reviewed

```text
integration branch (final)
   ├── runVerification        ← lint, typecheck, test, build
   ├── final review agent     ← reads the same tree, cwd = integration worktree
   └── Definition of Done     ← evaluated over the same artifacts
```

**There MUST NOT be a "validated tree A, reviewed tree B" situation.** The
verification result, the reviewer's diff and the DoD evaluation all describe one
commit, and **that commit is `state.integrationHead`** (§6.1) — read once, at the
start of review, and used for all three. It is the same field the Integrator advances
on every merge (§14.3) and the same field §5.3 uses to tell initialisation from
resume; one durable Git fact serves all three purposes, and a run cannot be reviewed
against a commit its own state does not name.

The reviewer's changed-file list is computed as
`integration branch vs planningBase` — which for the first time gives the reviewer the
feature's diff rather than the diff of everything sitting in the user's tree. The
scaffold annotation in `annotateScaffold` becomes largely unnecessary in worktree mode,
because `init`'s output is no longer in the diff at all; it MUST be kept for
sequential mode.

### 19.3 The user's working tree

> **A property of MVP 2: the working tree Agent Flow was started from is unchanged
> — logically and byte-for-byte — throughout parallel implementation.**

The product of a run is a **branch**:

```text
agent-flow/<gitRunKey>/integration
```

Agent Flow **MUST NOT**:

- check the integration branch out into the user's working tree
- merge it into the user's branch
- push anything, anywhere
- change the user's `HEAD`

The final CLI output and the dashboard MUST state, unambiguously, where the code is
and what to do with it:

```text
Feature complete.

  branch     agent-flow/AF-2026-001-0f3a91c4bd27e615/integration
  base       4a1c8e2  (your HEAD when this run started)
  tasks      6 integrated
  verified   lint · typecheck · test · build

Your working tree was not modified.

  Review it:   git log --oneline 4a1c8e2..agent-flow/AF-2026-001-0f3a91c4bd27e615/integration
  Diff it:     git diff 4a1c8e2..agent-flow/AF-2026-001-0f3a91c4bd27e615/integration
  Take it:     git merge agent-flow/AF-2026-001-0f3a91c4bd27e615/integration
```

The user's own hooks run on that last command, exactly as they should (§12.3).

Because this output makes a promise — *the code is on that branch, go and get it* —
the branch has to still be there when the user comes back for it. That is what §20.4
enforces against `clean`, which otherwise reclaims runs older than the newest five
without being asked twice.

---

## 20. Cleanup and retention

### 20.1 `agent-flow clean` becomes Git-aware

**Current:** `clean` removes `.agent-flow/runs/<id>` directories with `fs.remove`.

**MVP 2:** removing a run's state without removing its worktrees and refs would leave
registered worktrees and branches with no state that explains them — orphans nothing
can attribute. So `clean` gains a Git half, and the order matters:

```text
for each run being removed:
    1. reclaim the run's worktrees   (unlock → git worktree remove)
    2. git worktree prune
    3. delete the run's ATTEMPT refs (refs/heads/agent-flow/<gitRunKey>/<taskId>/attempt-<n>)
    4. the integration branch: retain, or delete only when redundant   (§20.4)
    5. remove .agent-flow/runs/<id>
```

If any of steps 1, 3 or 4 fails, step 5 **MUST NOT** run. A run whose namespace could
not be reclaimed keeps its state, and `clean` says so and exits non-zero for that run.

### 20.2 Rules

- **Never `rm -rf` a registered worktree.** Always `git worktree unlock` (when
  locked) then `git worktree remove`, then `git worktree prune`.
- **Every path acted on MUST derive from trusted run state or from
  `git worktree list --porcelain`.** Never from a request body, never from model
  output, never from a browser (§22).
- **Refuse to touch:** branches outside `refs/heads/agent-flow/<gitRunKey>/`,
  worktrees not registered to this repository, the active run, and any run whose
  execution lock is currently held.
- **A worktree whose registered path is not under `~/.agent-flow/worktrees/<repoKey>/`
  is foreign and MUST be left alone**, even if its branch is in the Agent Flow
  namespace. A user who moved one made a choice.
- **Removing a run's state never destroys unmerged product** (§20.4).

### 20.3 Retention

Preserved by default, because they may be the only copy of something useful:

- the integration branch of every run, retained **and removed** — it is the product,
  and §20.4 is the rule that says so
- worktrees of tasks that are `failed`, `blocked` or `review_required`
- worktrees of attempts that were never integrated
- every `attempt-<n>.json`, for every attempt, forever within the run's retention

Reclaimable by default:

- worktrees of attempts that were integrated (their tree is on the integration
  branch; the worktree is a duplicate)

New flags:

```text
agent-flow clean --worktrees        also reclaim retained worktrees of retained runs
agent-flow clean --branches         also delete unmerged integration branches (§20.4)
agent-flow clean --dry-run          with either, or with neither
```

`--worktrees` never touches refs of retained runs. Branches are cheap; a checkout is
not. `--branches` is the only flag that deletes work, it is never implied, and §20.4
is the rule it opts out of.

**Documented user recovery**, which MUST appear in
[`docs/troubleshooting.md`](../troubleshooting.md):

```bash
agent-flow clean --worktrees --dry-run          # what would be reclaimed
git worktree list                               # what is registered
git worktree remove <path>                      # one, by hand
git branch -D agent-flow/<gitRunKey>/<taskId>/attempt-1
```

### 20.4 The integration branch survives its run's state

**Deleting a run's state MUST NOT delete unmerged work.**

`clean` at `e24dd48` keeps the newest five runs and removes the rest
(`src/cli/clean.ts`, `--keep`, default 5). That is a sensible policy for state
directories. Applied unchanged to the Git half it becomes a data-loss bug: §19.3 tells
the user in so many words that **the product of a run is a branch**, prints
`git merge agent-flow/<gitRunKey>/integration` as the thing to do with it, and then a
routine `agent-flow clean` — a housekeeping command, run by someone tidying up, weeks
later, with no run in flight — deletes exactly that branch as part of "the run's
refs". The user is left with the run's state gone, the worktrees gone, and the feature
gone with them.

So the two kinds of ref in a namespace are **not** cleaned by the same rule:

| Ref | Kind | On `clean` |
|---|---|---|
| `…/<taskId>/attempt-<n>` | diagnostic — reachable evidence of one attempt | deleted with the run's state |
| `…/integration` | **product** — the feature | retained, unless redundant (below) |

**Redundant is a mechanical question, and it is the only one that authorises
deletion:**

```text
refs := git for-each-ref --format='%(refname)' refs/
foreign := refs where the name does not start with "refs/heads/agent-flow/"
redundant := any f in foreign with
             git merge-base --is-ancestor <integration> <f>  → exit 0
```

The filtering happens in Agent Flow, over the argv output of `for-each-ref` — not in a
shell pipeline (S-8) and not through a `for-each-ref` exclusion flag, whose
availability is a Git-version question this document refuses to answer from memory
(§23).

If the branch is an ancestor of any ref outside `refs/heads/agent-flow/`, the user
took the work — the branch is a duplicate of history they already own, and deleting it
loses nothing. If it is an ancestor of nothing, it is the **only** copy, and `clean`
keeps it and says so:

```text
removed  AF-2026-001  (state, 3 worktrees, 4 attempt refs)
kept     agent-flow/AF-2026-001-0f3a91c4bd27e615/integration — not merged anywhere
         6 tasks · git log --oneline 4a1c8e2..agent-flow/AF-2026-001-.../integration
         delete it with: agent-flow clean --branches   (or git branch -D)
```

A kept branch is **not** a failure: `clean` still exits zero, still removes the state,
and still reports the run as removed. The branch is the one thing that outlives it.

`--branches` (§20.3) is the explicit opt-in, it is never implied by `--worktrees`,
and it never becomes a default. A user who asks for it has been told what is on the
other side of the question — the report above ran first, on a previous invocation or
under `--dry-run`.

**Retained branches are the reason a namespace can outlive its run**, and that is
consistent with §5.3 rather than in tension with it: `gitRunKey` carries 64 bits of
randomness precisely so that a *new* run can never adopt refs a *removed* run left
behind. This rule is the case that entropy was bought for.

---

## 21. CLI and Web read models

### 21.1 Principle

**Unchanged (I-8, §93):** the browser sends ids. The server resolves everything else
from run state and the Git registry. Merge logic, scheduling logic and Git live on
the server; React renders answers.

### 21.2 New facts the read model MAY expose

| Fact | Shape | Source |
|---|---|---|
| parallelism | `{ requested: number, effective: number, clamped: boolean, reason?: string }` | `ConcurrencyDecision` |
| isolation mode | `'none' \| 'worktree' \| 'legacy'` | `state.isolationMode`, captured at creation (§6.1). `legacy` is the absent case (§25.2), projected — never a stored value |
| per-task attempt | `number` | `TaskProgress.attempts` |
| workspace active | `boolean` | task is `running` in worktree mode |
| awaiting integration | `boolean` | attempt satisfied, not yet integrated |
| integration conflict | `{ task, attempt, paths: string[] }` | `integration_conflict` event |
| integration branch | `string` (a **ref name**) | `agent-flow/<gitRunKey>/integration` |
| integration provenance | `TaskResult.integration` | the result artifact |

### 21.3 What MUST NOT be exposed

- **absolute filesystem paths of worktrees** — the artifact only stores a
  workspace-relative path (§7.2), and the read model MUST NOT resolve it
- worktree paths in **any** event detail or in `state.json`
- any endpoint that accepts a branch, a ref, a worktree path, an OID or a Git command

An architecture test asserts that no response type in
`src/contracts/api.schema.ts` declares a worktree-path-shaped field, alongside the
existing test that no *request* schema accepts a path (§26.1).

### 21.4 CLI

`agent-flow status` gains, in worktree mode: the integration branch name, the number
of tasks integrated, the current wave, per-task attempt numbers, and — for a halted
run — the conflicting paths.

`agent-flow run --dry-run` prints the resolved concurrency, the run's isolation mode,
and, when a precondition is unmet, **the refusal code and what to do about it**. This
is the command that answers "why is this still running one task at a time".

Both commands MUST also answer the question §6.4 creates: **when the run's mode and
the current `git.useWorktrees` disagree, say so, and say which one applies.**

```text
isolation  worktree   (captured when this run was created)
           your configuration now says useWorktrees: false — it does not
           apply to this run. Start a new run to execute sequentially.
```

Without that line the tool looks broken to the one user who did exactly what the
documentation told them to do and then wondered why it had no effect.

---

## 22. Security

Trust boundaries in this milestone, in order of how much damage crossing one does:

| # | Threat | Trust boundary | Mitigation | Test |
|---|---|---|---|---|
| S-1 | `taskId` path traversal (`../../etc`) into a worktree path or ref | plan → filesystem/refs | `AnyTaskIdSchema` at plan parse; `core/worktree-policy.ts` re-validates against `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` before any path or ref is composed; path assembly uses `node:path`, never string concatenation | unit: traversal, absolute, empty, unicode, `.`/`..`, 300-char ids all refused |
| S-2 | `gitRunKey` ref injection (`--upload-pack=`, `..`, spaces, `@{`) | state → refs | `GitRunKeySchema` on load; `GitWorkspaces` re-validates immediately before composing any ref; every ref passed as a single argv element after `--` where the command supports it | unit: an injected key never reaches argv; integration: real Git refuses |
| S-3 | escaping the worktree root | policy → filesystem | every worktree path is composed from validated components under a root resolved by `Host`; containment asserted with `path.relative`, never `startsWith` (D-F02) | unit, incl. `path.win32` rules asserted on Linux |
| S-4 | symlink inside the worktree root redirecting a removal | filesystem | `realPath` before deciding a registered worktree is inside the root — the same rule the project registry already uses | unit + real-FS integration |
| S-5 | cleanup removing a foreign path | run state → filesystem | only paths from run state or `git worktree list --porcelain`, filtered to `~/.agent-flow/worktrees/<repoKey>/`; `git worktree remove`, never `rm -rf` (§20.2) | integration: a foreign worktree and a foreign branch survive `clean` |
| S-6 | browser supplying a branch or ref | HTTP → Git | no request schema has a ref-shaped field; the server derives every ref from `gitRunKey` | architecture test on `api.schema.ts` |
| S-7 | browser supplying a worktree path | HTTP → filesystem | no request schema accepts a path (already enforced); no response exposes one (§21.3) | architecture test, both directions |
| S-8 | a model emitting a Git command | plan/agent → shell | Git is spawned only by `git-command.ts`, with argv built from validated components; no shell; V-01 unchanged | architecture test: one module spawns `git` |
| S-9 | an agent forging a marker | worktree → repository | receipt-first recovery; nonce generated after the agent exits; tree binding required (§11, §17.1) | integration: a forged marker with correct trailers and a different tree is refused |
| S-10 | an agent forging an attempt artifact | worktree → orchestrator state | artifacts live outside every worktree and are gitignored; atomic single write, no overwrite; schema `.refine`. **Residual risk stated in §11.3 — this is not fully closed and MUST NOT be claimed as closed.** | integration: an overwrite attempt is refused |
| S-11 | setup contaminating the validated tree | project config → marker | post-setup cleanliness assertion; agent not invoked on failure (§8.3) | integration: an install that touches a tracked file refuses, and no marker is created |
| S-12 | Git hooks executing inside an internal operation | repository config → Agent Flow | one wrapper injects an owned empty `core.hooksPath`; `git commit` forbidden (§12.3) | integration: hooks that write a sentinel file never fire for `worktree add`, `update-ref`, `merge`; the sentinel *does* appear for a user-issued merge |
| S-13 | a stale namespace being adopted by a new run | disk → Git | 64-bit `gitRunKey`; the §5.3 initialisation algorithm; refusal, never regeneration (§5.2). **Case B adopts a namespace, and is not a hole in this row**: it requires the integration branch at exactly `planningBase` with no attempt ref, no attempt artifact and no integrated task — a state carrying no work, which a stale namespace that got anywhere cannot be in | unit + integration |
| S-14 | a nested repository inside the worktree | filesystem | documented and DEFERRED (§23); not detected in MVP 2 | — |

Existing guarantees that MUST survive unchanged: validation ids resolved through the
project registry (V-01); approval bound to an exact plan hash; fallback restricted to
`quota_exceeded`, `auth_required`, `runner_unavailable`; no credentials read anywhere;
loopback-only server with no authentication and the same stated limits.

---

## 23. Git edge cases

| Condition | Verdict | Behaviour |
|---|---|---|
| repository with no commits (unborn HEAD) | **REFUSE EARLY** | `repository_has_no_commits`. There is no `planningBase` to cut a branch from. |
| bare repository | **REFUSE EARLY** | `repository_is_bare`. There is no working tree to have been planned against. |
| detached HEAD | **SUPPORTED** | `planningBase` is a commit; nothing in the design needs a branch name. |
| Agent Flow started inside a linked worktree | **SUPPORTED** | `repoKey` derives from `--git-common-dir`, so every worktree of one repository agrees (§5.1). |
| shallow clone | **SUPPORTED** | Every base is `planningBase` or a locally created descendant of it, so every merge base needed is inside the shallow set. Recorded as an event; no refusal. |
| submodules | **REFUSE EARLY** | `repository_has_submodules`. `git worktree add` does not populate submodules, so the worktree would build against missing code and fail validation for a reason the failure message would not explain. Detected via `.gitmodules` **and** non-empty `git submodule status`. |
| nested repository inside the working tree | **DEFER** | Not detected. Documented as a known limitation: a nested repo is untracked content that a fresh checkout will not contain. |
| case-insensitive filesystem | **SUPPORTED** | `realpath` resolves both spellings to the stored name; the canonical root is hashed verbatim (§5.1). |
| `realpath` fails on the repository root | **REFUSE EARLY** | `repository_root_unresolvable`. Guessing produces a `repoKey` that is not stable. |
| Git older than the supported floor | **REFUSE EARLY** | `git_version_unsupported`, probed by `doctor`, evaluated at `createRun` and re-checked before every execution (§6.1, §6.3). |
| Windows path length | **REFUSE EARLY** | `worktree_path_too_long` when the projected worst case (root + `repoKey` + `gitRunKey` + `taskId` + `attempt-<n>` + the repository's own deepest tracked path) exceeds the platform limit and long paths are not enabled. A dedicated worktree-root setting is **DEFERRED**; the documented workaround is a shorter home path or enabling long paths. |
| `core.autocrlf` / `.gitattributes` making a fresh checkout dirty | **HANDLED** | Caught by the pre-setup cleanliness assertion, reported with `phase: "checkout"` (§8.3) — which is why that assertion exists separately from the post-setup one. |
| Windows generally | **UNVALIDATED** | No CI job runs there and the process timeout still cannot signal a process tree. `doctor` MUST say worktree mode is unvalidated on Windows. |

**On the Git version floor — determined in M2-02, and this is the answer.**

```text
MINIMUM_SUPPORTED_GIT_VERSION = 2.33.0
```

Pinned in `src/adapters/git/git-workspaces.ts`, reported by `doctor`, and stated in
the README. The operations this milestone needs are `worktree add --lock --reason`,
`worktree remove`, `worktree unlock`, `worktree prune`, `worktree list --porcelain`,
`rev-parse --path-format=absolute`, `write-tree`, `commit-tree`, `update-ref`,
`merge --no-ff --no-edit`, `merge --abort`, `merge-base --is-ancestor`, `cat-file -e`,
`for-each-ref` and `status --porcelain=v1 --untracked-files=all`. Exactly one of them
sets the floor:

| Flag | Introduced | Evidence |
|---|---|---|
| `worktree add --lock --reason <string>` | **2.33.0** | Release notes 2.33.0: *"`git worktree add --lock` learned to record why the worktree is locked with a custom message."* The `add` synopsis carries `[--lock [--reason <string>]]` from the 2.33.0 manual page and does not in 2.31.0's; the 2.32.0 page is the 2.31.0 document unchanged. |
| `worktree add --lock` | ≤ 2.30.0 | In the 2.30.0 synopsis, absent from 2.9.5's. |
| `rev-parse --path-format=absolute` | 2.31.0 | Below the floor, so it does not move it. |
| `--end-of-options` (used to harden `rev-parse`) | 2.24.0 | Release notes 2.24.0: *"The command line parser learned `--end-of-options` notation."* Below the floor. |
| everything else | ≤ 2.11.0 | — |

**`worktree list --porcelain -z` was deliberately not adopted.** It arrived in 2.36.0
(absent from the 2.35.0 synopsis, present in 2.36.0's) and would move the floor three
minor versions to close one edge case — a *foreign* worktree whose path contains a
newline is not representable in the non-`-z` porcelain format. The exposure is
bounded, because every path Agent Flow acts on is re-checked for containment under its
own canonical root, so a mis-split record cannot become a directory it removes. M2-09
owns cleanup and may reopen the trade-off; the reasoning is recorded in
[`findings.md`](../engineering/findings.md).

`status --porcelain=v1` **is** issued with `-z`, which long predates the floor and
costs nothing. It is not optional there: without it a rename and a file literally
called `old -> new` are the same bytes.

Probed on Git 2.52.0. A version asserted here from memory would have been a claim
nobody checked, and this project's own Findings document exists because of exactly
that kind of claim.

---

## 24. Resource bounds

Parallelism is not free, and the costs are not proportional to the speedup.

| Resource | Cost at concurrency N | Consequence |
|---|---|---|
| disk | N full checkouts + N dependency installs, plus the integration worktree | A 200 MB repository with a 600 MB `node_modules` costs ~3.2 GB at N=4. This is the binding constraint on most machines. |
| agent quota | N concurrent agent processes | Quota burns N times faster in wall-clock terms. `quota_exceeded` is a fallback trigger and will fire more often. |
| processes | N agents + N installs + N validation command sets | Each may spawn a process tree. On Windows the timeout cannot signal one (existing limitation). |
| CPU / IO | N test suites at once | On a 4-core laptop, four `npm test` runs are not four times faster than one. §27 measures this rather than assuming it. |

Therefore:

- `MAX_ISOLATED_TASK_CONCURRENCY = 8`, one edit to change (§4.4).
- `doctor` SHOULD report projected worktree disk cost for the configured
  `parallelism.maxTasks` and warn when free space is below it.
- The dogfood matrix (§27) MUST measure worktree setup time, install time, wall-clock
  gain and disk, on both stacks — and **if parallelism does not improve wall-clock
  time on a given project, that MUST be documented rather than hidden.** Isolation is
  worth having on its own (§1); a milestone that quietly implied a speedup it does
  not deliver would be a milestone that lied.

---

## 25. Migration and compatibility

### 25.1 The default is unchanged

```yaml
git:
  useWorktrees: false      # default, unchanged
```

**The flag is a default for runs not yet created**, never a switch over runs that
exist (§6.1, I-13). Changing it changes what the next `createRun` captures and nothing
else.

Runs execute sequentially, in the user's working tree, exactly as at `e24dd48`.
`parallelism.maxTasks` above 1 continues to be accepted, clamped to 1 at runtime, and
recorded as the `parallelism_clamped` degradation.

**No new degradation kind is added**, which keeps the contract change to
`DEGRADATION_KINDS` at zero. The existing `parallelism_clamped` covers the whole
surface, and it is derived at creation from `(isolationMode, maxTasks)` alone (§6.4) —
a run created sequential with `maxTasks: 4` gets it, with a reason naming the mode.

A run that is *refused* records no degradation, because it does not run: the outcome
is an `ActionError` and an event, and there is no execution to describe as degraded.
Writing a degradation for a run that never started would put a claim about how it
executed on a run that did not.

### 25.2 Runs created before MVP 2

They have no `gitRunKey`, no `planningBase` and no `isolationMode`, because all of
them are optional additions to `RunStateSchema`. **That shape — the fields absent — is
what a legacy run *is*.** It is not a run in sequential mode; it is a run that
predates the question, and the two are told apart by `isolationMode` being absent
rather than `'none'`. Therefore:

- They **MUST** continue to parse, load, display and resume — including with
  `useWorktrees: true` in the configuration, which describes runs created from now on
  and says nothing about them (§25.1).
- They execute exactly as they always did: **legacy sequential**, in the user's
  working tree, with no preconditions evaluated (§6.3) and no gates enforced (§6.2).
- They **MUST NOT** be promoted. No execution, no resume and no configuration change
  ever gives a legacy run an `isolationMode`. There is no path from absent to
  `'worktree'`, and the absence of that path is the guarantee — not a check that
  happens to refuse.
- Agent Flow **MUST NOT** back-fill any of the fields. There is no honest value for
  `planningBase` on a run whose planning already happened — the current HEAD is not
  it, and writing it anyway would be inventing the evidence the field exists to
  provide (I-5). The same argument retires `planning_base_missing` as a runtime
  refusal: there is nothing to refuse at execution time, because there was never a
  moment at which this run could have been isolated.

`agent-flow status` on such a run says, in words: this run predates workspace
isolation; start a new run to use it.

### 25.3 Forward compatibility of artifacts

`attempt-<n>.json` is a new file with a new name, so no existing reader sees it.
`TaskResult.integration` is optional, so an old `result.json` still parses and a new
one is still readable by any consumer that ignores unknown-but-optional blocks.

---

## 26. Testing strategy

### 26.1 Architecture tests

`test/architecture.test.ts` is **updated, never deleted**. The M2-00 rules stay and
are generalised where isolation makes them obsolete as written.

Rules to change:

| Current rule | Change |
|---|---|
| *"creates no git worktree anywhere in production code"* | becomes: **only `src/adapters/git/**` may name `worktree add\|remove\|prune\|list`** |
| *"reads `git.useWorktrees` nowhere that could grant isolation"* | becomes **stronger, not weaker**: the allowlist is exactly one module, `src/app/run-git-identity.ts`, and one call path, `createRun`. Every other consumer reads `state.isolationMode`. This is the architecture test that makes I-13 structural instead of remembered |
| *"keeps the ceiling in the resolver"* | asserts both `MAX_SUPPORTED_TASK_CONCURRENCY = 1` and `MAX_ISOLATED_TASK_CONCURRENCY` |
| *"hands the scheduler a resolved number"* | additionally asserts the isolation argument is passed, not defaulted |

Rules to add:

1. **Only `src/adapters/git/git-command.ts` spawns `git`.** Nothing else may build
   `{ command: 'git' }`. *This has a known offender today:
   `src/app/discovery-cache.ts` runs `git` through `ProcessRunner` directly — M2-02
   MUST route it through the client.*
2. **The scheduler contains no raw Git command** and imports nothing from
   `src/adapters/git/`.
3. **`StateStore` contains no Git call and no Git import** (I-1).
4. **Asymmetric, because the two directions are different problems.**
   *No **request** contract accepts a worktree path, a ref, a branch, an OID or a
   command* — the existing "no filesystem path in a request" test is extended to
   ref-shaped and OID-shaped fields (I-8).
   *No **response** contract exposes a filesystem path* (§21.3). Ref names and OIDs
   **MAY** appear in responses: they are provenance a person needs — §19.3 prints the
   integration branch — and the server never accepts one back.
5. **Recovery never trusts trailers alone**: the recovery module compares
   `validatedTree` and reads the artifact before any ref.
6. **Only `src/app/integrator.ts` writes `TaskState.completed` in worktree mode**
   (I-3).
7. **Every internal Git invocation carries the hook-isolation flag**: no `git` argv
   is built anywhere without `core.hooksPath` (I-7).
8. **`--no-verify` appears nowhere** in production code.
9. **`git commit` (as opposed to `commit-tree`) appears nowhere** in production code.
10. **Cleanup uses `git worktree remove`, never `fs.remove`, on a registered
    worktree.**
11. **Integration order comes from `core/dag.ts`** — the integrator imports it and
    implements no ordering of its own (I-2, I-9).
12. **Nothing outside `src/app/run-actions.ts` runs `runVerification` or builds a
    `GitClient` on the integration worktree.** `src/cli/review.ts` becomes an adapter
    over the application service like every other write action, which is what puts it
    under the lease (§18.2). The test is an import rule, because "did you remember to
    take the lock" is not observable and "who may call this" is.
13. **Only `createRun` writes `isolationMode`, `planningBase` or `gitRunKey`** (I-13).
    No other write path names them, and `StateStore.updateRun` MUST reject a patch
    that carries one. The same shape of test as rule 6, for the same reason: an
    invariant that only one module can break is an invariant.

### 26.2 Unit tests (pure, no filesystem)

- `repoKey`: stability, distinctness, slug sanitisation, length bound, empty basename
- `gitRunKey`: generation shape, validation, `runId` prefix invariant, rejection of
  injection payloads
- branch naming and workspace-relative paths, for every legal and illegal `taskId`
- preconditions: each code and its evaluation order; a run with
  `isolationMode: 'none'` is never evaluated at all; a legacy run is never evaluated
  and never promoted; **neither of them asks Git anything**, including in a directory
  that is not a repository
- the §5.3 initialisation algorithm, as a pure decision over
  `(integrationHead, namespace shape, planningBase)`: A, B, C and both failures of D,
  with B asserted **not** to produce `git_run_key_collision`
- **mode immutability (I-13), as four named cases** rather than a generic assertion:
  a `none` run under `useWorktrees: true` stays `none`; a `worktree` run under
  `useWorktrees: false` stays `worktree`; a `working_tree_dirty` refusal leaves the
  mode and every other field byte-identical, and the next start executes; a legacy run
  gains neither `isolationMode` nor `planningBase` from any of it
- `parallelism_clamped` is derived from `(isolationMode, maxTasks)` and from nothing
  else — recorded for `none × maxTasks > 1`, not recorded for `none × maxTasks === 1`
- `resolveTaskConcurrency` across `{1,2,4,16} × {none, worktree}`
- receipt matching: nonce match/mismatch, tree match/mismatch, and every combination
  of the two
- `TaskAttemptResultSchema` `.refine`: receipt-without-satisfied and
  satisfied-without-receipt both fail to parse
- integration ordering from a plan with a known topology
- conflict → `review_required` mapping
- `path.win32` containment rules, asserted on Linux

### 26.3 Real-Git integration tests

Temporary repositories on a real filesystem. **Git MUST NOT be mocked for any of:**

```text
worktree add / lock / unlock / remove / prune
write-tree · commit-tree · update-ref
merge · merge conflict · merge --abort
merge-base --is-ancestor · cat-file · rev-parse ^{tree}
hook isolation
cleanup
```

Named cases that MUST exist:

- a marker whose tree equals its base is created and merges cleanly
- a forged marker with correct trailers and a different tree is **refused**
- `commit-tree` run twice from the same artifact yields the same SHA (§12.2)
- hooks that write a sentinel file do **not** fire for `worktree add`, `update-ref` or
  an internal `merge`, and **do** fire for a merge the test issues as the user
- `clean` leaves a foreign worktree and a foreign branch untouched
- `clean` leaves no worktree and no attempt ref in the namespace of a removed run
- **`clean` keeps the integration branch of a removed run that is merged nowhere**,
  reports it, and still exits zero; the same run cleaned again after the branch is
  merged into a user ref deletes it; `--branches` deletes it either way (§20.4)
- an install command that modifies a tracked file produces
  `task_workspace_preparation_failed` and **no marker**

### 26.4 Concurrency tests

- 2 independent tasks: both integrate, order is topological
- 4 independent tasks: same, and the integration branch has 4 merge commits in the
  plan's order
- 2 tasks editing the same lines: one integrates, the second conflicts, run halts,
  the conflicting paths are recorded
- one worker fails while a sibling succeeds: the sibling still integrates, then the
  run halts (§9.2)
- concurrent `StateStore` writes from N workers: no lost update (extends
  `state-store.concurrency.test.ts`)
- the integration mutex: two integrations never interleave

### 26.5 Crash recovery tests

**Every window in §17.3 gets a test**, driven by killing the coordinator at a
deterministic point (an injected fault hook in the test build, not a sleep).
Windows 3, 4, 5, 6, 7 and 11 are the ones that can corrupt an integration branch and
MUST be tested against real Git.

### 26.6 E2E

Real Fastify, real `StateStore`, real filesystem, real Git, and the existing fake
coding executable substituted at `runners.<id>.command`.

- **Zero Claude/Codex invocations in CI.** No quota is spent.
- **No `page.route`.** The existing architecture test already forbids it.
- At least one scenario runs a plan with two independent tasks through worktree mode
  end to end and asserts the user's working tree is byte-identical before and after
  (I-10).

### 26.7 Manual probes

Claude Code and Codex remain dogfood-only, never in CI. Anything they reveal goes to
[`docs/engineering/findings.md`](../engineering/findings.md) and
[`docs/runner-capabilities.md`](../runner-capabilities.md), with the version probed.

---

## 27. Dogfood

MVP 2 is not final until both matrices pass against live CLIs.

**Node repository** and **Flutter repository**, each:

| Scenario | What it proves |
|---|---|
| independent tasks | the basic claim |
| fan-out / fan-in | dependent waves observe their dependencies' integrated work |
| RED → GREEN | §13 holds end to end: the RED task completes, final verification is green |
| conflict | halt, `review_required`, recorded paths, and a retry that resolves it |
| retry | a new attempt on a new worktree over the current integration head |
| kill the coordinator | recovery from a real crash, not a simulated one |

Measured and recorded for both stacks:

```text
worktree setup time (git worktree add)
install time per worktree
parallel wall-clock gain vs sequential, at N = 2 and N = 4
peak disk usage
quota pressure / rate-limit events observed
```

**If parallelism does not reduce wall-clock time on a given project, that goes in the
documentation as a result.** The Flutter case is the one to watch: `flutter pub get`
per worktree plus a heavy analyzer may consume the entire gain. Isolation is still
worth having (§1) and the honest statement of when it does not pay is worth more than
a benchmark chosen to look good.

---

## 28. Work items

Each item states: **Goal · Dependencies · Production files · Tests · Acceptance ·
Failure semantics · Security · Risk.**

---

### M2-01 — Pure worktree policies and naming · STATUS: IMPLEMENTED

**Goal.** Every naming and layout decision in this document, as pure functions, with
no filesystem and no Git.

**Dependencies.** None.

**Production files.** `src/core/worktree-policy.ts` (new);
`src/core/concurrency.ts` (extended with `IsolationMode`);
`src/contracts/state.schema.ts` (`gitRunKey`, `planningBase`, `isolationMode`,
`integrationHead`, all optional); `src/contracts/attempt.schema.ts` (new).

**Tests.** §26.2, in full. Architecture: `src/core` still imports no Node built-in and
names no provider.

**Acceptance.** `repoKey` and `gitRunKey` derivation, ref naming, workspace-relative
paths, task-id validation and the concurrency resolver are all decided in `core`, all
pure, all tested against injection and traversal payloads.
`resolveTaskConcurrency(4, 'none').effective === 1` still holds. `DEGRADATION_KINDS`
is unchanged (§25.1). The four new state fields parse as optional, and a state file
written before MVP 2 — none of them present — still loads (§25.2).

> **There is no mode-resolution function in `core`, and that absence is the item.**
> An earlier draft put a `(recorded, resolved) → decision` reconciler here, which
> presupposed a design where two answers exist and have to be compared. §6.1 leaves
> one answer, captured at creation, so there is nothing to reconcile and no pure
> function to write. If one appears in a pull request, §30.1 is the answer.

**Failure semantics.** Pure functions refuse by returning a typed refusal, never by
throwing for expected input.

**Security.** S-1, S-2 are closed here for the *policy* half; the adapters re-validate
(§22).

**Risk.** Low, with two traps of the same shape. The first is putting an I/O probe
into `core` to answer a precondition — the existing comment in `concurrency.ts`
explains why that must not happen, and an architecture test enforces it. The second is
letting `isolationMode` become a value `core` computes rather than one it is handed;
see the note above.

---

### M2-02 — `GitCommand` and `GitWorkspaces` · STATUS: IMPLEMENTED

**Goal.** One hook-isolated Git spawner, and every Git operation this milestone needs
behind it. Real Git from the first commit — no mocks in the adapter's own tests.

**Dependencies.** M2-01.

**Production files.** `src/adapters/git/git-command.ts` (new);
`src/adapters/git/git-workspaces.ts` (new);
`src/adapters/git/git-client.ts` (routed through the wrapper);
`src/app/discovery-cache.ts` (**must stop spawning `git` directly** — §26.1 rule 1).

**Tests.** §26.3 in full, plus: every argv built carries `core.hooksPath`; a hook
sentinel never fires internally and does fire for a user merge; the Git version probe.

**Acceptance.** `worktree add/remove/prune/list`, `status --porcelain=v1
--untracked-files=all`, `write-tree`, `commit-tree`, `update-ref`, `merge`,
`merge --abort`, `merge-base --is-ancestor`, `cat-file -e`, `rev-parse ^{tree}`,
`for-each-ref` all work against real repositories, all hook-isolated, all with argv
built from validated components. The Git version floor is determined and pinned.

**Failure semantics.** Every operation returns a typed result. A non-zero exit is
never silently swallowed, and never retried automatically.

**Security.** S-8, S-12. No shell anywhere; V-01 unchanged.

**Risk.** Medium. Platform differences in `worktree` behaviour and in how hooks are
resolved are exactly the class of thing that only real-Git tests catch — which is why
they are mandatory here and not deferred to M2-12.

**What landed, and the three things probing changed.** `GitCommand` takes a subcommand
from a closed list and puts every caller argument *after* it, because Git reads
configuration only before the subcommand and the last `-c core.hooksPath` on a command
line wins — so prefixing a safe value while accepting arbitrary argv would have been no
defence at all. `refsUnder` takes a namespace **prefix** rather than a `…/*` glob,
because `*` matches one path component: the obvious spelling returned `…/integration`
and silently omitted every attempt ref, which would have made the §5.3 case C collision
check report an empty namespace that was not empty. And `objectExists` asks
`cat-file -e <oid>` with no peel suffix, because `<oid>^{commit}` exits 128 for a
missing object where the bare form exits 1 — with the suffix, "absent" and "this
repository is broken" are the same answer, which §32 forbids. The Git floor is
**2.33.0** (§23). `Host` gained `homeDir` so `~/.agent-flow` is resolved through a port
rather than from `process.env.HOME` (§7.1), which is also what lets the real-Git tests
run against a temporary home.

---

### M2-03 — Run identity capture and `planningBase` gates · STATUS: IMPLEMENTED

**Goal.** A run is **born** with its Git identity, its base and its isolation mode,
all three immutable; and the preconditions for executing in that mode are a check that
changes nothing.

**Dependencies.** M2-01, M2-02.

**Production files.** `src/app/run-git-identity.ts` (new — **the only reader of
`git.useWorktrees`**, at `createRun` only);
`src/app/state-store.ts` (`createRun` accepts opaque identity fields — **still no
Git** — and `updateRun` rejects a patch touching any of them);
`src/app/run-actions.ts` (preconditions at approve and start, keyed on
`state.isolationMode`);
`src/app/planning-pipeline.ts` (gate between stages, same key);
`src/cli/status.ts`, `src/cli/run.ts` (the mode-vs-config line, §21.4).

**Tests.** Unit: §26.2, every code and its ordering, plus the four immutability cases.
Integration, against a real repository:

- HEAD moved between planning and approve → `planning_base_moved`; dirty tree →
  `working_tree_dirty`; a foreign attempt ref in the namespace → §5.3 case C,
  `git_run_key_collision`
- **the §6.2 sequence, as a regression test**: create with `useWorktrees: false` on a
  dirty tree, plan, stash, flip the flag to `true`, start — the run executes
  sequentially and **no integration branch is created**
- a `worktree` run restarted with `useWorktrees: false` still executes in worktree
  mode, and its integration branch is intact
- a `working_tree_dirty` refusal, then a clean tree, then a successful start — same
  mode, same `planningBase`, same `gitRunKey`
- a legacy run resumes with `useWorktrees: true`, is never evaluated for preconditions
  and gains no fields
- creating a run with `useWorktrees: true` in a repository with no commits is refused
  **at creation**, before discovery spends anything — and creating one with
  `useWorktrees: false` **in a directory that is not a Git repository succeeds**, as
  it always has (§25)
- **the initialisation crash window, against real Git**: create the integration
  branch, kill the process before the state write, resume — the run adopts its own
  branch (§5.3 case B, §17.3 window 0) and does not refuse itself

Architecture: `StateStore` names no Git; §26.1 rules 13 and the tightened
`useWorktrees` allowlist.

**Acceptance.** New runs carry `gitRunKey`, `planningBase` and `isolationMode`,
written together and never rewritten. Preconditions are evaluated only for a
`worktree` run, return one of the codes in §6.3, and **write nothing**. No refusal is
forcible. `parallelism_clamped` is a function of `(isolationMode, maxTasks)` alone. A
sequential or legacy run reaches no Git code path at all. In sequential mode the
planning gates are observational and never refuse (§6.2, the stated deviation).

**Failure semantics.** `ActionError` with the precondition code, an action line the
user can act on, and a `worktree_mode_refused` event. The run is unchanged and the
next attempt is free.

**Security.** S-2, S-13.

**Risk.** Medium — this is where the deviation in §6.2 lives, and getting the scope
of the gates wrong breaks existing users' sequential runs. Two tests matter most: the
one asserting a dirty tree does **not** refuse a `none` run, and the §6.2 sequence
above, which is the defect this item exists to make impossible rather than to detect.

---

### M2-04 — Workspace lifecycle and setup cleanliness · STATUS: IMPLEMENTED

**Goal.** An attempt gets a prepared, verified-clean worktree, or it does not run.

**Dependencies.** M2-02, M2-03.

**Production files.** `src/app/task-workspaces.ts` (new);
`src/app/task-executor.ts` (accepts a `TaskWorkspace`; agent cwd, validation cwd and
`AGENTS.md` all move to it); `src/app/scheduler.ts` (obtains a workspace per dispatch);
`src/cli/doctor.ts` (install-cleanliness probe, §8.4);
`src/config/stack-detection.ts` (lockfile-respecting install for **new** projects only).

**Tests.** Integration: a fresh worktree is clean; an install that rewrites a tracked
file refuses with `phase: "setup"` and does not invoke the agent; a checkout made
dirty by `.gitattributes` refuses with `phase: "checkout"`; sequential mode is
byte-for-byte unchanged.

**Acceptance.** The §8.1 sequence holds. The agent is not invoked on a failed
preparation. The worktree is retained and locked. `doctor` warns about `npm install`
before a run rather than after.

**Failure semantics.** `task_workspace_preparation_failed`, task `failed`, attempt
spent, worktree retained.

**Security.** S-3, S-4, S-11.

**Risk.** **High — this is the item most likely to make the milestone look broken to
real users**, because the default Node install command trips the gate (§8.4). The
`doctor` probe is not optional polish; it is what turns a confusing refusal into an
actionable one.

---

### M2-05 — `TaskAttemptResult`, trusted receipt, marker · STATUS: IMPLEMENTED

**Goal.** A satisfied attempt produces evidence that recovery can trust and a marker
bound to it.

**Dependencies.** M2-04.

**Production files.** `src/app/attempt-receipt.ts` (new);
`src/app/task-executor.ts` (writes the attempt artifact instead of a `TaskResult` in
worktree mode); `src/app/paths.ts` (`taskAttempt(taskId, n)`, attempt-scoped log names).

**Tests.** §26.2 receipt cases; §26.3 marker cases including determinism and the
empty-tree marker; a second write to an existing `attempt-<n>.json` is refused.

**Acceptance.** The §11.2 ordering holds — the nonce does not exist before the agent
exits. The marker is `commit-tree <validatedTree> -p <base>`, never `git commit`,
never `--allow-empty`. Re-running `commit-tree` from the artifact yields the same SHA.
`TaskResultSchema` is not reused, and the artifact has no `status` field.

**Failure semantics.** Unsatisfied validation → no receipt, no marker; the task's
outcome is decided by `judgeValidation` as it is today.

**Security.** S-9, S-10 — with the residual risk of §11.3 written into
`docs/security.md` in this item, not later.

**Risk.** High. This is the trust root. A mistake here is not a bug, it is a
guarantee that was never true.

---

### M2-06 — Deterministic Integrator and integration-tree verification · STATUS: IMPLEMENTED

**Goal.** Serial, ordered, mechanically verified integration — the only place a task
becomes `completed` — and the integration worktree as the single tree that final
verification and final review both observe.

**Dependencies.** M2-05.

**Production files.** `src/app/integrator.ts` (new);
`src/app/scheduler.ts` (integration phase after the wave barrier);
`src/contracts/result.schema.ts` (`integration` block);
`src/contracts/state.schema.ts` (`integrationHead` advanced in the same write as
`completed`, §14.3 step 7);
`src/app/run-actions.ts` (**a `review` use case under `withExecutionLock`** — §18.2);
`src/cli/review.ts` (**§19**: becomes an adapter over that use case; `runVerification`
and the `GitClient` both move to the integration worktree; the reviewer's changed-file
list becomes `planningBase..integration` rather than `git status`);
`src/adapters/git/git-client.ts` (a diff-against-a-base mode).

**Tests.** §26.4 in full. Integration: a forged marker is refused; a merge conflict
halts with recorded paths; the merge commit's parent count is the discriminator; the
verification result, the reviewer's file list and the DoD all name the same commit,
and that commit is `state.integrationHead`; **a `review` issued while the run holds
its lease gets `run_busy` rather than reading a half-merged integration worktree**;
`integrationHead` and `completed` land in one write, proved by killing the process
between the merge and the write and asserting §17.3 window 7 reconciles both.
Architecture: rules 6, 11 and 12 of §26.1.

**Acceptance.** Integration order is topological. No validation command runs during
integration. `TaskResult.integration` is present on every completed task. Ancestry is
checked before merging. **Final verification and final review run in the integration
worktree, against one commit, under the run execution lock, and that commit is
recorded on the run (§19.2, §18.2).** In sequential mode both continue to run in the
project directory, unchanged and unlocked.

**Failure semantics.** Conflict → `merge --abort`, task `review_required`, run halted.
Tree or nonce mismatch → `attempt_marker_mismatch`, halted, never repaired. An
integration worktree that cannot be produced → `integration_worktree_unavailable`.

**Security.** S-9.

**Risk.** High. Two distinct failure modes: a dependent task starting against a branch
that does not contain its dependency — silent, and only visible three tasks later —
and a "verified tree A, reviewed tree B" split, which would make a green run mean
nothing.

---

### M2-07 — Crash recovery · STATUS: NEXT

**Goal.** Every window in §17.3 has a defined, tested resolution.

**Dependencies.** M2-06.

**Production files.** `src/app/worktree-recovery.ts` (new);
`src/app/scheduler.ts` (recovery extended from `recoverInterrupted`).

**Tests.** §26.5 — one per window, driven by a deterministic injected fault, against
real Git.

**Acceptance.** Receipt-first in every path. No path infers evidence from a
repository's shape. A pruned validated tree requeues rather than fabricates. Running
recovery twice changes nothing the first run did not already do.

**Failure semantics.** Anything unresolvable halts with a named code; nothing is
repaired by guessing.

**Security.** S-9, S-10.

**Risk.** High, and specifically **hard to test well** — a recovery test that passes
because the fault did not land where it claimed is a green test proving nothing. The
fault hook must be deterministic, not timing-based.

---

### M2-08 — Retry semantics and attempt retention · STATUS: NOT STARTED

**Goal.** A retry is always a new attempt, a new branch and a new worktree, and never
destroys prior evidence.

**Dependencies.** M2-05, M2-06.

**Production files.** `src/app/run-actions.ts` (`retryTask` under worktree mode);
`src/app/task-workspaces.ts`; `src/app/paths.ts` (attempt-scoped logs).

**Tests.** Integration: retry after a conflict succeeds against the moved integration
head; `attempt-1.json` and its branch survive; `retry.maxAttempts` still bounds.

**Acceptance.** I-12 holds. Attempt artifacts and logs are attempt-addressable.

**Failure semantics.** Exhausted attempts leave the task `failed` for a person, as
today. §23 of Spec v3 (no automatic retry) is unchanged.

**Security.** S-1.

**Risk.** Low.

---

### M2-09 — Git-aware cleanup · STATUS: NOT STARTED

**Goal.** `agent-flow clean` reclaims namespaces safely and touches nothing foreign.

**Dependencies.** M2-02, M2-03.

**Production files.** `src/cli/clean.ts`; `src/adapters/git/git-workspaces.ts`.

**Tests.** §26.3 cleanup cases: a foreign worktree and a foreign branch survive; a
removed run leaves no worktree and no attempt ref; **an unmerged integration branch
survives its run's removal and is reported**; the same branch, once merged into a user
ref, is deleted; `--branches` deletes it regardless; a run whose namespace cannot be
reclaimed keeps its state and exits non-zero; the active run and a locked run are
refused.

**Acceptance.** §20 in full, including the ordering rule (Git before state) and §20.4
(attempt refs are diagnostic and go; the integration branch is product and stays until
it is redundant or explicitly asked for).

**Failure semantics.** Partial failure is reported per run and exits non-zero. A
retained integration branch is **not** a partial failure and does not affect the exit
code. Never `rm -rf` on a registered worktree.

**Security.** S-5, S-4.

**Risk.** Medium. This is the item that deletes things, and the blast radius of a
path bug is the user's other worktrees. The second, quieter blast radius is §20.4: the
run's own product, deleted by a housekeeping command weeks after anyone was watching.

---

### M2-10 — Read models, CLI and Web observability · STATUS: NOT STARTED

**Goal.** A person can see what parallel execution is doing without reading a log,
and no filesystem path or ref reaches the browser.

**Dependencies.** M2-03 … M2-08.

**Production files.** `src/server/run-reader.ts`; `src/server/config-reader.ts`;
`src/contracts/api.schema.ts`; `src/cli/status.ts`; `src/cli/run.ts`;
`apps/web/src/**` (render only).

**Tests.** Architecture rules 4 and 7 of §26.1. Web unit tests for the new states.
E2E: a run in worktree mode renders attempt numbers, awaiting-integration and a
conflict.

**Acceptance.** §21.2 facts are exposed; §21.3 exposes nothing. No merge or scheduling
logic in React. `run --dry-run` explains a refusal.

**Failure semantics.** A read model that cannot resolve a fact omits it rather than
inventing it.

**Security.** S-6, S-7.

**Risk.** Low, with one trap: the temptation to show the worktree path "just for
debugging". §7.2 makes it structurally unavailable, which is the reason the artifact
stores a relative path.

---

### M2-11 — Parallel scheduler activation · STATUS: NOT STARTED

**Goal.** `effectiveConcurrency > 1`. **This is the last functional item, and it is
one edit plus its wiring.**

**Dependencies.** M2-01 … M2-08, and M2-10 for the observability that makes a
parallel run debuggable.

**Production files.** `src/app/execution-context.ts` (passes `state.isolationMode`
into `resolveTaskConcurrency` — **read from the run, never re-derived from config**);
`src/app/run-actions.ts` (records the decision).

**Tests.** §26.4 in full, at N=2 and N=4, against real Git. A `none` run resolves to 1
whatever the current configuration says. `parallelism_clamped` is recorded when and
only when the numbers differ.

**Acceptance.** A run **created** with `useWorktrees: true`, whose preconditions hold,
with `maxTasks: 4`, executes four independent tasks concurrently in four worktrees,
integrates them in topological order, and leaves the user's working tree unchanged.
A run created sequential resolves to 1 however the configuration reads at the moment
it executes (I-11, I-13).

**Failure semantics.** An unmet precondition → sequential is not silently substituted;
the run is refused with the code and executes nothing (§6.4).

**Security.** —

**Risk.** Medium, and it is the risk of **landing this item too early**. Every
guarantee above is what makes this edit safe; done before them it is the M2-00 defect
with extra steps.

---

### M2-12 — E2E, dogfood and documentation · STATUS: NOT STARTED

**Goal.** The milestone is proved outside the unit suite and written down.

**Dependencies.** M2-11.

**Production files.** `apps/web/e2e/**`; `README.md` + `README.pt-BR.md` (Status,
Known limitations, Next); `docs/security.md` (§11.3 residual risk, the hook policy);
`docs/testing.md` (the new layers); `docs/troubleshooting.md` (every refusal code and
its fix); `docs/engineering/findings.md` (what dogfood revealed).

**Tests.** §26.6 E2E; §27 dogfood on both stacks; full CI green.

**Acceptance.** §32 in full.

**Failure semantics.** A dogfood result that contradicts this specification changes
the specification. It is not written off as an environment problem.

**Security.** Documentation of stated limits is part of the deliverable, not an
afterthought.

**Risk.** Medium — this is where the Flutter matrix may reveal that the cost model
(§24) does not hold, and the honest outcome is a documented "no speedup here".

---

## 29. Dependency graph and critical path

Edges, as declared by each item:

| Item | Depends on |
|---|---|
| M2-01 policies | — |
| M2-02 Git adapter | M2-01 |
| M2-03 run identity | M2-01, M2-02 |
| M2-04 workspace lifecycle | M2-02, M2-03 |
| M2-05 receipt + marker | M2-04 |
| M2-06 integrator + verification | M2-05 |
| M2-07 crash recovery | M2-06 |
| M2-08 retry | M2-05, M2-06 |
| M2-09 cleanup | M2-02, M2-03 |
| M2-10 read models | M2-03 … M2-08 |
| M2-11 **activation** | M2-01 … M2-08, M2-10 |
| M2-12 E2E + dogfood + docs | M2-11 |

```text
                         ┌─► M2-09 cleanup ──────────────────────────┐
                         │                                           │
M2-01 ─► M2-02 ─► M2-03 ─┴─► M2-04 ─► M2-05 ─► M2-06 ─► M2-07 ───────┤
                                          │        │                 │
                                          └────────┴─► M2-08 ────────┤
                                                                     │
                                                       M2-10 ────────┤
                                                                     ▼
                                                                  M2-11
                                                                     │
                                                                     ▼
                                                                  M2-12
```

**Critical path:**

```text
M2-01 → M2-02 → M2-03 → M2-04 → M2-05 → M2-06 → M2-07 → M2-11 → M2-12
```

**M2-09 (cleanup)** is off the critical path entirely and may be built any time after
M2-03. **M2-10 (read models)** may be built alongside M2-06 … M2-08 but must land
before M2-11 — a parallel run whose state cannot be read is a parallel run nobody can
debug. **M2-08 (retry)** must land before M2-11 as well: retry semantics under fan-out
are part of what makes concurrency safe, not a follow-up to it.

### The first moment `effectiveConcurrency > 1` may be enabled

**M2-11, the eleventh of twelve items.**

Not before, and the preconditions are exact:

```text
state.isolationMode === 'worktree'                    captured at createRun (§6.1)
  AND every precondition of §6.3 holds
  AND M2-02  the hook-isolated Git adapter exists
  AND M2-03  the run was born with its identity, base and mode, and the gates hold
  AND M2-04  every dispatched task gets a prepared, verified-clean worktree
  AND M2-05  a satisfied attempt produces a receipt and a bound marker
  AND M2-06  integration is serial, ordered, and the only writer of `completed`
  AND M2-07  every crash window has a tested resolution
  AND M2-08  a retry is always a new attempt on a new worktree
```

Until all of them, `resolveTaskConcurrency` is called with `isolation: 'none'` and
returns 1 however `parallelism.maxTasks` is written — and the `parallelism_clamped`
degradation keeps saying so on the run.

---

## 30. Explicitly out of scope

### 30.1 Rejected designs

Named because they were considered and decided, not because they were forgotten. If
one of these reappears in a pull request, this section is the answer.

| Rejected | Why |
|---|---|
| `implementationBase` as a second base field | Two answers to "which commit was this planned against". One field, `planningBase` (§6.1). |
| `git.worktreeSetup` as a config key | `project.commands.install` already answers "how do I make this project buildable". Two keys would drift (§8.1). |
| worktrees under `.git/agent-flow/…` | Probed: Codex writes there, **Claude Code refuses**. Runner-dependent behaviour in a runner-agnostic core (§5.1). |
| worktrees anywhere inside the repository | A worktree inside the working tree is content the outer `git status` sees (§5.1). |
| union-of-validation-ids gate at integration | Contradicts `validationExpectation: 'fail'` and re-judges an expectation that was already judged (§13.2, I-4). |
| any integration validation gate | Integration verifies mechanical Git integrity. Final verification is the authority (§13.3). |
| `redTasksIntegrated` as a closable ledger | No closing mechanism, no causal map, and it invites being read as a gate. Deferred (§13.5). |
| trusting marker trailers alone | Trailers are text an agent can write. The tree binding and the nonce are required (§17.1, I-5, I-6). |
| `--no-verify` as the hook mechanism | Does not cover `post-checkout`, `reference-transaction`, or every merge path. `core.hooksPath` does (§12.3). |
| `git commit` / `--allow-empty` for markers | `git commit` reads an index and runs hooks; `commit-tree` needs no emptiness flag (§12.1). |
| rolling dispatch instead of waves | Lets a later task start against a head an unintegrated sibling is about to move (§4.3). Deferred, not forbidden. |
| regenerating `gitRunKey` on collision | A 64-bit collision is evidence of broken state, not a random event (§5.2). |
| back-filling `planningBase` on old runs | Inventing the evidence the field exists to provide (§25.2). |
| a `gitNamespace` field recording that the namespace was created | The branch name is derivable from `gitRunKey`, so it would be a second copy of one fact; and because the branch and the state write are not atomic, the field is absent exactly when the branch exists — a resume would refuse the run's own branch as a collision. `integrationHead` is the durable evidence instead (§5.3). |
| choosing the isolation mode at the first successful execution | Planning runs under one answer and implementation under another. The exact sequence — plan on a dirty tree with worktrees off, stash, turn them on, start — passes every individual check and builds against a tree the plan was never written against (§6.2). Captured at `createRun` instead (§6.1, I-13). |
| letting a `useWorktrees` change reach an existing run, in either direction | Off would leave the integrated half on a branch nobody merges; on would cut an integration branch from a base the sequential half is missing. The flag is a default for the next run, not a switch (§6.4, §25.1). |
| an `isolation_mode_changed` refusal | A code to report a conflict that capturing at creation does not create. Reporting it would mean the design still allowed it (§6.4). |
| refusing a pre-MVP-2 run because it has no `planningBase` | A permanent lockout with no action its owner could take. Legacy runs execute as they always did, and are never promoted (§25.2). |
| cleaning attempt refs and the integration branch by the same rule | One is diagnostic, the other is the product §19.3 told the user to merge (§20.4). |

### 30.2 Not in this milestone

```text
automatic conflict resolution          model escalation after failure
cloud / remote workers                 distributed scheduler
GitHub PR automation                   Linear · Symphony
monorepo-aware scheduler               cross-machine execution
remote auth                            automatic config writes
npm publishing                         per-wave verification as a gate
```

**`pause`** stays deferred: [`docs/pause-resume-cancel-design.md`](../pause-resume-cancel-design.md)
is unchanged and unimplemented.

**`cancel`** was examined against this milestone's safety requirements and is **not
required by it**. The reasoning: a killed coordinator is already a first-class case
(§17), so the failure mode `cancel` would introduce — a half-integrated run — is one
recovery already handles. Adding a new terminal run status and an abort signal is a
contract change that would compete for attention with the trust root (M2-05) and the
recovery matrix (M2-07). **Deferred.**

---

## 31. Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R-1 | **The default `npm install` trips the cleanliness gate** and worktree mode looks broken on first contact | high, immediate, affects most Node users | `doctor` probe before the run; documented fix; new-project default changed (§8.4, M2-04) |
| R-2 | The receipt is not unforgeable against an escaped agent | medium; it is a *stated* limit, not a hidden one | §11.3 written into `docs/security.md`; defence in depth; containment remains the runner's job (AD-14) |
| R-3 | A crash window is handled incorrectly and an integration branch is corrupted | high | §17 enumerates every window; each has a test against real Git with a deterministic fault (§26.5) |
| R-4 | Disk exhaustion at N=4 on a large repository | medium | §24 bounds; `doctor` projection; `MAX_ISOLATED_TASK_CONCURRENCY` |
| R-5 | Parallelism produces no wall-clock gain on some stacks | low technically, high for expectations | §27 measures it; a negative result is documented, not buried; §1 states isolation's independent value |
| R-6 | Windows worktree mode is unvalidated (no CI, path length, process trees) | medium for Windows users | `worktree_path_too_long` refusal; `doctor` says unvalidated; README limitation |
| R-7 | The exact Git version floor is asserted rather than probed | medium | **Explicitly left open**: M2-02 determines it empirically and pins it (§23) |
| R-8 | Conflicts are frequent enough to make parallelism unpleasant | medium | Halt-and-report is the correct response; the plan reviewer's independence analysis is the upstream fix; §27 measures how often it happens |
| R-9 | M2-11 lands early "to see it work" | critical | §29 states the preconditions; the architecture test on the ceiling fails if the resolver is bypassed |
| R-10 | Agents' own commits confuse users reading the integration branch | low | §12.5 states the model; the marker message says so in prose |
| R-11 | A `useWorktrees` edit lands between two phases of one run — planning under one answer, implementation under another — and the work is built against a tree nobody planned against | **critical, and silent**: every individual check passes and the run finishes wrong | The mode is captured at `createRun` and immutable; `git.useWorktrees` is read in one module at one moment, pinned by an architecture test (I-13, §6.1, §26.1) |
| R-12 | `agent-flow clean` deletes the integration branch of an old run — the product the CLI told the user to merge | high, and it happens weeks later with nobody watching | Attempt refs and the integration branch are cleaned by different rules; an unmerged branch is kept and reported; `--branches` is the explicit opt-in (§20.4) |

---

## 32. Acceptance gate

MVP 2 is **PASS** only when all of the following are demonstrated:

```text
[ ] parallelism > 1 actually executes concurrently, proved at N = 2 and N = 4
[ ] no shared worktree writes — every attempt has its own locked worktree
[ ] no StateStore lost updates under N concurrent workers
[ ] deterministic integration order — same plan, same agent output, same branch shape
[ ] receipt-based recovery — every window of §17.3 tested against real Git
[ ] no task reaches `completed` before its marker is on the integration branch
[ ] final verification runs on the integration tree, and review reads the same tree
[ ] the user's working tree is byte-identical before and after a parallel run
[ ] no browser-controlled Git path, ref, branch or command — requests and responses
[ ] no Git hook executes inside any internal Agent Flow operation
[ ] a run's isolation mode is captured at creation and no later config edit,
    execution or refusal changes it — proved in both directions and for legacy runs
[ ] cleanup leaves no worktree and no attempt ref behind, touches nothing foreign,
    and never deletes an integration branch that is merged nowhere
[ ] final review cannot observe the integration worktree while a merge is in it
[ ] all CI jobs green
[ ] real Node dogfood: the full §27 matrix
[ ] real Flutter dogfood: the full §27 matrix
```

Any single line unmet is **FAIL**. There is no partial pass, because every line above
is something a user would otherwise discover by having it go wrong.

---

## Appendix A — Refusal codes

**Every code here stops a run; none of them changes what the run is** (§6.4). Two
former entries are gone rather than renamed: `worktrees_disabled` is now the value
`isolationMode: 'none'` captured at creation, and `planning_base_missing` is the
legacy shape of §25.2 — neither is a runtime decision, so neither is a refusal.

Codes marked **creation** are also evaluated by `createRun` for a run being born
`worktree` (§6.1), where refusing costs nothing.

| Code | Raised by | Forcible |
|---|---|---|
| `not_a_git_repository` | preconditions, **creation** | no |
| `repository_is_bare` | preconditions, **creation** | no |
| `repository_has_no_commits` | preconditions, **creation** | no |
| `repository_has_submodules` | preconditions, **creation** | no |
| `repository_root_unresolvable` | preconditions, **creation** | no |
| `git_version_unsupported` | preconditions, **creation**, `doctor` | no |
| `worktree_path_too_long` | preconditions, **creation** | no |
| `git_identity_missing` | preconditions | no |
| `agent_flow_state_not_ignored` | preconditions | no |
| `working_tree_dirty` | preconditions, planning gates | **no** |
| `planning_base_moved` | preconditions, planning gates | **no** |
| `git_run_key_collision` | `GitWorkspaces`, §5.3 case C only | no |
| `namespace_missing` | `GitWorkspaces`, §5.3 case D | no |
| `integration_head_diverged` | `GitWorkspaces`, §5.3 case D | no |
| `task_workspace_preparation_failed` | `TaskWorkspaces` | no |
| `attempt_evidence_missing` | Integrator | no |
| `attempt_evidence_unsatisfied` | Integrator | no |
| `attempt_marker_missing` | Integrator | no |
| `attempt_marker_mismatch` | Integrator, recovery | no |
| `attempt_tree_missing` | recovery | no — requeues |
| `integration_conflict` | Integrator | no |
| `integration_history_unrecognised` | Integrator | no |
| `integration_head_missing` | Integrator | no |
| `integration_worktree_unavailable` | Integrator, recovery | no |
| `integration_unreadable` | Integrator | no |

**This table is the canonical vocabulary, and it is pinned by a test rather than by
good intentions.** `test/app/integration-vocabulary.test.ts` parses this appendix and
asserts it agrees, in both directions, with `INTEGRATION_REFUSAL_CODES` in
`src/app/integrator.ts`: a code the Integrator can emit and this table does not list
fails the suite, and so does a row here attributed to the Integrator that the module
cannot raise. A vocabulary that drifts is worse than one that is incomplete, because a
reader who finds nine of ten codes documented reasonably concludes the tenth does not
exist.

`integration_unreadable` was the code that made the pin necessary: it reaches a person
in a refusal, it halts the run, and it was absent here — which by this appendix's own
opening sentence made the appendix wrong rather than merely terse. It is raised when Git
could not *answer* a question the sequence depends on (the branch head, a commit object)
as distinct from answering it with something unacceptable. The distinction matters
because the fixes differ: every other code here describes a repository state, and this
one describes a repository that could not be read at all.

**The four evidence and history codes are deliberately not folded into
`attempt_marker_mismatch`**, and the distinction is what a person needs rather than a
taxonomy for its own sake. `attempt_marker_mismatch` means *the marker exists and does
not bind to the evidence* — a forgery, or corruption, and I-6 forbids repairing it.
The others each name a different fact about the world:

| Code | What is actually wrong |
|---|---|
| `attempt_evidence_missing` | The attempt left no `attempt-<n>.json` that parses. There is nothing to bind a marker to, so no marker was consulted. |
| `attempt_evidence_unsatisfied` | The artifact parses and records `unsatisfied` or `not_reached`. Only a satisfied attempt is integrated (§14.3 step 2), and by the `.refine` of §10.2 it carries no receipt. |
| `attempt_marker_missing` | The evidence is sound and the attempt branch does not resolve to a commit. The marker was never published, or the ref was deleted. |
| `integration_history_unrecognised` | The marker is already an ancestor of the integration branch and **no merge commit on that branch introduced it** — so §14.3 step 5's reconciliation has no merge to name (§14.7). |

Reporting all four as `attempt_marker_mismatch` would tell somebody their marker was
forged when the truth is that a file is missing, a validation did not pass, a ref was
deleted, or a branch was rebuilt. Those have four different fixes.

`integration_head_missing` is the same rule applied to §19: a run asked to be reviewed
before its integration branch was ever initialised has no commit for verification, the
reviewer and the Definition of Done to describe (§19.2), and falling back to the user's
working tree would review something else entirely.

## Appendix B — New events

None of these carries an absolute filesystem path (§7.2, §21.3).

```text
run_git_identity_assigned      { gitRunKey, planningBase, isolationMode }  at createRun
planning_base_observation      { clean, head, planningBase, matches }   sequential mode
worktree_mode_refused          { code, detail }                         a precondition
integration_branch_created     { branch, base, adopted }               §5.3 case A or B
task_workspace_created         { task, attempt, branch, base }
task_workspace_preparation_failed { task, attempt, phase, changes }
task_attempt_validated         { task, attempt, judgement, validationIds }
task_attempt_marker_created    { task, attempt, marker, tree }
task_integrated                { task, attempt, marker, mergeCommit }
integration_conflict           { task, attempt, paths, previouslyIntegrated? }
integration_recovered          { task, attempt, window }
namespace_reclaimed            { gitRunKey, worktrees, attemptRefs, integrationBranchKept }
```

---

## Related documents

- [`implementation-spec-v3.md`](implementation-spec-v3.md) — the historical
  specification. §19 and §47–§48 are superseded by this document.
- [`../security.md`](../security.md) — the local server's boundary. §11.3 and §12.3
  extend it when this milestone lands.
- [`../testing.md`](../testing.md) — the existing test layers.
- [`../engineering/findings.md`](../engineering/findings.md) — what building this
  taught us, including the `.git`-write probe behind §5.1.
- [`../runner-capabilities.md`](../runner-capabilities.md) — what each CLI does, with
  the command that proves it.
- [`../pause-resume-cancel-design.md`](../pause-resume-cancel-design.md) — designed,
  not built; unchanged by this milestone.
- [`../troubleshooting.md`](../troubleshooting.md) — gains every refusal code in
  Appendix A.
