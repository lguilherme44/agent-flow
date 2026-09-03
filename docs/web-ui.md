# The local dashboard

```bash
agent-flow ui              # this project
agent-flow ui ~/wk         # every initialised repository under ~/wk
```

Serves `http://127.0.0.1:4782`. Loopback, no authentication, no cloud — see
[`security.md`](security.md) for what that does and does not protect.

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
| `/dashboard` | The run most likely to want you: executing, then waiting at a gate, then most recent. Renders the same component `/runs/:runId` does. |
| `/runs` | History. Filters are local — narrowing the list costs no round trip. |
| `/runs/:runId` | One run: pipeline, tasks, inspector, artifacts, approval, execution summary, model usage — and, when the agents spoke, what they said. |
| `/projects` | The registry, with each project's current run and — once one is selected — its runner health. |
| `/agents` | What each of the nine logical roles would run, and which cannot be resolved. Read-only. |
| `/prompts` | The prompts this installation ships. They belong to the installation, not to a repository. |
| `/analytics` | Aggregates over recent runs: duration per stage, model usage, outcomes. |
| `/settings` | The effective configuration, sectioned, with the origin of every value. Read-only. |

Two search parameters carry state that belongs in a URL rather than in a component:

- `?project=<id>` — which project you are looking at. A reload, a bookmark and a link
  all mean the same thing. Switching leaves the run behind, because a run id belongs to
  one project.
- `?view=dag` — the graph instead of the table.

Run ids restart at 001 per project per year, so two repositories initialised in the
same year both hold `AF-2026-001`. Every link to a run carries its project for exactly
that reason.

---

## The dependency graph

The **View as DAG** toggle draws the plan's edges. It is a second rendering of the same
task list — same filter, same selection — not a separate page, so switching does not
lose your place.

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

The panel is a second row under the four bottom cards, and it is **not rendered at all**
when there is nothing in it. A project that has not enabled collaboration sees exactly the
row it saw before M4; an always-empty fifth card for a feature that ships off would be a
box on every dashboard forever.

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

Like the collaboration panel, the card is **absent** rather than empty when a run has no
reviewer. Most runs have none, and a permanent empty box teaches people to skip the row.

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

The card is **absent** rather than empty when no forge is configured, which is most runs.
It shows the delivery state in words, the facts underneath, and — when checks exist — the
sentence that has to be on the page:

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
