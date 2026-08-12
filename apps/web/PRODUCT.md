# Product

<!-- impeccable:product-schema 1 -->

Scope: the Agent Flow **dashboard** (`@agent-flow/web`), treated as its own product.
The CLI and the orchestration core are context, not subject.

## Platform

web

## Users

**One developer, on their own machine, who already drives AI coding CLIs.**

They have Claude Code and/or Codex CLI installed and logged in, they run
`agent-flow` in a terminal, and they open the dashboard *beside* that terminal —
not instead of it. The terminal is where work is started; the dashboard is where
a run is read and where a gate is passed.

Situation when the dashboard is open:

- A run is mid-flight and they want to see which stage and which task is moving.
- A plan is waiting at the approval gate and they need to read the SDD, the plan,
  the review verdict and the collected degradations before deciding.
- Something finished badly and they need to find out where, then retry one task.

They may have several initialised repositories under one root, so the same
browser tab is expected to cover more than one project (`agent-flow ui ~/wk`).

No second audience is confirmed. There is no team review handoff, no shared
instance and no external operator: the server is loopback-only and
unauthenticated by design, which makes any multi-person story false today.

## Product Purpose

Make a run **readable and decidable** without leaving the browser, while never
becoming a second source of truth about it.

The dashboard is a view plus five state transitions. Every read comes from the
server; every write calls the same use case the CLI calls. Nothing in the browser
holds a copy of a run's state, so no screen can be wrong about what a click did —
it either happened on disk or it did not.

**Success is the owner trusting it in daily use.** It is an internal tool: npm
publication is optional and external adoption is not the metric. What counts is
that a decision made here is a decision they would defend, and that reading the
dashboard is faster than reading `state.json`.

## Positioning

**The approval gate is bound to the plan on disk, not to what the screen showed.**

The approve request carries no plan hash. The use case reads the plan and hashes
it itself, so there is no version of that call that approves a plan the reader
did not see. An E2E test asserts the hash's absence on the wire, because it is
exactly the kind of thing a future convenience would add back.

The rest of the boundary follows from the same stance: no request body carries a
path, a shell command, a runner executable or a plan hash, and an architecture
test reads the request contracts to keep that true. Everything is local — run
state, artifacts, the audit trail, the dashboard. No cloud control plane, no
telemetry upload, no API key.

A neighbouring dashboard could copy the screens. It could not truthfully copy
"the browser cannot name a path, cannot name a command, and cannot assert which
plan it approved."

## Operating Context

- Served at `http://127.0.0.1:4782` by `agent-flow ui`. Loopback default; any
  other `--host` prints a warning, because there is no authentication.
- **Two modes.** `agent-flow ui` scopes to the current directory; `agent-flow ui
  <dir>` registers every initialised repository under that root. A project is a
  directory with `.agent-flow/config.yaml`. The root is chosen once, when the
  server starts.
- Discovery is bounded (`ui.workspaceDepth`, default 2, max 6) and never leaves
  the root: a symlink pointing outside is skipped *and named*, on startup and on
  the Projects page.
- Lives **next to a terminal**, open for long stretches, often while a
  long-running agent process writes to the same repository.
- **Freshness is a product concern, not plumbing.** A server-sent stream at
  `GET /api/v1/events` invalidates exactly the queries each event affects. When
  it errors, the footer says `Reconnecting — polling` and a ten-second
  invalidation covers the gap; when it reopens, polling stops. The footer
  distinguishes live, degraded and idle, because a dead stream and a quiet run
  look identical on screen and only one is worth telling somebody about.
- Run ids restart at `001` per project per year (`AF-2026-001`), so two
  repositories initialised the same year collide. Every link to a run therefore
  carries its project.
- URL-borne state: `?project=<id>` and `?view=dag`. A reload, a bookmark and a
  shared link all have to mean the same thing.

### Vocabulary

`run`, `stage`, `task`, `artifact`, `gate` / `approval`, `plan hash`,
`SDD digest`, `degradation` (a recorded compromise, e.g. a forced gate),
`runner` (an installed CLI adapter), `role` (one of nine logical roles:
`architect`, `sdd`, `planner`, `planReviewer`, three `executors`,
`verification`, `finalReviewer`), `project registry`, `workspace mode`, `job`
(a `202`-accepted background transition).

## Capabilities and Constraints

