# The local dashboard

```bash
agent-flow ui              # this project
agent-flow ui ~/wk         # every initialised repository under ~/wk
agent-flow ui --classic    # the previous dashboard, same server, same API
```

Serves `http://127.0.0.1:4782`. Loopback, no authentication, no cloud — see
[`security.md`](security.md) for what that does and does not protect.

## Two bundles, one API

`ui` opens **Deck** (`apps/deck`). The previous dashboard (`apps/web`) is still built,
still packaged and still served behind `--classic`; nothing anybody bookmarked stops
working, and Deck understands the old `/runs/<run>?project=<id>` links. The server does not
know which one it is serving — both read the endpoints listed at the end of this page, and
both write through the same five use cases.

Deck has four screens and one idea:

| Route | |
|---|---|
| `/` | **The deck.** What needs a person, across every project, in the server's order — priority, then age — folded to six rows. Then one lane per project: runtime, the pipeline as ten cells, tasks, attention, seats, forge, last activity. |
| `/p/<project>/runs/<run>` | **The recorder.** The run as a strip of time: the clock, the ten stages drawn to true duration, the run's own marks, one lane per task with a bar per attempt. Drag the playhead and the graph, the task panel and the log show what the audit trail said was true at that instant; let go at the right edge and the server's answer takes over. `?task=` and `?at=` ride in the address, so a moment in a run is a link. |
| `/runs` | History, filtered locally. |
| `/crew` | What each of the nine roles would run, and whether the runners can. |

**The recorder decides nothing.** It reads `GET /runs/:id/events` — the audit log, in bulk
— and folds it into bars and marks in `apps/deck/src/lib/replay.ts`. Every bar is a line of
the log with its `at` read off; a task's outcome is the word `task_finished` wrote,
verbatim, and an attempt whose end the log never recorded is drawn hatched as `unknown`
rather than guessed. The present is never the fold's to answer: `/tasks`, `/stages` and
`/control` are, and the page reads them whenever the playhead is live. Four rules in
`test/architecture.test.ts` (`DECK-A01` … `A04`) keep it that way, and every rule that held
the previous dashboard to the same standard now scans both bundles.

Deck is built from scratch: its own tokens, six tones, two typefaces, no component library.
`apps/deck/DESIGN.md` says why each choice was made.

The dashboard is a *view and a set of state transitions*, not a second copy of the
workflow. Every read comes from the server; every write calls the same use case
`agent-flow approve`, `revise`, `retry` and `run` call. Nothing in the browser holds a
copy of a run's state, so nothing on any screen can be wrong about what a click did:
it either happened on disk or it did not.

---

## The two modes

| | `agent-flow ui` | `agent-flow ui <dir>` |
|---|---|---|
| Root | the current directory | the directory you named |
| Sidebar | one project | every initialised repository under the root |
| Scope with no project selected | that project | the whole workspace |

**A project is a directory with `.agent-flow/config.yaml`.** A `runs/` folder left
behind is a leftover, not a project; a `package.json` is not a marker either, or half
a machine would qualify.

**The root is chosen once, when the server starts.** After that the browser's entire
vocabulary for a project is the id the registry issued. There is no request shape that
carries a directory, which is what makes "this server can only see what the operator
pointed it at" true rather than aspirational.

### `ui.workspaceDepth`

How far down to look, and it is bounded on purpose — an unbounded scan of a home
directory takes minutes to start and reads places nobody asked it to.

```yaml
# ~/.agent-flow/config.yaml
ui:
  workspaceDepth: 2      # default; maximum 6
```

`--depth <n>` overrides it for one run. `node_modules`, `.git`, `dist`, `build`,
`target`, `vendor`, `.venv`, `__pycache__`, `.next`, `.cache` and `coverage` are never
descended into, and neither is anything beginning with a dot.

**Nothing outside the root is discovered, however it is reached.** A symlink inside the
workspace pointing at a repository elsewhere is skipped and *named* — on startup and on
the Projects page — rather than followed. A link that stays inside the workspace is
followed, and the project is registered under its resolved path, so the same directory
reached twice is one project rather than two histories.

