# MVP 2 — Safe Parallel Execution

## 0. Status and scope

**Status: specification. Nothing in this document is implemented.**

Baseline commit: `e24dd48` (`fix: harden task concurrency before worktree isolation`).
At that commit `MAX_SUPPORTED_TASK_CONCURRENCY = 1`, no production path creates a
worktree, and an architecture test fails if one appears.

This document is the implementable contract for the next milestone. It supersedes
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
| `src/app/run-git-identity.ts` | app | Captures `gitRunKey` and `planningBase`; evaluates admissibility. |
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
the execution context is assembled. Reading the project overlay from the worktree
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

**The probe — "is this run admissible for worktree mode?" — lives in `src/app/`
(§6.3), never in core.** Core answers a policy question about a declared mode; the
application answers a factual question about a repository.

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
| application (`run-git-identity.ts`) | Generates the key. Passes it to `StateStore.createRun`. |
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

**Collision check — and it is asked only on first entry.**

The check distinguishes two situations that look identical on disk and mean opposite
things. A namespace that already exists is a *collision* the first time a run enters
worktree mode, and *the run's own namespace* on every resume after that. Getting this
wrong would make every resumed run refuse itself.

The discriminator is the run's own audit trail: `integration_branch_created` is
emitted once, when the namespace is created (Appendix B).

```text
first entry     — no `integration_branch_created` event for this run
    git for-each-ref --format='%(refname)' 'refs/heads/agent-flow/<gitRunKey>/*'
    non-empty, OR the worktree directory <repoKey>/<gitRunKey>/ exists
        → refusal `git_run_key_collision`

resume          — the event exists
    the integration branch MUST be present
        absent → refusal `namespace_missing`, run halted for review
    an existing namespace is expected and is not a collision
```

Agent Flow **MUST NOT** generate a new key to get past a collision: a 64-bit
collision is not a random event, it is evidence that something is wrong with the
state on disk, and papering over it would hide exactly the case the key exists to
detect.

`namespace_missing` is equally not repairable. A missing integration branch means
work that was recorded as integrated is gone from the repository, and re-creating the
branch from `planningBase` would silently discard it.

---

## 6. `planningBase` and repository gates

### 6.1 The field

```ts
// RunStateSchema, additive and optional
planningBase: z.string().regex(/^[0-9a-f]{40}$/).optional(),
gitRunKey:    GitRunKeySchema.optional(),
```

`planningBase` is the commit the repository was on **when the run was created**,
captured by the application layer *before* discovery, architecture analysis or
planning observes the repository.

**There is exactly one base field.** `implementationBase` was considered and is
**rejected** (§30.1): two base fields make "which commit was this plan written
against" a question with two answers, and the whole value of the field is that it has
one. The integration branch is created from `planningBase`, so the tree the plan was
written against is the tree the work is built on.

Both fields are **optional in the schema** so that runs created before MVP 2 still
parse (§25).

### 6.2 The invariants

For a run in worktree mode, at each of these moments the repository MUST satisfy
`clean && HEAD == planningBase`:

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
> **enforced when the run is in worktree mode** and **evaluated but non-blocking when
> `git.useWorktrees` is `false`**. Enforcing them unconditionally would mean that
> after this milestone lands, every existing user who plans a feature on a dirty
> working tree — which sequential mode has always allowed and which is the normal
> way people work — is refused. That is a breaking behaviour change to the mode §25
> promises to keep compatible. In sequential mode the checks still run and their
> result is written to `events.jsonl` as `planning_base_observation`, so the
> information exists without the refusal.

### 6.3 Admissibility

`app/run-git-identity.ts` answers one question: **may this run enter worktree mode?**
The answer is computed once per execution and recorded.

```ts
export type WorktreeAdmissibility =
  | { readonly admissible: true }
  | { readonly admissible: false; readonly code: RefusalCode; readonly detail: string };
```

Checked, in this order, cheapest and most conclusive first:

1. `git.useWorktrees === false` → not admissible (`worktrees_disabled`). Not a
   failure; the run proceeds sequentially.
2. Not a Git repository → `not_a_git_repository`.
3. Bare repository → `repository_is_bare`.
4. No commits (unborn HEAD) → `repository_has_no_commits`.
5. Submodules present → `repository_has_submodules` (§23).
6. Git older than the supported floor → `git_version_unsupported`.
7. Projected worst-case worktree path exceeds the platform limit → `worktree_path_too_long` (§23).
8. `state.planningBase` absent → `planning_base_missing` (a pre-MVP-2 run, §25).
9. `state.gitRunKey` absent or not prefixed by `runId` → `git_identity_missing`.
10. Agent Flow's own run state is not ignored by the repository →
    `agent_flow_state_not_ignored`.
