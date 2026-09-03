# M8 — Control Plane & Operational Kanban

**Status:** specified. Normative for M8; where this document and the code disagree, the
code is the current truth.

M4 through M7 each added a set of authoritative facts and a panel to render them. The
dashboard is now eight correct panels, and an operator still cannot answer the four
questions that decide what they do next:

```text
What is happening?
What needs me?
What is blocked, and why?
What is already delivered?
```

M8 adds no workflow authority. It takes facts the system already decided, projects them
**once**, and puts the most actionable one first.

```text
the browser renders decisions
the browser does not invent decisions
```

---

## 1. Repository assessment — what already exists

Nothing here is a green field. Six projections are already load-bearing, and M8's first
job is to **not** become a seventh answer to any of them.

| Existing | Produces | What M8 must not do to it |
|---|---|---|
| `core/run-projection.ts` → `RunProjection` | runtime status, `resumable`, gate, 3 progress axes, review freshness, escalation | recompute any of it per surface |
| `core/dag.ts` → `readyTasks` | which tasks the scheduler may start | re-derive readiness for a board column |
| `core/team/view.ts` → `TeamView` | members, derived status, assignments with candidate ranking, capacity/ownership deferrals | rank candidates, or store `busy` |
| `core/review/view.ts` → `ReviewView` | threads, freshness, findings with lifecycle, `decision`, `unsatisfiedGates` | fold findings into a status |
| `core/forge/delivery.ts` → `DeliveryView` | nine delivery states, checks, failure, a sentence | merge remote checks into local quality |
| `contracts/api.schema.ts` | `TaskSummaryView` carrying `blockReason`, `awaitingIntegration`, `workspaceActive`, `attempts` | add a `column` or `kanbanStatus` field |

**Two things do not exist and are genuinely new:**

1. **A priority over facts.** Every projection above answers one question well. Nothing
   answers *"of everything true right now, which fact should a person act on first"*.
2. **A coherent snapshot.** `RunDetailPage` issues eight independent queries. Each is
   correct; together they can paint a board whose tasks and whose attention queue came
   from different instants.

**One thing exists and is misclassified.** `TaskSummaryView.blockReason` distinguishes
`agent` from `dependency`, which is the *cause class*; the operator needs the *sentence* —
"waiting on TASK-004", "ownership conflict on `src/db/**`", "capacity 1/1". Those facts
exist in the DAG and in `TeamView.deferrals` and are not currently joined to the task.

---

## 2. One-truth rules

Six, and each one names the way it would be broken.

| | Rule | The shortcut it forbids |
|---|---|---|
| T1 | A board lane is computed by exactly one function | a `switch` in the card component "just for the icon" |
| T2 | Attention is computed by exactly one function, over facts | a `attention: true` written when something fails |
| T3 | Nothing about a lane or an attention item is persisted | a `task.column` that survives a crash and lies |
| T4 | The browser receives verdicts and priorities, never inputs to them | shipping `findings[]` and letting the card count blocking ones |
| T5 | The board and the DAG read the same task list, in the same response | a `/board` endpoint beside `/tasks` that can disagree |
| T6 | An operator action is a call to an existing use case | a `PATCH /tasks/:id` that sets a state |

T1 and T2 are enforced by architecture test (M8-A02 … A05). T3 is enforced by schema:
neither concept gets a `*.schema.ts` module, for the same reason `RunProjection` does not
have one — every file with that suffix describes something written to disk, and a crash
mid-write would persist an opinion.

---

## 3. Information architecture

Four levels. Deeper is not richer; it is further from the thing that needs attention.

```text
Workspace          every initialised project, one row each
  └ Project        its active run, attention count, delivery signal
      └ Run        board · graph · review · team · delivery · artifacts
          └ Task   the inspector: attempts, findings, assignment, logs
```

Routes, all of which already exist except the first:

| Route | |
|---|---|
| `/` | **new.** Control plane home: attention first, then active runs |
| `/runs/:runId` | the run, with `?view=board \| table \| dag` |
| `/runs/:runId?task=TASK-003` | the same, with the inspector open — linkable |
| `/projects`, `/agents`, `/analytics`, `/settings`, `/prompts` | unchanged |