---

## Pages

| Route | |
|---|---|
| `/` | **The control plane.** What needs a person, most urgent first, then every project with the state of its current run. |
| `/dashboard` | The run most likely to want you: executing, then waiting at a gate, then most recent. Renders the same component `/runs/:runId` does. |
| `/runs` | History. Filters are local — narrowing the list costs no round trip. |
| `/runs/:runId` | One run, on **one surface at a time**. The board opens; the graph, the table, the pipeline and its summaries, the review, the delivery record and the team are tabs beside it. |
| `/projects` | The registry, with each project's current run and — once one is selected — its runner health. |
| `/agents` | What each of the nine logical roles would run, and which cannot be resolved. Read-only. |
| `/prompts` | The prompts this installation ships. They belong to the installation, not to a repository. |
| `/analytics` | Aggregates over recent runs: duration per stage, model usage, outcomes. |
| `/settings` | The effective configuration, sectioned, with the origin of every value. Read-only. |

Four search parameters carry state that belongs in a URL rather than in a component:

- `?project=<id>` — which project you are looking at. A reload, a bookmark and a link
  all mean the same thing. Switching leaves the run behind, because a run id belongs to
  one project.
- `?view=` — which surface of a run is open: `board` (the default, and written as
  nothing), `dag`, `tasks`, `overview`, `review`, `delivery`, `team`.
- `?panel=` — the same choice in the attention queue's vocabulary: `approval` and
  `quality` land on `overview` and `review` respectively, the rest map by name.
- `?task=<id>` — which task the inspector opens on.

**The last two did nothing for two milestones.** `routeFor` emitted them for six of the
attention queue's seven destinations from M8, and the run page read only `?view=`, so a
row reading "Review the findings" navigated to a page that ignored the word `review` and
left the panel below the fold. Its unit tests asserted the *string* the function returned;
`M8-ACC-19` asserted two regular expressions against the page's source and claimed in its
own comment that `?task=` round-tripped. Nothing was red. A URL parameter nobody reads
fails no compiler, no linter and no assertion — the same shape as a CSS class nobody
defines, which is what the delivery panel was wearing at the same time.

Both are read now, in `apps/web/src/lib/run-surface.ts`, which is plain `.ts` with no JSX
precisely so `M8-ACC-19` can call `surfaceFromParams` rather than grep for it.

---

## One surface at a time

M8 left the run page rendering everything it knew. Measured at 1440×900 with a real run:
the document ran to **1753px for a 900px viewport**, the board held **555 of them**, 450px
of header sat above it and 850px of panels below the fold — a run panel with a hero header,
an isolation strip and a nine-step pipeline; the task panel with its own title, filter and
five-count strip; four summary cards; and the review, delivery, team and collaboration
panels stacked underneath. A third of the page for the thing the page is for, and eight
panels permanently open for somebody who came to look at one.

Nothing left the product. Every panel is a tab:

```text
run id · IMPLEMENTING · feature        3/9 tasks · 41m22s · stage 7 of 9 · 50% ▓▓▓  [⏵]
P1  the plan is waiting for a decision                            Review the plan →
Board  Graph  Tasks  Overview  Review  Delivery  Team              [search] [filters]
──────────────────────────────────────────────────────────────────────────────────────
                          the surface, filling the viewport
```

**A tab whose projection is empty is not rendered at all** — the same "absent rather than
empty" the review, delivery and collaboration panels already applied to themselves, moved
up one level so it costs a door rather than a room. Most runs have no reviewer and no
forge, and they show four tabs rather than seven.

The board, the graph and the table share the filter and the selection, which is what makes
them views rather than pages. The header carries what changes while you watch — which run,
what state, how far, how long, and the two or three things you can do about it. `stage 7 of
9` is the pipeline's answer in nine characters; the strip itself, with its durations,
runners and models, is on Overview.