11. Working tree dirty → `working_tree_dirty`.
12. `HEAD !== planningBase` → `planning_base_moved`.
13. Namespace state disagrees with the run's own history (§5.3) →
    `git_run_key_collision` on first entry, `namespace_missing` on resume.

**Check 10 exists because without it the run refuses itself.** `init` appends
`.agent-flow/runs/`, `.agent-flow/cache/` and `.agent-flow/current-run` to
`.gitignore`. If any of them is not ignored — an old project, a hand-edited
`.gitignore`, a `.gitignore` the user reverted — then the run's own state files make
the working tree dirty, and check 11 refuses the run while naming files Agent Flow
itself just wrote. That is a message that teaches the user the tool is broken.
Detected with `git check-ignore -q` on each of the three paths, and refused with a
code whose fix is one line in `.gitignore`.

Checks 11 and 12 apply on **every** entry, including a resume. A user who moved HEAD
or dirtied the tree between two `start` invocations changed the ground the integration
branch was cut from, and the run must stop rather than build on it.

A refusal at 2–13 during `start` is a **refusal to run**, not a silent downgrade. A
run configured for worktrees that cannot have them MUST NOT quietly execute four
tasks against one tree, and MUST NOT quietly execute one either without saying why:
the outcome is `ActionError` with the code above, and the operator decides.

The single exception is (1): `useWorktrees: false` is a configured intent to run
sequentially, and is honoured silently.

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

Every worktree Agent Flow creates is created locked:

```bash
git worktree add --lock --reason "agent-flow <gitRunKey> <taskId> attempt-<n>" <path> <branch>
```

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
git worktree add --lock <path> <branch>   from the wave base
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

created at implementation start:

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

### 14.2 Order

**Integration order is the plan's stable topological order, restricted to the tasks
of the wave that produced a satisfied attempt.** Never completion time.

`topologicalOrder(dag)` in `core/dag.ts` is already Kahn's algorithm over a sorted
frontier and is documented as deterministic; MVP 2 reuses it and adds no ordering
logic of its own (I-2, I-9).

Two runs of the same plan, with the same agent outputs, produce the same integration
branch — the same merge commits in the same order. A design that merged in completion
order would make the resulting tree a function of how fast each CLI happened to
respond that afternoon.

### 14.3 Per task

Serially, holding the in-process integration mutex (§18.2):

1. **Load the attempt artifact.** Absent or unparseable → the task did not produce
   evidence; it is not integrated.
2. **Validate the receipt.** `validationJudgement === 'satisfied'` and `receipt`
   present. The `.refine` guarantees these agree.
3. **Validate the marker.** The attempt branch exists and resolves to a commit; the
   commit's first parent is `attempt.base`; the trailers agree with the artifact.
4. **Validate the tree binding (I-6).**
   `git rev-parse <marker>^{tree}` MUST equal `receipt.validatedTree`. Mismatch →
   refusal, no repair.
5. **Check ancestry first.**
   `git merge-base --is-ancestor <marker> <integration>` — if the marker is already
   an ancestor, the merge already happened (a crash-recovery path, §17.3 window 7);
   skip to 7.
6. **Merge** (§14.5).
7. **On success:** write `TaskResult` with the `integration` block (§10.3), transition
   the task to `completed`, release its dependents, and mark the attempt worktree
   reclaimable.
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