`/dashboard` keeps its meaning (the run most likely to want you) and becomes reachable
from the home rather than being the landing page. A landing page that opens one run
answers "what is happening" for one project and hides it for the other nine.

---

## 4. Attention is a projection

`core/attention.ts`, pure, no clock beyond an injected `now`, no I/O.

```ts
projectAttention(input: AttentionInput): AttentionItem[]
```

Input is what the run already knows: `RunProjection`, the task list, `TeamView`,
`ReviewView`, `DeliveryView`, the repository gate contract's local result where one has
been recorded, and the event log for `since`.

### 4.1 The item contract

Seven fields, and §16 of the brief is the requirement each one answers.

```ts
interface AttentionItem {
  /** Stable across reads: derived from the cause, never from position or a counter. */
  readonly id: string;
  readonly priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
  readonly kind: AttentionKind;
  /** What. One sentence, specific. Never "something failed". */
  readonly what: string;
  /** Why — the fact this was derived from, in the operator's vocabulary. */
  readonly why: string;
  /** Scope: which run, and which object inside it. */
  readonly scope: { runId: string; taskId?: string; findingId?: string; agentId?: string };
  /** When the underlying fact became true. */
  readonly since: string;
  /** Exactly one. Never a menu. */
  readonly action: AttentionAction;
}
```

`id` is stable because the queue is live: an item that changes identity between two
reads makes React remount it, loses focus, and animates a row that did not change.

`action` is exactly one because the fastest way to make a queue useless is to render ten
buttons per row. Everything else the operator might do is one click further in, at
`action.route`.

### 4.2 The priority ladder

Deterministic, total, and **not** a model's opinion. Ranking a queue with an LLM makes the
order unreproducible, which is the one property an operator's queue must have.

| | Meaning | Kinds |
|---|---|---|
| P0 | safety or integrity: acting on this wrongly loses work | `remote_diverged`, `integration_conflict`, `ownership_conflict` |
| P1 | a human decision is the only thing blocking progress | `approval_required`, `task_review_required`, `agent_blocked`, `recovery_exhausted` |
| P2 | something authoritative failed | `required_gate_failed`, `required_gate_not_run`, `delivery_failed`, `blocking_finding_open` |
| P3 | degraded, still moving | `review_stale`, `capacity_starvation`, `run_paused`, `degradation_recorded` |
| P4 | informational, actionable, not urgent | `delivery_not_published`, `checks_pending` |

Ties break by `since`, oldest first. Two items of the same kind and priority sort by
`scope.taskId`. The order is therefore a pure function of the facts — the same run read
twice produces the same queue, which is what makes "this moved to the top" mean something.

**`required_gate_not_run` sits at P2 beside `required_gate_failed` and is a separate
kind.** M6 established that at run granularity and M8 keeps it visible in words: a gate
that could not answer is not a codebase that answered no, and rendering both as red
teaches people that red means "look into it" rather than "this failed".

### 4.3 What is not an attention item

- **Anything dismissible.** A failed gate, a stale review and a diverged remote disappear
  when the *fact* changes and never because somebody closed them. There is no dismiss.
- **A healthy run's progress.** `implementing`, 3 of 9 tasks done, is not attention.
- **Anything the operator cannot act on.** If there is no action, it is a status, and it
  belongs on the run card.

---

## 5. Kanban is a projection of task state

`core/board.ts`, pure.

```ts
boardLane(task: TaskSummaryView, context: BoardContext): BoardLane
```

`BoardContext` carries what the task alone cannot answer: DAG readiness, the run's runtime
status, and the deferral records.

### 5.1 The lanes

Six, mapped from the eight `TaskState` values plus two derived conditions.

| Lane | From |
|---|---|
| `backlog` | `queued`, and the DAG does not report it ready |
| `ready` | `queued`/`ready` and DAG-ready, not running — **deferred tasks live here with a reason** |
| `in_progress` | `running`, or `awaitingIntegration`, or `interrupted` while the run is executing |
| `review` | `review_required`, or a corrective round in flight for this task |
| `blocked` | `blocked`, `failed`, or `interrupted` while nothing is executing |
| `done` | `completed` |

Two decisions worth defending:

**`failed` is `blocked`, not a seventh lane.** From an operator's position they are the
same situation — the task is not moving and a person decides what happens next. The card
says which, and the reason line carries the failure class.

**`interrupted` is lane-dependent on the run.** It is what a killed coordinator leaves. If
the run is executing, recovery reconciles it and it is genuinely in progress; if nothing is
executing, it is a task waiting for a person to resume, and calling that "in progress"
is the shape of defect M4 was made of — a screen showing motion where there is none.

### 5.2 Exactly one lane, provably

The mapping is an exhaustive `switch` over `TaskState` with a `never` check, so adding a
state to the union fails compilation rather than falling silently into `backlog`. For data
from an older run carrying a state this build does not know, the function returns
`unknown` and the board renders an explicit lane for it. **Silently defaulting to backlog
is forbidden**: a task nobody can see is worse than a task in a lane labelled "unknown".

`M8-ACC-04` asserts, over a fixture with every state and both derived conditions, that
each task appears in exactly one lane and that the lane counts sum to the task count.

### 5.3 No drag-and-drop

Dragging `blocked` → `done` would be the browser writing state. There is no domain action
that means "move this task to that column", so there is no drag. Reassignment is M5's and
stays there; WIP is M5 capacity and is not re-invented in the UI.

`M8-A12` asserts no drag handler under `apps/web/src` names a task-state mutation.

---

## 6. Why a task is where it is

The single most requested missing sentence. Every non-`done` lane carries one, derived:

| Lane | The sentence comes from |
|---|---|
| `backlog` | the DAG: `waiting on TASK-004, TASK-006` |
| `ready` | `TeamView.deferrals`: `capacity — backend is at 1/1`, `ownership — src/db/** is held by data` |
| `in_progress` | the attempt: `attempt 2, in a worktree` / `validated, awaiting integration` |
| `review` | `ReviewThreadView`: `changes requested — 2 blocking findings` |
| `blocked` | `blockReason` + the escalation: `the agent reported the SDD does not answer X` |

**None of these is new data.** All five already exist in a projection; none of them is
currently joined to the task the operator is looking at. That join is `core/board.ts`'s
second output, and it is the reason the board is worth building at all — a Kanban that only
moves cards between columns is a prettier task table.

---

## 7. The coherent snapshot

`GET /api/v1/runs/:runId/control` returns one object:

```text
run          RunDetailView (already includes RunProjection)
tasks        TaskSummaryView[] + lane + reason, one entry each
lanes        counts per lane, computed server-side
attention    AttentionItem[]
team         TeamView totals + per-member load (full view stays at /team)
review       ReviewView totals + unsatisfiedGates (full view stays at /review)
delivery     DeliveryView
```

Three reasons this is one endpoint rather than seven:

1. **Consistency.** A board and an attention queue read at different instants can show a
   task in `running` and an item saying it failed. One read, one instant.
2. **N+1.** A hundred cards must not be a hundred requests. `M8-ACC-21` asserts the
   request count for a 100-task run is constant.
3. **Authority.** Lanes and priorities are computed once, on the side that owns them.

The existing endpoints stay. They serve the detail panels, which are opened one at a time
and are not on the critical path of the first paint.

`GET /api/v1/workspace` is the same idea one level up: per project, the active run, the
attention count by top priority, progress, blocked count, team load and delivery signal —
and **not** a full run detail for each. A workspace of fifty projects must not read fifty
run directories in full.

---

## 8. Operator actions

Every button calls a use case that already exists. The set is closed:

```text
approve · reject · revise · start · resume · pause · cancel · retry
forge publish · forge sync
```

Three rules:

- **Eligibility on screen is presentation.** The server re-checks authority at the moment
  of the click, because the run may have moved between the render and the press. A button
  that is enabled and then refused is correct behaviour; a button that writes without a
  re-check is not (`M8-ACC-28`).
- **Destructive actions confirm, and name what they destroy.** `cancel` and `reject` end a
  run. `retry --force` spends a budget. The dialog says which.
- **An override stays visible afterwards.** Forcing a gate is already recorded as a
  degradation; the control plane keeps rendering it, so a gate opened by force never looks
  like one that passed.

---

## 9. Live updates

The event stream exists and already invalidates queries. M8 adds the control snapshot to
the invalidation map and nothing else — no polling, no second channel.