**The inspector is a pane on the table and the graph, and a drawer on the board.** Not a
width rule: the board's lanes are 244px each and there are six of them, so a 400px pane
leaves 560 — two lanes and a sliver, photographed at 1200 with `IN PROGRESS` sliced down
its middle. A table reflows its own columns and a canvas refits its own viewport, and both
are genuinely better beside the detail than under it. Exactly one inspector is ever in the
document, chosen in JavaScript rather than hidden in CSS: a CSS-hidden second copy is
invisible to the eye and entirely present to a screen reader.

---

## The control plane (M8)

The landing page answers four questions, in this order:

```text
What needs me?
What is running?
What is blocked?
What is delivered?
```

**Attention first, and it is a projection.** Nothing stores `attention = true`. Every item
is folded from a fact something else already decided — a gate the run is held at, a
required quality gate that failed *or did not run*, a review whose tree the task has moved
past, a remote branch that diverged — and it disappears when that fact does. There is no
dismiss, because a failed gate somebody could close is a failed gate nobody sees twice.

The order is a deterministic ladder in one function, `core/attention.ts`:

| | | |
|---|---|---|
| P0 | integrity | acting wrongly here loses work |
| P1 | needs a decision | a person is the only thing between the run and progress |
| P2 | failed | something authoritative said no |
| P3 | degraded | still moving |
| P4 | for information | actionable, not urgent |

Ties break by age, then by scope, so two reads of the same run produce the same queue.
**No model ranks it** — a queue that reorders between two reads of identical facts is a
queue whose top row nobody can trust.

Every item carries one recommended action and one place to go. Never ten buttons, and
never "something failed, check the logs" — the projection has no branch that can emit one.

### The board

Six lanes, projected from the task state, the run and the wave that formed:

```text
BACKLOG      planned, dependencies not met
READY        the graph allows it; a wave has not taken it
IN PROGRESS  assigned, running, validating or integrating
REVIEW       waiting on a review decision
BLOCKED      a person decides what happens next
DONE         merged onto the integration branch
```

**The columns are not state.** There is no `task.column` and there will not be one: a lane
is a question about the task, the DAG and the run, all of which move, and a stored column
is the copy that goes stale after a crash. A task whose state this build does not
recognise gets an explicit `UNKNOWN` lane rather than falling into BACKLOG — a task nobody
can see is worse than a task in a lane labelled honestly.

**There is no drag.** Dragging BLOCKED → DONE would be the browser writing state, and no
domain action means "move this task to that column". Reassignment stays M5's; WIP is M5
capacity and is not re-invented on screen. An architecture rule asserts no drag handler
exists, and the consequence is that the board is keyboard-operable by construction.

**An empty lane is a heading, not a container.** It keeps its name and its zero — a board
that dropped BLOCKED while nothing was blocked would change width as a run progresses, and
a column that appears is a column somebody has to notice appearing — but it draws no
border, no fill and no card list. That was a 104px rail while the board had 555 pixels of
page; once the board got the viewport it would have been a 700px empty rectangle, and three
of them on a healthy run is half the board rendering nothing, loudly.

**A filter narrows the cards and never the count.** While one is on, a lane header reads
`2 / 4`: the projection put four tasks here and you are looking at two. Recounting the badge
would answer a different question from the one `BoardLaneView.count` answers, and showing
`4` over two cards would read as a rendering fault. The predicate is `filterTasks`, the same
function the table uses — two predicates over one filter is two definitions of `waiting`.

**Every card says why it is where it is.** That sentence is the reason the board exists:
the DAG already knew the task waits on TASK-004, `TeamView.deferrals` already knew the wave
held it for capacity, and the review thread already knew two findings block it — none of
them was ever joined to the card an operator was looking at. A Kanban without that join is
a task table with rounded corners.

### 390 pixels

The spec named 390 among the widths M8 covers, and photographing it is what proved the
dashboard did not work there: the sidebar was a fixed 240px column that never collapsed, so
it took 62% of the screen and left the content 150. The run id read `AF-2026…`, a task
card's title read `Gerar pr…`, and the attention queue wrapped to one word per line. The
board had stacked its lanes below 1024 since M8 landed; the shell around it had not.