| # | Window | Detection | Resolution |
|---|---|---|---|
| 1 | **Crashed during the agent** | task `running`; no `attempt-<n>.json` | The attempt's work was never observed. Task → `interrupted` → requeued as attempt *n+1* within `maxAttempts`. Old worktree retained. |
| 2 | **Crashed after validation, before the receipt was written** | task `running`; no `attempt-<n>.json` | Indistinguishable from (1), and correctly so: with no artifact there is no evidence, and the milestone does not infer evidence from a worktree's contents. Same resolution as (1). |
| 3 | **Crashed after the receipt, before the marker** | `attempt-<n>.json` with a receipt; branch absent | The tree object still exists (checked). Re-run `commit-tree` → the *same* SHA (§12.2) → `update-ref`. Continue to integration. |
| 4 | **Crashed after `commit-tree`, before `update-ref`** | as (3): the commit object exists, the ref does not | Identical handling. `commit-tree` is idempotent by SHA, so this window does not need to be distinguished from (3) at all. |
| 5 | **Crashed after the marker, before the merge** | receipt + valid marker; marker not an ancestor of integration | Verify tree binding and nonce (§17.1), then merge (§14.3 step 6). |
| 6 | **Crashed during the merge** | the integration worktree has an in-progress merge (`MERGE_HEAD` present, or `git status` reports merging) | `git merge --abort`, then re-attempt from a clean integration worktree. If the abort fails, refuse with `integration_worktree_unavailable` and halt — never force. |
| 7 | **Crashed after the merge, before `StateStore` recorded completion** | `git merge-base --is-ancestor <marker> <integration>` is true; task is not `completed` | The merge happened. Do **not** merge again. Write `TaskResult` with the integration block (reconstructed from the artifact and the merge commit found by walking integration for a merge whose second parent is the marker), transition to `completed`. |
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

---

## 19. Final verification and review

### 19.1 Where

**In the integration worktree, against the final integration branch.** Never in the
user's working tree.

Today `agent-flow review` builds a `GitClient` on `globals.cwd` and runs
`runVerification({ cwd: globals.cwd })`. In worktree mode both MUST become the
integration worktree path.

### 19.2 One tree, verified and reviewed

```text
integration branch (final)
   ├── runVerification        ← lint, typecheck, test, build
   ├── final review agent     ← reads the same tree, cwd = integration worktree
   └── Definition of Done     ← evaluated over the same artifacts
```

**There MUST NOT be a "validated tree A, reviewed tree B" situation.** The
verification result, the reviewer's diff and the DoD evaluation all describe one
commit, and that commit MUST be recorded on the run.

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
    3. delete the run's refs         (refs/heads/agent-flow/<gitRunKey>/*)
    4. remove .agent-flow/runs/<id>
