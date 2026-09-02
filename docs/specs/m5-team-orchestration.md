# M5 — Team Orchestration

## 0. Status and scope

Normative for M5-00 … M5-08. Where this document and the code disagree, the code is
the current truth and this document is the defect.

M4 answered *who the agents are*, *what they said* and *what they know*. M5 answers
four more:

```text
which agents form a team?
what can each one do?
who should receive this task?
which work may happen at the same time?
```

It does **not** answer *who owns what at the filesystem level* — ownership here is a
coordination signal, never a sandbox — and it does not build the review protocol, the
Kanban, or anything else M6 … M8 own.

---

## 1. What M5 is being built on

### 1.1 The router that exists

```text
Task ──► routeTask(task, policy) ──► WorkflowRole
         complexity · risk · three flags
```

Pure, deterministic, ~70 lines, and the whole of "who runs this" today. Its output
is a *role*, and `resolveRole` turns a role into a (runner, model, effort) triple.

### 1.2 The seam M4 already opened

`resolveTaskAgent` is asked on **every** task and answers with the router's role for
almost all of them. It exists because a function that only ran while a flag was on
would be dead code; the flag moves the *policy*, not the call.

```ts
resolveTaskAgent({ taskId, routedRole, handoffs, config, agentOf, canImplement })
  → { agentId, reason: 'routed' | 'handoff' | 'handoff_not_enabled' | … }
```

**M5 replaces the body of this function and keeps its position.** That is the single
most important structural decision in this milestone: there is one place that answers
"who executes this task", it is already called from the one place that dispatches, and
M5 must not add a second.

### 1.3 The concurrency that exists

Three independent gates already narrow a wave, in this order:

| Gate | Owner | Question |
|---|---|---|
| DAG readiness | `core/dag.ts` | is every dependency completed? |
| effective concurrency | `core/concurrency.ts` | how many may run at once in this isolation mode? |
| file overlap | `core/file-overlap.ts` | would two of them write the same path? |

M5 adds a fourth — agent capacity — and does not touch the three.

### 1.4 What is missing

| # | Gap |
|---|---|
| G-1 | There is no *team*. The roster is nine roles, and two agents cannot serve one role. |
| G-2 | `AgentIdentity.skills` is `[]` for every agent, by construction, because nothing configures one. |
| G-3 | Nothing derives what a *task* needs. `complexity`, `risk` and `files.likely` are read by the router and by overlap detection; nobody asks "what capability does this work require". |
| G-4 | Assignment is not recorded. `task_started` carries a role; there is no answer to "why this agent, and who else was eligible". |
| G-5 | Ownership does not exist. `files.likely` says what a task will touch; nothing says who *should* touch it. |
| G-6 | Capacity does not exist. Two tasks routed to one agent run concurrently, and that agent is a single CLI process per task — which is fine — but nothing expresses "this member takes one at a time". |

---

## 2. The rule that governs every decision below

Restated from M4, because M5 is where it is most easily broken:

> **One truth per concept.**

| Concept | Its one home | What M5 must not build |
|---|---|---|
| ordering | `core/dag.ts` | a team-aware ordering |
| when work runs | `app/scheduler.ts` | a team scheduler |
| **who runs it** | `core/collaboration/handoffs.ts` → becomes `core/team/assignment.ts` | a second router beside `core/router.ts` |
| whether two tasks may share a wave | `core/file-overlap.ts` | an ownership rule that also answers overlap |
| what a runner can do | `core/role.ts` via `resolveRole` | a capability table in the team layer |
| an agent's identity | `AgentIdentity` | a second identity on `TeamMember` |

`core/router.ts` **stays**, unchanged, and becomes the *fallback and compatibility
path* rather than the only path: it is what a project with no `teams:` block gets,
and it is what the assignment policy falls back to whenever it cannot do better.

---

## 3. Invariants