Below 1024 the sidebar is now a drawer — one button, Escape closes it, navigating closes
it — and the three rows that never wrapped do: the run header, the task panel's header and
the count strip. Nothing applies at or above 1024, and no existing baseline moved.

**Every mobile shot carries assertions the picture cannot make.** The six lane names as
text, all five counts, a card's reason sentence, and the page overflow as a number:
`document.documentElement.scrollWidth` must not exceed the viewport. That last one is
deliberately about the *document* and nothing else — the pipeline and the board scroll
inside their own regions on purpose, and a check that forbade every scrollable element
would forbid the design rather than the defect. It found 187 pixels of real overflow the
first time it ran, produced by the drawer's own off-canvas geometry rather than by content.

Lane stacking is read from the boxes rather than from a class name. A media query that
stops applying is invisible to a class assertion and obvious to a bounding-box one, which
is what the positive control demonstrates: removing `max-lg:flex-col` turns one shared left
edge into six.

### One read, one instant

`GET /runs/:id/control` serves the board, its reasons, the attention queue and the team,
review and delivery pressure together. The panels above still have their own endpoints and
still use them; this is the read the board and the queue share, and sharing it is the
point — two halves of one screen must not describe two moments, and a hundred cards must
not be a hundred requests.

Each snapshot is stamped with the instant it describes, and the browser refuses one older
than what is on screen. Without that, a late event repaints a completed card back to
`running`, which is a lie with a timestamp on it.

`GET /workspace` is the same idea one level up: per project, the active run, an attention
count and its top priority, progress, blocked count, team load and delivery signal.
**Only a project with an active run pays for an attention count** — computing one needs the
review, the team and the delivery record, and fifty idle projects paying that is what makes
a workspace take seconds to answer a question about the two that are running.

Run ids restart at 001 per project per year, so two repositories initialised in the
same year both hold `AF-2026-001`. Every link to a run carries its project for exactly
that reason.

---

## The dependency graph

The **Graph** tab draws the plan's edges. It is a second rendering of the same task list —
same filter, same selection — not a separate page, so switching does not lose your place.
`?view=dag` is still the spelling in the address, because every link M8 shipped and every
bookmark somebody has says it.

The structure comes from the server, which derives it from the plan through the same
`core/dag` the scheduler runs on. The browser lays out what it is given and never
recomputes what may run. A filter *dims* what it excludes rather than removing it: a
node vanishing takes its edges with it, and a chain with a hole in the middle describes
a dependency that does not exist.

A cycle or a dependency on a task the plan does not contain is reported above the
canvas, and the rest of the graph is still drawn — a blank pane explains nothing, and
this is exactly the plan somebody needs to look at.

---

## What the dashboard can change

Five transitions, each one a call to the use case the CLI uses.

| | | |
|---|---|---|
| **Approve** | `POST /runs/:id/approve` | Opens the gate for the plan on disk. |
| **Reject** | `POST /runs/:id/reject` | Closes the run without implementing it. Artifacts stay. |
| **Revise** | `POST /runs/:id/revise` → `202` | Re-plans with an instruction. Invalidates any approval first. |
| **Start** | `POST /runs/:id/start` → `202` | Executes the approved plan. |
| **Retry** | `POST /runs/:id/tasks/:task/retry` | Puts one finished-badly task back in the queue. |
| **Review** | `POST /runs/:id/review` → `202` | Verification, the two reviewers and the Definition of Done — `agent-flow review` as a job. Deck offers it exactly when the run is held at final acceptance. |
| **New feature** | `POST /runs?projectId=` → `202` | `agent-flow feature "<description>"`. The run is created before the response, with its Git identity and the same preflight the CLI runs; planning proceeds as a job whose id the response carries. A preflight refusal — a dirty tree, an uninitialised project — answers `409` with the CLI's own sentence, and no run is created. |

Which of them are offered depends on where the run is. A Start button on an unapproved
plan is a button whose only outcome is a refusal, and offering it teaches people to
ignore the gate rather than to use it.