**Out-of-order protection is new and is required.** The stream can deliver an event about
a task the snapshot already reflects. The rule: a snapshot is accepted only if its
`updatedAt` is not older than the one on screen. Without it, a late event repaints a card
back to `running` after it completed, which is a lie with a timestamp on it
(`M8-ACC-23`).

---

## 10. Repository quality is not feature quality

The control plane renders two things that both use the word "gate", and conflating them
is the M8-era version of the M7 defect:

| | `ReviewView.gates` | `scripts/gates.mjs` |
|---|---|---|
| Question | did the feature this run implemented pass | may Agent Flow itself ship |
| Subject | the code the agents wrote | this checkout |
| Owner | `core/validation-registry.ts` | `test/gates.test.ts` |
| Where it renders | inside a run | nowhere in a run |

They are never grouped, never summed, and never share a badge. The repository contract is
a development concern and does not appear on a run surface at all.

Likewise **local quality and remote checks stay visually separate** (M7 §10, restated).
A single "green" badge over both would let a green CI hide a failed local gate.

---

## 11. Empty states are factual

```text
No active run
No items need attention
No blocking findings
No remote delivery configured
```

Never "Everything healthy". A run whose required-CI evidence has not been observed is not
healthy; it is unobserved, and those are different sentences.

---

## 12. Large plans

Measured before optimised. The budget:

| | |
|---|---|
| 100 tasks | board interactive, no frame over 100 ms during scroll |
| 200 tasks | same, with lane virtualisation if the measurement demands it |
| one task update | re-renders that card and its lane counts, not the board |

`M8-ACC-20` builds a 100-task fixture and asserts the board renders every card exactly
once. Memoisation and virtualisation are added **if** the measurement says so, and the
measurement goes in the milestone report either way.

---

## 13. Responsive and accessible

Widths: 1440, 1280, 1024, 768, 390, plus 1150 — an intermediate width, because a layout
that is right at both ends of a boundary can still be wrong between them.

- Desktop: lanes side by side, horizontally scrollable within their own region.
- Tablet and below: lanes stack, with a segmented control to jump between them.
- Mobile prioritises attention → current status → current work → actions. Nothing
  important is hidden to make it fit; the board becomes a filtered list.

Accessibility is a shipping requirement, and the board must be fully usable with no drag:

- each lane is a labelled region with its count in the accessible name;
- cards are reachable and activatable by keyboard, with visible focus;
- state is never colour-only — every badge carries a word;
- the inspector is a dialog with focus management and Escape.

---

## 14. Security

The threat model for a read-mostly local dashboard, and the three that are real:

| | Why it matters here |
|---|---|
| the browser deriving authority | the whole milestone; enforced by M8-A01 … A08 |
| a stale action button | the run moved; the server re-checks (§8) |
| untrusted text rendered as markup | findings, agent messages, GitHub titles and logs are **untrusted** |

Agent output, review findings, collaboration messages, remote titles, feature requests and
log lines are all text a model or a stranger wrote. They render as text. No
`dangerouslySetInnerHTML` is added, and `M8-ACC-34` plants a payload in each source and
asserts it appears on screen as characters.

Origin and Host validation, CSRF posture and loopback binding are M2's and unchanged. The
new endpoints are reads and carry no path-shaped or ref-shaped field, which the existing
architecture rule already asserts in both directions.

---

## 15. Architecture invariants

| | |
|---|---|
| M8-A01 | the browser calls no state-writing function directly; every write is a use case |
| M8-A02 | no board-lane decision exists under `apps/web/src` |
| M8-A03 | exactly one task-to-lane projection exists in the repository |
| M8-A04 | no attention priority is computed under `apps/web/src` |
| M8-A05 | exactly one attention projection exists |
| M8-A06 | the browser does not compute review freshness |
| M8-A07 | the browser does not compute a quality verdict |
| M8-A08 | the browser does not compute a delivery verdict |
| M8-A09 | the workspace summary imports no adapter |
| M8-A10 | projections import no React |
| M8-A11 | actions go through app use cases |
| M8-A12 | no drag handler mutates task status |
| M8-A13 | a remote check cannot become local quality |
| M8-A14 | team load is derived, never stored |
| M8-A15 | the repository gate contract has one source |
| M8-A16 | CI blocking lanes are represented canonically |
| M8-A17 | packaging remains required |
| M8-A18 | the browser source scan includes `.tsx`, proved by a planted fixture |