```

If step 1 or 3 fails, step 4 **MUST NOT** run. A run whose namespace could not be
reclaimed keeps its state, and `clean` says so and exits non-zero for that run.

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

### 20.3 Retention

Preserved by default, because they may be the only copy of something useful:

- the integration branch of every retained run — it is the product
- worktrees of tasks that are `failed`, `blocked` or `review_required`
- worktrees of attempts that were never integrated
- every `attempt-<n>.json`, for every attempt, forever within the run's retention

Reclaimable by default:

- worktrees of attempts that were integrated (their tree is on the integration
  branch; the worktree is a duplicate)

New flags:

```text
agent-flow clean --worktrees        also reclaim retained worktrees of retained runs
agent-flow clean --worktrees --dry-run
```

`--worktrees` never touches refs of retained runs. Branches are cheap; a checkout is
not.

**Documented user recovery**, which MUST appear in
[`docs/troubleshooting.md`](../troubleshooting.md):

```bash
agent-flow clean --worktrees --dry-run          # what would be reclaimed
git worktree list                               # what is registered
git worktree remove <path>                      # one, by hand
git branch -D agent-flow/<gitRunKey>/<taskId>/attempt-1
```

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
| isolation mode | `'none' \| 'worktree'` | admissibility (§6.3) |
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

`agent-flow run --dry-run` prints the resolved concurrency, the isolation mode, and,
when worktree mode is not admissible, **the refusal code and what to do about it**.
This is the command that answers "why is this still running one task at a time".

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
| S-13 | a stale namespace being adopted by a new run | disk → Git | 64-bit `gitRunKey`; real collision check; refusal, never regeneration (§5.2) | unit + integration |
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
| Git older than the supported floor | **REFUSE EARLY** | `git_version_unsupported`, probed by `doctor` and re-checked at admissibility. |
| Windows path length | **REFUSE EARLY** | `worktree_path_too_long` when the projected worst case (root + `repoKey` + `gitRunKey` + `taskId` + `attempt-<n>` + the repository's own deepest tracked path) exceeds the platform limit and long paths are not enabled. A dedicated worktree-root setting is **DEFERRED**; the documented workaround is a shorter home path or enabling long paths. |
| `core.autocrlf` / `.gitattributes` making a fresh checkout dirty | **HANDLED** | Caught by the pre-setup cleanliness assertion, reported with `phase: "checkout"` (§8.3) — which is why that assertion exists separately from the post-setup one. |
| Windows generally | **UNVALIDATED** | No CI job runs there and the process timeout still cannot signal a process tree. `doctor` MUST say worktree mode is unvalidated on Windows. |

**On the Git version floor:** the operations this milestone needs are
`worktree add --lock --reason`, `worktree remove`, `worktree prune`,
`rev-parse --path-format=absolute`, `commit-tree`, `update-ref`,
`merge --no-ff --no-edit`, `merge --abort`, `merge-base --is-ancestor`, `cat-file -e`,
`for-each-ref` and `status --porcelain=v1 --untracked-files=all`. **The exact minimum
version MUST be determined empirically in M2-02 and pinned in `doctor` and in the
README.** A version asserted here from memory would be a claim nobody probed, and
this project's own Findings document exists because of exactly that kind of claim.

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

Runs execute sequentially, in the user's working tree, exactly as at `e24dd48`.
`parallelism.maxTasks` above 1 continues to be accepted, clamped to 1 at runtime, and
recorded as the `parallelism_clamped` degradation.

**No new degradation kind is added.** A run refused worktree mode gets the existing
`parallelism_clamped` degradation with a reason naming the admissibility code, which
keeps the contract change to `DEGRADATION_KINDS` at zero.

### 25.2 Runs created before MVP 2

They have no `gitRunKey` and no `planningBase`, because both fields are optional
additions to `RunStateSchema`. Therefore:

- They **MUST** continue to parse, load, display and resume.
- They **MUST NOT** enter worktree mode. Admissibility refuses with
  `planning_base_missing`.
- Agent Flow **MUST NOT** back-fill either field. There is no honest value for
  `planningBase` on a run whose planning already happened — the current HEAD is not
  it, and writing it anyway would be inventing the evidence the field exists to
  provide (I-5).

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
| *"reads `git.useWorktrees` nowhere that could grant isolation"* | allowlist grows by the admissibility module and `src/app/execution-context.ts`; the rule stays — it is now the list of everywhere the flag is load-bearing |
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

### 26.2 Unit tests (pure, no filesystem)

- `repoKey`: stability, distinctness, slug sanitisation, length bound, empty basename
- `gitRunKey`: generation shape, validation, `runId` prefix invariant, rejection of
  injection payloads
- branch naming and workspace-relative paths, for every legal and illegal `taskId`
- admissibility: each refusal code, and their evaluation order
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
- `clean` leaves no worktree and no ref in the namespace of a removed run
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

### M2-01 — Pure worktree policies and naming

**Goal.** Every naming and layout decision in this document, as pure functions, with
no filesystem and no Git.

**Dependencies.** None.

**Production files.** `src/core/worktree-policy.ts` (new);
`src/core/concurrency.ts` (extended with `IsolationMode`);
`src/contracts/state.schema.ts` (`gitRunKey`, `planningBase`, both optional);
`src/contracts/attempt.schema.ts` (new).

**Tests.** §26.2, in full. Architecture: `src/core` still imports no Node built-in
and names no provider.

**Acceptance.** `repoKey` and `gitRunKey` derivation, ref naming, workspace-relative
paths, task-id validation and the concurrency resolver are all decided in `core`, all
pure, all tested against injection and traversal payloads. `resolveTaskConcurrency(4,
'none').effective === 1` still holds.

**Failure semantics.** Pure functions refuse by returning a typed refusal, never by
throwing for expected input.

**Security.** S-1, S-2 are closed here for the *policy* half; the adapters re-validate
(§22).

**Risk.** Low. The only trap is putting an I/O probe into `core` to answer
admissibility — the existing comment in `concurrency.ts` explains why that must not
happen, and an architecture test enforces it.

---

### M2-02 — `GitCommand` and `GitWorkspaces`

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

---

### M2-03 — Run Git identity and `planningBase` gates

**Goal.** A run is born with a Git identity and a base, and admissibility for
worktree mode is a computed, recorded answer.

**Dependencies.** M2-01, M2-02.

**Production files.** `src/app/run-git-identity.ts` (new);
`src/app/state-store.ts` (`createRun` accepts opaque identity fields — **still no Git**);
`src/app/run-actions.ts` (gates at approve and start);
`src/app/planning-pipeline.ts` (gate between stages).

**Tests.** Unit: every refusal code and its ordering. Integration: real repository,
HEAD moved between planning and approve → `planning_base_moved`; dirty tree →
`working_tree_dirty`; namespace present → `git_run_key_collision`. Architecture:
`StateStore` names no Git.

**Acceptance.** New runs carry `gitRunKey` and `planningBase`. Admissibility returns
one of the codes in §6.3. Neither refusal is forcible. In sequential mode the checks
are observational and never refuse (§6.2, the stated deviation).

**Failure semantics.** `ActionError` with the admissibility code, an action line the
user can act on, and an event.

**Security.** S-2, S-13.

**Risk.** Medium — this is where the deviation in §6.2 lives, and getting the scope
of the gates wrong breaks existing users' sequential runs. The test that matters most
is the one asserting a dirty tree does **not** refuse when `useWorktrees` is false.

---

### M2-04 — Workspace lifecycle and setup cleanliness

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

### M2-05 — `TaskAttemptResult`, trusted receipt, marker

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

### M2-06 — Deterministic Integrator and integration-tree verification

**Goal.** Serial, ordered, mechanically verified integration — the only place a task
becomes `completed` — and the integration worktree as the single tree that final
verification and final review both observe.

**Dependencies.** M2-05.

**Production files.** `src/app/integrator.ts` (new);
`src/app/scheduler.ts` (integration phase after the wave barrier);
`src/contracts/result.schema.ts` (`integration` block);
`src/cli/review.ts` (**§19**: `runVerification` and the `GitClient` both move to the
integration worktree; the reviewer's changed-file list becomes
`planningBase..integration` rather than `git status`);
`src/adapters/git/git-client.ts` (a diff-against-a-base mode).

**Tests.** §26.4 in full. Integration: a forged marker is refused; a merge conflict
halts with recorded paths; the merge commit's parent count is the discriminator; the
verification result, the reviewer's file list and the DoD all name the same commit.
Architecture: rules 6 and 11 of §26.1.

**Acceptance.** Integration order is topological. No validation command runs during
integration. `TaskResult.integration` is present on every completed task. Ancestry is
checked before merging. **Final verification and final review run in the integration
worktree, against one commit, and that commit is recorded on the run (§19.2).** In
sequential mode both continue to run in the project directory, unchanged.

**Failure semantics.** Conflict → `merge --abort`, task `review_required`, run halted.
Tree or nonce mismatch → `attempt_marker_mismatch`, halted, never repaired. An
integration worktree that cannot be produced → `integration_worktree_unavailable`.

**Security.** S-9.

**Risk.** High. Two distinct failure modes: a dependent task starting against a branch
that does not contain its dependency — silent, and only visible three tasks later —
and a "verified tree A, reviewed tree B" split, which would make a green run mean
nothing.

---

### M2-07 — Crash recovery

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

### M2-08 — Retry semantics and attempt retention

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

### M2-09 — Git-aware cleanup

**Goal.** `agent-flow clean` reclaims namespaces safely and touches nothing foreign.

**Dependencies.** M2-02, M2-03.

**Production files.** `src/cli/clean.ts`; `src/adapters/git/git-workspaces.ts`.

**Tests.** §26.3 cleanup cases: a foreign worktree and a foreign branch survive; a
removed run leaves no worktree and no ref; a run whose namespace cannot be reclaimed
keeps its state and exits non-zero; the active run and a locked run are refused.

**Acceptance.** §20 in full, including the ordering rule (Git before state).

**Failure semantics.** Partial failure is reported per run and exits non-zero. Never
`rm -rf` on a registered worktree.

**Security.** S-5, S-4.

**Risk.** Medium. This is the item that deletes things, and the blast radius of a
path bug is the user's other worktrees.

---

### M2-10 — Read models, CLI and Web observability

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

### M2-11 — Parallel scheduler activation

**Goal.** `effectiveConcurrency > 1`. **This is the last functional item, and it is
one edit plus its wiring.**

**Dependencies.** M2-01 … M2-08, and M2-10 for the observability that makes a
parallel run debuggable.

**Production files.** `src/app/execution-context.ts` (passes the resolved
`IsolationMode` into `resolveTaskConcurrency`); `src/app/run-actions.ts` (records the
decision).

**Tests.** §26.4 in full, at N=2 and N=4, against real Git. A run whose admissibility
is refused still resolves to 1. `parallelism_clamped` is recorded when and only when
the numbers differ.

**Acceptance.** With `useWorktrees: true`, an admissible run, and
`maxTasks: 4`, four independent tasks execute concurrently in four worktrees, are
integrated in topological order, and the user's working tree is unchanged. Without
isolation the effective value is 1, however the configuration is written (I-11).

**Failure semantics.** Not admissible → sequential is not silently substituted; the
run is refused with the admissibility code (§6.3), except for the configured-off case.

**Security.** —

**Risk.** Medium, and it is the risk of **landing this item too early**. Every
guarantee above is what makes this edit safe; done before them it is the M2-00 defect
with extra steps.

---

### M2-12 — E2E, dogfood and documentation

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

```text
M2-01 ──┬──► M2-02 ──┬──► M2-03 ──► M2-04 ──► M2-05 ──► M2-06 ──► M2-07 ──┐
        │            │                          │         │              │
        │            └──────────────► M2-09     └───┬─────┘              │
        │                                           │                    │
        └───────────────────────────────────────►  M2-08 ────────────────┤
                                                                         │
                              M2-10 ◄──────────────────────────────────  │
                                │                                        │
                                └──────────────► M2-11 ◄─────────────────┘
                                                   │
                                                   ▼
                                                 M2-12