### The approval gate

The modal shows the review verdict, its findings, the degradations the run collected,
the plan hash and the SDD digest — and the hash is the server's, computed from the plan
on disk for this modal.

**The approve request carries no hash.** The use case reads the plan and hashes it
itself, so there is no version of this call that approves a plan the reader did not
see. An E2E test asserts the absence on the wire, because it is the kind of thing a
future convenience would add back.

Refusals are the server's, not the button's. When the gate says no, `Approve` is
disabled — unless the server also says the refusal is *forcible*, and then the button
says what forcing means and requires a separate deliberate act. Forcing is recorded on
the run as a degradation, so a gate opened that way never looks like one that passed.

### Start and revise are jobs

Both spawn runner processes and take minutes against a real CLI, so the endpoint
answers `202` with a job id and the work proceeds. `202` means *asked*, not *will
succeed*: the gates are checked inside the use case, so a refusal comes back through
the job rather than through the response.

Progress arrives through the event stream, because `state.json` changing is what
progress *is*. There is no second channel reporting it.

### What it cannot change

- **`pause`, `resume`, `cancel`** — not implemented. The core has no semantics for any
  of the three: there is no paused or cancelled run status, and the scheduler has no
  way to be interrupted between tasks. See
  [`pause-resume-cancel-design.md`](pause-resume-cancel-design.md).
- **Configuration** — `/settings` reads. Writing a merged value back means deciding
  which of three layers it belongs in, and a page that guessed would move a project's
  override into the global file, silently changing every other project on the machine.
  See [`config-write-design.md`](config-write-design.md).
- **Adding a project** — the button exists, disabled, because §68 lists it. Adding one
  means writing to the registry.

### What an isolated run shows

Runs created in **worktree mode** carry facts a sequential run does not have, and the
dashboard renders them:

| On screen | What it means |
|---|---|
| the isolation mode | whether this run puts each attempt in its own worktree, or shares your checkout. Fixed when the run was created and never re-read. |
| **Tasks at once** | requested and effective concurrency. When they differ, the reason is beside them — a sequential run says `1 of 2` and explains that task workspace isolation is off, rather than showing a number nobody can account for. |
| `in worktree` | this task has a live workspace right now: an agent is inside it. |
| awaiting integration | validated, marked, and not yet merged. `completed` means merged, so this is the state between the two. |
| the integration branch and how much of the plan is on it | the run's product, and its progress. |
| a conflict, with its paths | which task could not be merged, which paths collided, and which sibling integrated first and moved the head. |
| attempt number | which attempt a task is on, so a retry is visible as a retry. |

**The constraint these land under is structural rather than a rule somebody follows.**
The browser gets ids and rendered facts — never a worktree path, a ref, or a branch name
it could send back. Conflict paths are repository-relative, which is exactly why they may
be shown. No request contract has a ref-shaped or path-shaped field, and an architecture
test asserts it in both directions; the attempt artifact stores a workspace-relative path
precisely so the absolute one is structurally unavailable to expose.

---

## Staying current

A server-sent event stream, at `GET /api/v1/events`, filtered by project when one is
selected. Run, stage, task, approval, runner-health and job events invalidate exactly
the queries they affect.

**Polling is the fallback, never the default.** A dashboard that polls every ten
seconds looks live until you watch a task finish and count to nine. When the stream
errors, the footer says `Reconnecting — polling` and a ten-second invalidation covers
the gap; when it reopens, polling stops. The footer distinguishes the three states,
because a stream that silently died and a run that is simply idle look identical on
screen and only one of those is worth telling somebody about.

---

## The API

Read:

```
GET /api/v1/health
GET /api/v1/projects
GET /api/v1/runs                                  ?projectId
GET /api/v1/runs/:runId                           ?projectId
GET /api/v1/runs/:runId/stages
GET /api/v1/runs/:runId/tasks
GET /api/v1/runs/:runId/dag
GET /api/v1/runs/:runId/tasks/:taskId
GET /api/v1/runs/:runId/artifacts
GET /api/v1/runs/:runId/artifacts/:artifact
GET /api/v1/runs/:runId/events                    the audit log in bulk, oldest first, capped and saying so
GET /api/v1/runs/:runId/telemetry
GET /api/v1/runs/:runId/collaboration
GET /api/v1/runs/:runId/approval
GET /api/v1/runs/:runId/job
GET /api/v1/jobs/:jobId
GET /api/v1/runners
GET /api/v1/runners/health
GET /api/v1/agents
GET /api/v1/config
GET /api/v1/prompts
GET /api/v1/prompts/:prompt
GET /api/v1/analytics                             ?projectId&limit
GET /api/v1/events                                ?projectId&runId   (SSE)
```

Write:

```
POST /api/v1/runs/:runId/approve                  { force? }
POST /api/v1/runs/:runId/reject                   { reason? }
POST /api/v1/runs/:runId/revise                   { instruction }    → 202
POST /api/v1/runs/:runId/start                    { taskId? }        → 202
POST /api/v1/runs/:runId/review                   { fix? }           → 202   verification, both reviewers, the Definition of Done
POST /api/v1/runs                        ?projectId  { description, workflow?, skipReview?, noCache? } → 202   a new run, planned as a job
POST /api/v1/runs/:runId/tasks/:taskId/retry      { force? }
```

Every route names a project by **id**. No request body carries a path, a shell command,
a runner executable or a plan hash — and an architecture test reads the request
contracts to keep that true.

A refusal is structured: a machine-readable `error` code, a message in the words a
person needs, and the next step. `404` for something that does not exist, `400` for a
malformed request, `409` for a request that was well formed and a workflow that said
no. Never a stack trace.

---

## What the agents said

`GET /runs/:runId/collaboration` returns threads, handoffs, blackboard entries and the
run's roster in **one** response. One rather than four, because a thread's status and an
entry's status are folds over the same two logs and have to be read at one instant: four
calls would let a repaint show a thread as open beside the entry that closed it.

Every answer comes out of the same projections the *prompt* was built from. Nothing in the
browser folds a log or decides a status — a component that re-derived one would be the one
that drifts, because the real answer is not on screen.

The panel shares the **Team** tab, and it is **not rendered at all** when there is nothing
in it — nor is the tab, when neither it nor the team has anything to say. Team comes first
there because it answers "who is doing this", which is the context that makes an open
thread legible: "executor.normal is blocked" reads differently once the screen has said
which member that is. A project that has not enabled collaboration sees exactly what it saw
before M4; an always-empty box for a feature that ships off would be on every dashboard
forever.

Bounded like `Artifacts` already was — the top few of each section, with the footer
carrying the totals — and ordered by what nothing mechanical settles:

1. **contested entries**, with both claims side by side. Two agents disagree and no code
   decides it; this is the one thing on the panel that is waiting for a person.
2. **unanswered handoffs** — a task waiting on somebody's attention.
3. **unresolved threads**, each with its latest message.
4. **live blackboard entries**.

A resolved conversation and a superseded entry are history, and history belongs in the log
rather than in the row somebody reads before deciding whether the run can move on.

Message bodies render as **text, never as markup**. A body is written by a model, and
rendering it as anything else would make a peer's output part of this page's DOM.

`enabled` and "anything was said" are reported separately, and the empty state depends on
which: *off* invites the operator to turn it on, and *on, and quiet* does not.

---

## What the reviewer found

`GET /runs/:runId/review` returns the review threads, their findings, the quality gates and
the unsatisfied ones in **one** response, for the reason the collaboration endpoint does:
a finding's status and a gate's verdict are folds over the same logs, and two calls would
let a repaint show a change as approved beside the gate that blocks it.

**The browser derives nothing here, and one of these regressed once.** `assessReviewFreshness`
lived in `apps/web` and decided staleness in the browser — a rule the charter forbids by
name — so it moved to the core and what remains under `apps/web` turns an answer into a
label. Architecture rules now forbid the dashboard from defining `decideQuality`,
`blockingFindings`, `projectFindings` or their neighbours, from folding a gate list into a
boolean, and from reducing a findings array into a status. `unsatisfiedGates` arrives from
the server precisely so nothing recomputes it.

