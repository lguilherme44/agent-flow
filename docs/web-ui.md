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
| `/runs/:runId` | One run: pipeline, tasks, inspector, artifacts, approval, execution summary, model usage. |
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

## Flags

| | |
|---|---|
| `--port <n>` | Default 4782. |
| `--host <addr>` | Default `127.0.0.1`. Anything else prints a warning, because this server has no authentication. |
| `--no-open` | Do not open a browser. |
| `--depth <n>` | Override `ui.workspaceDepth` for this run. |

If the dashboard bundle has not been built, the command says so and serves the API
alone rather than a blank page. In a development checkout: `npm run build:web`.