```

**Critical path:**

```text
M2-01 → M2-02 → M2-03 → M2-04 → M2-05 → M2-06 → M2-07 → M2-11 → M2-12
```

**M2-09 (cleanup)** and **M2-10 (read models)** are off the critical path and may be
built in parallel with M2-05 … M2-08. **M2-08 (retry)** must land before M2-11: retry
semantics under fan-out are part of what makes concurrency safe.

### The first moment `effectiveConcurrency > 1` may be enabled

**M2-11, the eleventh of twelve items.**

Not before, and the preconditions are exact:

```text
git.useWorktrees === true
  AND admissibility === admissible                    (§6.3)
  AND M2-02  the hook-isolated Git adapter exists
  AND M2-03  the run has gitRunKey and planningBase, and the gates hold
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
[ ] cleanup leaves no worktree and no ref behind, and touches nothing foreign
[ ] all CI jobs green
[ ] real Node dogfood: the full §27 matrix
[ ] real Flutter dogfood: the full §27 matrix
```

Any single line unmet is **FAIL**. There is no partial pass, because every line above
is something a user would otherwise discover by having it go wrong.

---

## Appendix A — Refusal codes

| Code | Raised by | Forcible |
|---|---|---|
| `worktrees_disabled` | admissibility | n/a — configured intent, honoured silently |
| `not_a_git_repository` | admissibility | no |
| `repository_is_bare` | admissibility | no |
| `repository_has_no_commits` | admissibility | no |
| `repository_has_submodules` | admissibility | no |
| `repository_root_unresolvable` | admissibility | no |
| `git_version_unsupported` | admissibility, `doctor` | no |
| `worktree_path_too_long` | admissibility | no |
| `planning_base_missing` | admissibility | no |
| `git_identity_missing` | admissibility | no |
| `agent_flow_state_not_ignored` | admissibility | no |
| `working_tree_dirty` | admissibility, planning gates | **no** |
| `planning_base_moved` | admissibility, planning gates | **no** |
| `git_run_key_collision` | `GitWorkspaces`, first entry only | no |
| `namespace_missing` | `GitWorkspaces`, resume only | no |
| `task_workspace_preparation_failed` | `TaskWorkspaces` | no |
| `attempt_marker_mismatch` | Integrator, recovery | no |
| `attempt_tree_missing` | recovery | no — requeues |
| `integration_conflict` | Integrator | no |
| `integration_worktree_unavailable` | Integrator, recovery | no |

## Appendix B — New events

None of these carries an absolute filesystem path (§7.2, §21.3).

```text
run_git_identity_assigned      { gitRunKey, planningBase }
planning_base_observation      { clean, head, planningBase, matches }   sequential mode
worktree_mode_refused          { code, detail }
integration_branch_created     { branch, base }
task_workspace_created         { task, attempt, branch, base }
task_workspace_preparation_failed { task, attempt, phase, changes }
task_attempt_validated         { task, attempt, judgement, validationIds }
task_attempt_marker_created    { task, attempt, marker, tree }
task_integrated                { task, attempt, marker, mergeCommit }
integration_conflict           { task, attempt, paths, previouslyIntegrated? }
integration_recovered          { task, attempt, window }
namespace_reclaimed            { gitRunKey, worktrees, refs }
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