Like the collaboration panel, it is **absent** rather than empty when a run has no
reviewer — and so is its tab. Most runs have none, and a permanent empty box teaches people
to skip the row it lives in.

What it shows, in the order that matters:

1. **the unsatisfied required gates**, above everything, with the reason each one is
   unsatisfied. A required gate that did not run is not a gate that passed, and it must not
   read as a detail.
2. **one row per reviewed change** — its status in words, a stale badge when the tree moved
   under it, the count of what is still open, and the reviewer with its independence.
3. **every gate**, including the ones that did not apply.
4. **a footer** with the totals.

A row expands to its findings: severity, id, category, the file and line, the corrective
task when one exists, and — when the change is blocked — the *reason* rather than the name
of the condition. That last distinction was a real defect: the panel rendered condition
names, so a change blocked by an open finding displayed the line "no blocking finding is
open", which reads as its own opposite.

`failed` and `not run` render in the same red and that is deliberate: the colour carries
the consequence, because both block, and the word carries the cause. `not applicable` is
grey, because it does not block. Status is always in words as well as colour.

---

## Where the run went

`GET /runs/:runId/delivery` returns the delivery projection: repository, published branch
and commit, issue, pull request, checks, last sync, and any delivery failure — folded on
the server, rendered here.

**Read-only and credential-free.** The projection folds a file this machine already wrote,
so the dashboard can answer "where did this run go" without the server ever holding a
token. Every *write* to a forge stays behind the CLI, which is where an operator is.

**It rendered as unstyled HTML for two milestones, and no gate could see it.** The panel
was written against ten class names — `card`, `card__header`, `delivery__facts`,
`delivery__checks`, `badge--delivery-published` and their neighbours — that no stylesheet
in this repository defines and that are not Tailwind utilities either. An unstyled heading,
a `<dl>` with browser default margins, a bulleted list, inside an app where every other
panel is a `Panel`. Nothing was going to catch it: a class nobody writes down fails no
compiler, no linter and no DOM assertion, because the element is there and simply has no
style. And the only delivery fixture in the repository was `DELIVERY_NONE`, whose state is
`disabled`, so the component's own guard returned `null` in every unit test and in all 296
visual baselines. **A component no fixture renders is a component with no guaranteed
appearance.** M8.5 rebuilt it on the design system, gave it a fixture that publishes, and
photographed it. The first photograph immediately found a second defect the tests could not:
`Last sync` was printing a raw ISO string, the only unformatted date anywhere in the app.

The `ForgeFailure` on the projection is drawn now too, and never was. A run whose
publication was refused for want of a token showed the state and never the reason.

The panel — and its tab — is **absent** rather than empty when no forge is configured,
which is most runs. It shows the delivery state in words, the facts underneath, and — when
checks exist — the sentence that has to be on the page:

> These are observations. The local quality decision is already made, and a check here does
> not change it in either direction.

A person who sees red and nothing else concludes the run failed. It did not, and the panel
says so where they are looking rather than in a document. `checks_red` is marked `!` and
never `✗`, because the mark a reader associates with a failed run would say the wrong thing
before the words got a chance.

The browser derives none of it. An architecture rule forbids `projectDelivery` from being
defined under `apps/web`, for the reason the review panel already learned: a browser that
folded a check list into a verdict would disagree with the server the first time the
treatment of an unknown conclusion changed, and the disagreement would look like a caching
bug rather than a second authority.

---

## Flags

| | |
|---|---|
| `--port <n>` | Default 4782. |
| `--host <addr>` | Default `127.0.0.1`. Anything else prints a warning, because this server has no authentication. |
| `--no-open` | Do not open a browser. |
| `--depth <n>` | Override `ui.workspaceDepth` for this run. |

If the dashboard bundle has not been built, the command says so and serves the API
alone rather than a blank page. In a development checkout: `npm run build:web`.