Continuing the series (I-32 is M4's last).

- **I-33 — Assignment is decided by code, never by a message.** An agent-authored
  message may say "Frontend should take this"; only `AssignmentPolicy` assigns.
  Architecture test: no collaboration module may import the assignment module, and
  no assignment module may read a message body.

- **I-34 — Every assignment carries its reason and its rejected candidates.** "The
  AI decided" is not an answer. The persisted record names the score, the filters
  each candidate failed, and the tie-break that settled it.

- **I-35 — Assignment is deterministic.** The same plan, team and state produce the
  same assignment, every time, including the tie-break. A ranking that varied would
  make a resumed run reroute for no reason.

- **I-36 — A resume does not reassign.** After a crash, a task keeps the agent it
  had unless something in §11's list actually changed.

- **I-37 — Ownership is coordination, never containment.** The execution boundary
  stays the worktree. An ownership rule that was load-bearing for safety would be a
  sandbox implemented in a policy file.

- **I-38 — No agent grants itself anything.** An `OwnershipRequest` is authored by
  an agent and decided by the policy or by a human; the requester is never the
  approver.

- **I-39 — Capacity is derived, never stored.** Busy/idle comes from the run's own
  task states. A persisted `busy: true` survives a crash that ended the work.

---

## 4. Domain

### 4.1 `Team` and `TeamMember`

```ts
interface Team {
  readonly id: TeamId;              // stable, never the display name
  readonly name: string;
  readonly members: readonly TeamMember[];
  readonly policies: TeamPolicy;
}

interface TeamMember {
  readonly id: AgentId;             // the same id space M4 already uses
  readonly role: WorkflowRole;
  readonly displayName: string;
  readonly runner: string;
  readonly model?: string;
  readonly skills: readonly Skill[];
  readonly specializations: readonly string[];
  readonly capacity: AgentCapacity;
}
```

**`TeamMember` produces `AgentIdentity`; it is not a second identity.** The roster
function keeps its signature and gains a branch:

```text
config.teams present?
  ├── no  → deriveAgentRoster(config.roles)      unchanged, nine agents, skills []
  └── yes → deriveAgentRoster(config.teams)      one agent per member
```

Both return `AgentRoster`. Every M4 consumer — the harvest, the context builder, the
read model, the CLI — is untouched, because none of them ever asked where the roster
came from.

### 4.2 `Skill`

The charter asks for a balance: not a free string, not a closed enum. The shape:

```ts
interface Skill {
  readonly id: SkillId;             // normalised: lowercase, digits, dashes
  readonly weight?: number;         // 0…1, default 1 — "I can" vs "this is mine"
}
```

`SkillId` is **validated but open**: the same character class `ValidationIdSchema`
uses, for the same reason — an id reaches a log line, a projection key and a scoring
table. A closed enum would make every new stack a product release; a free string
would make `Vue`, `vue` and `vue.js` three skills.

Normalisation is a pure function and the *only* place a skill string becomes a
`SkillId`. Two spellings of one skill is a matcher that silently scores zero.

### 4.3 `TaskRequirements`

```ts
interface TaskRequirements {
  readonly skills: readonly SkillId[];
  readonly complexity: Complexity;
  readonly risk: Risk;
  readonly files: readonly string[];
  readonly capabilities: { readonly write: boolean; readonly workingDirectory: boolean };
}
```

**Derived from the plan first, and from nothing else where the plan already says it.**
`complexity`, `risk` and `files.likely` are on the task. Capabilities come from the
implementation prompt's front matter, exactly as `resolveRole` already reads them.

Skills are the only field the plan does not carry. Three sources, in order:

1. **The task's own `scope` label** — the free-form module label the planner already
   writes (`"backend"`, `"docs"`, `"infra"`) and which nothing currently reads.
2. **Path inference**, from the ownership map: a task whose `files.likely` fall
   inside `apps/web/**` requires whatever skills that area declares.
3. **Advisory enrichment** — an optional UtilityModel suggestion, which is *advisory*
   and merged only where 1 and 2 said nothing. It never overrides a derived skill.

A run with no utility model and no ownership map derives skills from `scope` alone,
which is the honest floor.

### 4.4 `AgentCapacity`

```ts
interface AgentCapacity {
  readonly maxConcurrentTasks: number;   // default 1
}
```

One field. The charter is explicit that modelling an imaginary human CPU is not the
job, and one number is what the scheduler can actually act on.

### 4.5 Ownership

```yaml
ownership:
  backend:
    write: ['src/server/**', 'src/app/**']
  frontend:
    write: ['apps/web/**']
  qa:
    write: ['test/**', 'apps/web/e2e/**']
    shared: ['src/contracts/**']
```

Three modes, and no more without a case:

| mode | meaning |
|---|---|
| `write` | **preferred**: this member is ranked up for tasks here, and others ranked down |
| `exclusive` | two tasks writing here may not share a wave, whoever they are assigned to |
| `shared` | anyone may; overlap detection still applies |

**`exclusive` is the only one with teeth, and it is a scheduling constraint rather
than a permission.** A task assigned to an agent that does not own its files is not
refused — it is ranked lower, and if nobody owns them, the best skill match wins.

Matching uses the segment-aware comparison `core/file-overlap.ts` already implements.
A second glob matcher would be a second answer to "does `src/auth` contain
`src/authz.ts`".

---

## 5. The assignment pipeline

```text
Task ──► TaskRequirements
              │
              ▼
        every team member
              │
    ┌─────────┴──────────┐
    │  capability filter │  resolveRole must succeed for this member
    ├────────────────────┤
    │  ownership filter  │  exclusive owner elsewhere → out
    ├────────────────────┤
    │  capacity filter   │  at maxConcurrentTasks → out
    └─────────┬──────────┘
              ▼
        score each survivor
              │
              ▼
     deterministic ranking ──► TaskAssignment
```

### 5.1 Score

```text
score = 0.55 · skillMatch
      + 0.25 · ownership
      + 0.20 · riskFit
```

- **skillMatch** — the weighted fraction of required skills the member declares.
  Zero required skills scores 1: a task that needs nothing is served by anyone.
- **ownership** — 1 for a `write` owner of every file, 0.5 for some, 0 for none.
- **riskFit** — whether the member's role is the one `core/router.ts` would have
  chosen for this complexity and risk. **This is how the old router survives inside
  the new one**: it becomes a term rather than a replacement, so a high-risk task
  still gravitates to `executor.complex` even when a trivial-executor has the skills.

The weights live in one exported constant with a stated basis, and are configurable
by nobody until a dogfood says they should be.

### 5.2 Tie-break

```text
score descending
  → ownership descending      (an owner beats a stranger at equal score)
    → capacity headroom descending   (spread work rather than queue it)
      → agentId ascending     (total, and stable across runs)
```

The last line is what makes I-35 true. Sorting by score alone leaves ties to array
order, and array order is derived from object key order in a YAML file.

### 5.3 The result

```ts
interface TaskAssignment {
  readonly taskId: string;
  readonly agentId: AgentId;
  readonly reason: AssignmentReason;
  readonly candidates: readonly CandidateScore[];   // every member, ranked, with why
  readonly assignedAt: string;
}

interface CandidateScore {
  readonly agentId: AgentId;
  readonly score: number;
  readonly skillMatch: number;
  readonly ownership: number;
  readonly riskFit: number;
  readonly excludedBy?: 'capability' | 'ownership' | 'capacity';
}
```

`excludedBy` is on the *candidate*, not filtered out of the list, because "why did
Backend not get this" is the question an operator asks and a filtered list cannot
answer.

---

## 6. Handoff, admitted rather than obeyed

M4 records a handoff and reroutes nothing. M5 changes what an accepted handoff *may*
lead to, and does not change who decides.

```text
handoff_accepted
      │
      ▼
AssignmentPolicy.admit(handoff, requirements, team, state)
      │
      ├── target fails the capability filter   → refused, reason recorded
      ├── target fails ownership (exclusive)   → refused
      ├── target at capacity                   → deferred, not refused
      ├── over maxHandoffsPerTask              → refused
      │
      ▼
   reassignment
```

`collaboration.handoffsReassignExecution` is **not removed**. Its meaning migrates:

| | before | after |
|---|---|---|
| `false` | a handoff reroutes nothing | a handoff is not considered by the policy |
| `true` | an accepted handoff assigns the target directly | an accepted handoff is *offered* to the policy, which may refuse it |

So the flag never again means "the model decided". It ships `false` and stays `false`
until M5's own dogfood, per the charter's §66.

---

## 7. Scheduler integration

One new filter, in the existing loop, after the three that are already there:

```text
readyTasks(dag, states)
  → slice(0, effectiveConcurrency)      unchanged
  → admitWithoutOverlap(...)            unchanged
  → admitWithinCapacity(...)            NEW
```

`admitWithinCapacity` is pure: it takes the batch, the assignments and the team, and
returns the subset that fits. A member at `maxConcurrentTasks` defers its second task
to the next wave — the same mechanism `wave_serialised_for_overlap` already uses, with
its own event.

The worked example from the charter, as an acceptance test:

```text
A, B, C independent · A,B → frontend · C → backend · both capacity 1
parallelism.maxTasks = 3
  wave 1: A + C
  wave 2: B
```

**The scheduler is not modified beyond this call.** No second scheduler, no
team-aware ordering, no change to the barrier.

---

## 8. Persistence and projection

Assignments live in **one new append-only log**, beside the collaboration ones:

```text
.agent-flow/runs/<runId>/team/assignments.jsonl
```

Append-only for M4's reason and one more: a reassignment must not erase the
assignment it replaced, or "why is this task on a different agent than yesterday"
has no answer.

**No task state is duplicated.** The log carries who, why, when and the ranking. It
does not carry `queued`/`running`/`completed` — `state.json` owns those, and a second
copy is the drift this rule exists to prevent.

Busy/idle is a **projection** over `state.json` plus the assignment log (I-39):

```text
agent is busy ⟺ some task assigned to it is `running`
```

---

## 9. Backward compatibility

A project with no `teams:` block must behave **decision-identically** to M4, and that
is testable rather than asserted: the acceptance suite runs the same plan through
both paths and compares the resulting `agentId` for every task.

| config | roster | assignment |
|---|---|---|
| `roles:` only | nine derived agents, `skills: []` | `routeTask` — the same role, every time |
| `roles:` + `teams:` | one agent per member | the policy above |

`teams:` is additive, defaulted absent, and never inferred. `ownership:` is likewise
optional; without it the ownership term scores 0 for everyone, which is a constant and
therefore changes no ranking.

---

## 10. Security

Threats specific to M5, each with its closure.

| Threat | Closure |
|---|---|
| An agent talks itself into an assignment | I-33: the policy never reads a message body. Architecture test. |
| An agent inflates its own skills | Skills come from configuration a human wrote, never from agent output. Advisory enrichment touches *task* requirements, never *member* skills. |
| A handoff to an unqualified agent | The capability filter runs `resolveRole` before admitting. A refusal is recorded with which filter rejected it. |
| Ownership glob escape | The same segment-aware matcher `file-overlap.ts` uses; no second implementation. A pattern is matched against `files.likely`, which the plan schema already constrains. |
| Symlink-based ownership mismatch | Ownership matches *declared* paths from the plan, not resolved filesystem paths. It is a coordination signal (I-37); containment stays the worktree. |
| Capacity starvation / monopolisation | The tie-break's capacity term spreads work; `maxReassignmentsPerTask` bounds churn. |
| Reassignment loop | `maxReassignmentsPerTask`, default 2. Exhaustion escalates with the AR §3.6 contract. |
| Assignment spoofing | The log is append-only and written by one module; an architecture test names it. |

---

## 11. Reassignment

Only these five events may move a task:

1. the assigned runner became unavailable,
2. an operator asked,
3. an accepted handoff was admitted by the policy,
4. capacity or team policy changed **before** the task started,
5. a recovery policy that explicitly allows it.

A resume is **not** on the list (I-36). Each reassignment appends a record naming the
old agent, the new one and which of the five applied.

---

## 12. Test strategy

| Layer | What it must prove |
|---|---|
| contract | Team, member, skill, ownership and assignment schemas; a config with no `teams:` parses unchanged. |
| unit | Requirement derivation; each filter in isolation; the score; the tie-break, asserted by shuffling the input and comparing. |
| integration | The scheduler defers a second task for a capacity-1 member; exclusive ownership splits a wave. |
| concurrency | The charter's §63 scenario: 8 ready tasks, 4 agents, mixed capacity, overlapping ownership and files. Assert no violation and *maximum safe* concurrency, not merely a safe one. |
| crash | Assignment persisted then killed before start; killed mid-task; killed after handoff admission before reassignment. Resume is identical. |
| security | One per row of §10. |
| architecture | I-33 … I-39's import bans; one scheduler; one router; the UI computes no assignment. |
| acceptance | M5-ACC-01 … 16 from the charter, verbatim. |
| dogfood | M5-08. |

---

## 13. Work items

| | Item |
|---|---|
| M5-00 | This document, criticised and corrected |
| M5-01 | Team and member contracts; `teams:` config; roster derivation from both sources |
| M5-02 | Skills: normalisation, matching, the score's skill term |
| M5-03 | `TaskRequirements` derivation |
| M5-04 | Candidate filtering, scoring, tie-break; `resolveTaskAgent` re-bodied |
| M5-05 | Ownership: config, matcher, the score's ownership term, the exclusive constraint |
| M5-06 | Capacity: the scheduler's fourth filter and its event |
| M5-07 | Handoff admission through the policy; the flag's migrated meaning |
| M5-08 | Assignment log, read model, CLI, dashboard Teams surface |
| M5-09 | Acceptance, concurrency and crash suites; dogfood |

---

## 14. Acceptance

The charter's M5-ACC-01 … 16, unchanged, plus two this specification adds:

- **M5-ACC-17** — with no `teams:` block, the assignment for every task in a plan is
  *identical* to `routeTask`'s answer, compared task by task rather than asserted.
- **M5-ACC-18** — the ranking is invariant under input permutation: shuffling the
  member list produces byte-identical assignments and candidate order.