A18 is not a formality. M6 found that `sourceFiles` walked `.ts` only, so every rule
scanning `apps/web/src` was reading **0 of its 47 components** — a rule forbidding the
browser from deciding anything passed while the browser was free to decide everything. M8
adds a test that plants a forbidden construct in a `.tsx` fixture and asserts the scan
sees it, so the rule's *reach* is proved rather than assumed.

---

## 16. Test strategy

| Layer | What only it can prove |
|---|---|
| unit, over fixtures | the ladder is total and deterministic; every state maps to one lane |
| architecture | the browser cannot reach any of the decisions above |
| server | the snapshot is one read, and its parts agree |
| web component | a card renders its reason; an empty state is factual |
| E2E, scripted runners | a task moves lane without a reload; an action reaches the use case |
| visual | `BLOCKED`, `STALE`, `NOT RUN`, `REMOTE DIVERGED`, `APPROVAL REQUIRED` |
| live dogfood | everything the fixtures agreed to be true about |

**Text assertions accompany every visual one.** A screenshot diff has a tolerance, and a
label changing from `NOT RUN` to `FAILED` is inside it. Those five words are asserted as
text (`M8-ACC-33` and the visual suite together), because tolerance must not be able to
hide a semantic change.

---

## 17. Acceptance

Thirty-six criteria, tagged `M8-ACC-01` … `M8-ACC-36`, greppable, listed in the milestone
brief and asserted in `test/e2e/m8-acceptance.test.ts` in the shape M6 established: one
test per criterion, so the table is produced by a scan rather than by a person reading.

---

## 18. Live dogfood

M8 does not close on fixtures. A real Agent Flow run, operated from the dashboard, with
the terminal used only when the UI could not answer — and **every such fallback recorded**.

The bar:

```text
normal operation does not require reading state.json or events.jsonl
```

Proved by: a task moving READY → IN PROGRESS → REVIEW → DONE and at least one reaching
BLOCKED; at least one attention item appearing from a fact, linking to its cause, and
disappearing when the fact resolves; and the board updating with the page open and
untouched.

---

## 19. Architectural critique of this specification

Five things this document gets wrong or leaves exposed, written before the code so they are
decisions rather than excuses.

**1. `BoardContext` is a bag, and bags grow.** It currently carries DAG readiness, runtime
status and deferrals. Every future "why is it there" sentence will want one more field, and
in six months it is the whole run. The mitigation is that `boardLane` returns a lane and a
reason and takes no other responsibility; the moment it needs a fourth input to decide a
*lane*, the taxonomy is wrong rather than the signature.

**2. The snapshot endpoint is a second read path.** `/tasks`, `/team`, `/review` and
`/delivery` still exist and still work. Two ways to read the same fact is the shape of
defect this milestone exists to remove — and I am adding one. The defence is that the
snapshot *composes* those readers rather than reimplementing them: `run-reader.ts` gains
one function that calls the five it already has. If any part of the snapshot is ever
computed differently from its own endpoint, that is the failure, and an architecture rule
asserts the composition rather than trusting it.

**3. Priority is a policy, and this document states it as a fact.** P0–P4 is a judgment
about what matters, made once, with no evidence behind it yet. It will be wrong for
somebody. It is deterministic and it is in one function, which makes it changeable — but
the spec should not pretend the ladder is derived from anything. The dogfood is the first
evidence, and §66's report records where the order was wrong.

**4. `interrupted` depending on run status makes the lane function non-local.** Two tasks
in identical states can be in different lanes because of something outside them. That is
correct and it is also the kind of rule people forget, so the test names the case
explicitly rather than covering it incidentally.

**5. The milestone risks becoming a redesign.** M8 §60 forbids it and the temptation is
structural: the board is new, so everything around it looks old. The rule this
implementation holds itself to is that **every visual change answers an operational
question**, and a change that cannot name its question does not land. The measure of
success is not that the dashboard looks different; it is that an operator stops opening
`state.json`.