**Eight routes:** `/dashboard` (the run most likely to want you — executing,
then waiting at a gate, then most recent; same component as run detail),
`/runs` (history, filters local), `/runs/:runId` (pipeline, tasks, inspector,
artifacts, approval, execution summary, model usage), `/projects` (registry plus
runner health for the selected project), `/agents` (read-only: what each role
would run, and which cannot be resolved), `/prompts` (read-only: what this
installation ships), `/analytics` (duration per stage, model usage, outcomes),
`/settings` (read-only: effective config, sectioned, with each value's origin).

**Five write transitions,** each a call into the CLI's use case: approve, reject,
revise (`202`), start (`202`), retry one task. Which are offered depends on where
the run is — a Start button on an unapproved plan is a control whose only outcome
is a refusal, and offering it teaches people to ignore the gate.

**Refusals belong to the server.** Structured: a machine-readable `error` code, a
message in the words a person needs, and the next step. `404` absent, `400`
malformed, `409` well-formed request that the workflow declined. Never a stack
trace. When the gate says no, `Approve` is disabled — unless the server also
says the refusal is *forcible*, and then the button states what forcing means and
requires a separate deliberate act, recorded on the run as a degradation.

**`202` means asked, not will succeed.** Start and revise spawn runner processes
that take minutes; gates are re-checked inside the use case, so a refusal returns
through the job, not the response. Progress arrives only through the event
stream, because `state.json` changing is what progress *is*.

**The DAG is a second rendering, not a page.** Same task list, same filter, same
selection. Structure comes from the server (`core/dag`, the scheduler's own); the
browser lays out what it is given and never recomputes what may run. A filter
*dims* rather than removes — a vanished node takes its edges with it, and a chain
with a hole describes a dependency that does not exist. Cycles and dangling
dependencies are reported above the canvas with the rest of the graph still
drawn.

**What it deliberately cannot do:**

- `pause` / `resume` / `cancel` — the core has no semantics for any of them
  (`docs/pause-resume-cancel-design.md`).
- Write configuration — a merged value has three possible layers, and a page
  that guessed would silently move a project override into the global file
  (`docs/config-write-design.md`).
- Add a project — the control exists, disabled; adding one means writing the
  registry.
- No authentication, no multi-user, no remote access.

**Other constraints:** English-only interface, no i18n layer. If the bundle was
never built, the command says so and serves the API alone rather than a blank
page. Undecided: whether any of the three missing transitions ever ships.

## Brand Commitments

- Name: **Agent Flow**. Token prefix `--af-`, CSS class prefix `af-`.
- **The documentation's voice is binding, and it is the product's voice.**
  Declarative, unhedged, and unusually willing to state what the thing does
  *not* do and why. Copy in the interface is held to the same standard: name the
  refusal, name the next step, never soften a limitation into a maybe.
- The interface is in English, matching the codebase and `README.md`.
- Licence MIT; `v0.1.0`; not published to npm.

## Evidence on Hand

Real, in the repository:

- `docs/assets/agent-flow-ui-reference.png` — the visual reference the current
  tokens were calibrated against.
- `docs/web-ui.md` — the dashboard's own product documentation: modes, pages,
  DAG, event stream, every HTTP route, flags.
- `docs/security.md`, `docs/testing.md`, `docs/troubleshooting.md`,
  `docs/runner-capabilities.md`, `docs/engineering/findings.md` (including what
  is still unsolved), `docs/specs/`.
- Proof layers that already exist: 16 Playwright E2E scenarios crossing browser →
  Fastify → application services → filesystem with no stubs; visual regression
  baselines pinned to a container image; packaging smoke tests that run the
  binary outside the checkout with `apps/web/dist` renamed away.

**Absences that must not be fabricated:** no external users, no testimonials, no
case studies, no press, no adoption or performance benchmarks, no pricing or
plans, no hosted or cloud offering, no npm publication. There is no logo file and
no photography.

## Product Principles

1. **The screen is never a second source of truth.** Every write goes through the
   use case the CLI uses; nothing about a run is decided in the browser.
2. **Never offer a control whose only outcome is a refusal.** Availability is
   derived from where the run actually is, and forcing is a separate, recorded
   act.
3. **The health of the connection is information the user is owed.** Live,
   degraded and idle must be distinguishable without watching a task and
   counting.
4. **A limitation stated plainly beats a limitation discovered.** What the
   dashboard cannot do is documented, and refused actions explain themselves in
   a person's words with a next step.
5. **Coexist with the terminal; do not compete with it.** This surface is open
   for hours alongside other windows, and its job is to be scannable at a glance
   and quiet when nothing is happening. (How that becomes visual is DESIGN's
   call, not this file's.)

## Accessibility & Inclusion

No product-specific standard has been established — **undecided**, deliberately
recorded rather than invented.

What exists factually today: a global `:focus-visible` treatment; status conveyed
as icon plus text rather than colour alone; `prefers-reduced-motion: reduce`
honoured for every animation and transition in the app, which is safe precisely
because no status depends on its animation to be legible; ARIA semantics inherited
from the Radix primitives in use (dialog, dropdown, progress, tabs, tooltip);
explicit ARIA on the shell and shared components; and focusable DAG nodes with
their full status in the accessible name.

Still absent: a declared WCAG target and a light-mode alternative.
