# Agent Flow

**English** · [Português (BR)](README.pt-BR.md)

[![CI](https://github.com/lguilherme44/agent-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/lguilherme44/agent-flow/actions/workflows/ci.yml)

**Local-first orchestration for AI coding agents.**

Agent Flow turns a feature request into a reviewed design document, a task
breakdown and a human approval gate — and only then into code. It drives the
coding CLIs you already have installed and logged into; nothing here talks to a
model API.

```text
feature request
  → discovery
  → architecture analysis
  → SDD
  → planning
  → independent plan review
  → human approval          ← bound to one exact plan hash
  → implementation
  → deterministic validation ← run by the orchestrator, never by an agent
  → final review
  → Definition of Done
```

The core knows nothing about Claude Code or Codex, and nothing about your
framework. Roles are logical (`architect`, `sdd`, `planner`, `planReviewer`,
three `executors`, `verification`, `finalReviewer`); configuration decides which
runner and which effort level serves each one. Claude Code and Codex are the two
adapters that exist today.

Everything is local: run state, artifacts, the audit trail and the dashboard.
There is no cloud control plane, no telemetry upload and no API key.

**Status:** `v0.1.0` · Spec v3 complete · not published to npm.
See [Status](#status) for the full picture.

---

## Requirements

- Node 20+
- git
- At least one agent CLI, installed and logged in:
  [Claude Code](https://claude.com/claude-code) · [Codex CLI](https://github.com/openai/codex)

**No API keys.** Agent Flow invokes the CLIs you have already authenticated. It
never reads, stores or transmits credentials. If a CLI works in your terminal,
it works here.

---

## Install

Not on npm. Install from a checkout — the package is built, packed and verified
to work outside one, so this is the same artifact a publish would produce:

```bash
git clone https://github.com/lguilherme44/agent-flow
cd agent-flow

npm install
npm run build
npm run build:web

npm install -g "$(npm pack | tail -1)"
```

## Quick start

```bash
cd ~/my-project

agent-flow init          # detect the stack, read your real scripts
agent-flow doctor        # can this environment work?

agent-flow feature "Add recurring bookings"
agent-flow status        # read the SDD and the plan
agent-flow approve       # the gate — bound to this plan, not the next one
agent-flow run
agent-flow review

agent-flow ui            # the local dashboard on 127.0.0.1:4782
```

One dashboard over several repositories:

```bash
agent-flow ui ~/wk
```

---

## Documentation

**Product**

| | |
|---|---|
| [`docs/web-ui.md`](docs/web-ui.md) | The dashboard: the two modes, the pages, the DAG, live events, what it can change and what it cannot, the HTTP API |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | What a message means and what to do about it |

**Architecture & engineering**

| | |
|---|---|
| [`docs/security.md`](docs/security.md) | The local server's boundary — no path, no command, no plan hash from the browser; symlink containment; the run lock; the limits |
| [`docs/testing.md`](docs/testing.md) | The test layers, what each one proves, and where each one stops |
| [`docs/runner-capabilities.md`](docs/runner-capabilities.md) | What each CLI actually does, with the command that proves it and the version it was probed against |
| [`docs/engineering/findings.md`](docs/engineering/findings.md) | Engineering log: what building this taught us, including what is still unsolved |

**Specification** — what was designed and shipped, kept as written

| | |
|---|---|
| [`docs/specs/implementation-spec-v3.md`](docs/specs/implementation-spec-v3.md) | Implementation Spec v3, complete. A historical document; the code is the current truth |

**Technical reviews** — snapshots, not living documents

| | |
|---|---|
| [`docs/reviews/validation-review.md`](docs/reviews/validation-review.md) | Structured validation review of the first complete implementation |
| [`docs/reviews/reanalysis-post-fixes.md`](docs/reviews/reanalysis-post-fixes.md) | Re-analysis after those fixes landed |

**Designs, not implementations** — written up, deliberately not built

| | |
|---|---|
| [`docs/config-write-design.md`](docs/config-write-design.md) | `PATCH /config`: why scope has to be part of the address |
| [`docs/pause-resume-cancel-design.md`](docs/pause-resume-cancel-design.md) | `pause` / `resume` / `cancel`: the abort signal and the contract change they need |

---

## Why

Handing a feature to a coding agent tends to produce something plausible that
nobody reviewed. Agent Flow puts structure around that:

**Planning is separate from execution.** Each stage runs in a fresh context and
receives only the artifacts it needs, so a wrong assumption cannot travel
silently from discovery to the diff.

**A human decides.** Nothing is implemented until you have read the design
document and the task plan. Approval is bound to a *specific* plan — revise it
and the approval no longer applies.

**A model does not review its own work.** Configure two runners and the planner,
the reviewer and the implementer are different providers. With one runner it
still works, degrades to a same-provider review, and says so on the artifact.

**Fallback is infrastructure, never a fix.** A runner that is out of quota, not
logged in, or missing can be routed around. A model that produced bad output
cannot — retrying that elsewhere would replace a visible failure with a quiet
one. The rule is enforced by the type system.

**Done is decided by code.** Approved, all tasks complete, lint and tests and
build passing, final review PASS. An agent saying "finished" is not one of the
conditions — and in our first real run, that is exactly what caught a bad plan.

---

## Commands

| Command | |
|---|---|
| `init` | Prepare a repository. Detects the stack, reads your real scripts, never overwrites without `--force`. |
| `doctor` | Can this environment work? Reports `OK` / `DEGRADED` / `FAIL`. `--deep` probes each runner for real, which spends quota. |
| `feature "<description>"` | Discovery → impact → SDD → plan → review. Stops at the gate. |
| `status` | Where the run is, what it produced, what is degraded. |
| `approve` | Open the gate. Refuses a failed review unless `--force`. |
| `reject` · `revise "<instruction>"` | Close a run, or re-plan with guidance. |
| `run` · `task TASK-004` · `retry TASK-004` | Execute the approved plan. |
| `review` | Run validation, inspect the code, judge it against the SDD. `--fix` turns findings into tasks and reviews the corrected plan. |
| `ui [root]` | Serve the local dashboard on `127.0.0.1:4782`. With a directory, serves every initialised repository under it as a workspace. Approve, revise, retry and run go through the same use cases this CLI does — see [`docs/web-ui.md`](docs/web-ui.md). |
| `clean` | Remove old run state. Never the active run without `--force`. |

`--dry-run` shows the routing without invoking anything. `--verbose`, `--json`,
`--strict` behave as you would expect.

---

## Configuration

Two files: global holds your preferences, the project file holds what makes this
repository different.

```yaml
# ~/.agent-flow/config.yaml
roles:
  architect:     { runner: claude, effort: high }
  sdd:           { runner: claude, effort: high }
  planner:       { runner: codex,  effort: high }
  planReviewer:  { runner: claude, effort: high }
  executors:
    trivial:     { runner: codex,  effort: low }
    normal:      { runner: codex,  effort: medium }
    complex:     { runner: codex,  effort: high }
  verification:  { runner: codex,  effort: medium }
  finalReviewer: { runner: claude, effort: very_high }

fallback:
  enabled: true
  on: [quota_exceeded, auth_required, runner_unavailable]
```

`model:` is optional on purpose — omit it and each CLI uses the model you already
configured. `effort` is logical (`low` … `very_high`); each adapter translates it.

The three fallback triggers above are the only ones the schema accepts.

```yaml
# <project>/.agent-flow/config.yaml
project: { name: booking-api, type: node }
commands:            # run by Agent Flow, never by an agent
  lint: npm run lint
  test: npm test
rules:
  architecture:
    - "Controllers do not talk to the database directly"
```

`init` fills these from what your repository actually declares. A command it
cannot find is left empty rather than guessed.

---

## What lands where

```text
<project>/.agent-flow/
├── config.yaml           # versioned — a team convention
├── current-run
├── cache/architecture.md # repository map, reused across features
└── runs/AF-2026-001/
    ├── state.json
    ├── events.jsonl      # append-only audit trail
    ├── sdd.md
    ├── plan.json
    ├── reviews/ tasks/ logs/
```

Everything with content lives inside a run, so two features in flight cannot
overwrite each other. Task results record the runner, model and effort that
actually served the call, not the ones the configuration asked for.

---

## Status

```text
version:   v0.1.0
Spec v3:   complete
npm:       not published
MVP 2:     not started
```

Implementation Spec v3 is finished: the CLI workflow, the local Web Control
Plane and their test gates are all in. There is no GitHub release and no npm
package yet — the install instructions above are the only supported path.

The Vitest suite invokes no CLI: every runner is faked, so it costs nothing to
run and proves nothing about the CLIs themselves. What it does prove is in
[`docs/engineering/findings.md`](docs/engineering/findings.md) — as is what it
does not. The badge above is the current result; a number written here would not
be current for long.

### Working

- [x] CLI, config resolution, logical roles, reasoning abstraction
- [x] `ClaudeCodeRunner`, `CodexRunner`, capability model, error normalisation
- [x] Fallback restricted to infrastructure failures, enforced by the type system
- [x] `doctor` with ternary health computed over role routes
- [x] `init` with stack detection for Node, Flutter, Python, Go, Rust
- [x] Discovery → architecture impact → SDD → plan, checkpointed per stage
- [x] Coverage and dependency-graph checks as code, before any reviewer runs
- [x] Cross-provider plan review, with independence recorded on the artifact
- [x] Approval gate bound to a plan hash
- [x] Deterministic router, DAG scheduler, task executor, resume and retry
- [x] Verification commands run by the orchestrator, not by an agent
- [x] Final review and Definition of Done evaluated as code
- [x] `review --fix` — findings become tasks in the plan and re-enter the pipeline
- [x] Corrective rounds reviewed in their own right, so the loop needs no `--force`
- [x] `doctor --deep` — live probe per runner, folded back into the verdict
- [x] Local telemetry, derived from the run's own state and event log
- [x] `agent-flow ui` — local server and dashboard (spec §59–§102)
- [x] Seven pages over eight routes — run detail, runs, projects, agents & models,
      prompts, analytics, settings; `/dashboard` renders the run-detail view for
      whichever run wants you most
- [x] Live updates over SSE, with polling as the documented fallback rather than the
      default
- [x] Write actions — approve, reject, revise, retry, start — as one set of use cases
      the CLI and the HTTP API are both adapters over
- [x] Inter-process run lock: the CLI and the local server cannot schedule the same
      run at once, proved with eight real processes racing one lock file — and with an
      opt-in stress run of 640 (`AF_LOCK_STRESS=1`), because a race is a test that has
      to pass often rather than once
- [x] Dependency graph — the plan's edges, ranked and drawn by the server's answer,
      never rebuilt in the browser
- [x] Workspace mode — `agent-flow ui ~/wk` serves several projects, bounded by
      `ui.workspaceDepth`, and discovers nothing that resolves outside the root
- [x] Empty, error and degraded states — what happened, where, whether the run
      stopped, and what to do about it
- [x] Deterministic browser E2E — sixteen scenarios across the real local server,
      stubbing nothing; the coding CLI is replaced at the executable boundary, so no
      quota is spent and both real adapters still parse the output
- [x] Screenshot regression in CI, on Linux baselines, in a pinned container — and
      a suite that cannot adopt a stale preview
- [x] Cross-platform workspace containment, with the Windows rules asserted on Linux
- [x] Packaging proved outside the checkout: `npm pack`, a clean install into a
      throwaway prefix, and the packaged server driven with the checkout's own bundle
      renamed away — plus a black-box browser journey through the installed tarball

### Designed, not built

- [ ] `PATCH /config` — designed in
      [`docs/config-write-design.md`](docs/config-write-design.md), not built.
      Scope has to be part of the address, or a save silently edits the wrong layer
- [ ] `pause`, `resume`, `cancel` — designed in
      [`docs/pause-resume-cancel-design.md`](docs/pause-resume-cancel-design.md),
      not built. Pause needs an abort signal the scheduler checks between tasks;
      cancel needs a new terminal run status and is a contract change

### Validated end to end, against live CLIs

One Node and one Python repository have run the whole workflow — plan,
cross-provider review, approval, implementation, verification, final review,
Definition of Done. The Python run reached `FEATURE COMPLETE` after a
corrective round: the final review rejected it, `--fix` turned the findings
into tasks, and the tests those tasks produced kill the corresponding mutations.
[Findings §10–§13](docs/engineering/findings.md) records what that surfaced,
including a defect where the prompt could set the runner's error code.

### Not yet validated

- [ ] Flutter, Go or Rust repositories (stack detection is unit-tested only)
- [ ] Fallback and reasoning clamping against a live CLI
- [ ] Cost across models and repository sizes
- [ ] Windows. Path containment now uses `node:path` and its Windows rules are
      asserted with `path.win32`, but no CI job runs there and the process timeout
      still cannot signal a process tree on that platform

### Known limitations

Not a roadmap — what is true today.

- **No `pause`, `resume` or `cancel`.** The core has no semantics for any of them.
- **No configuration writes.** `/settings` reads. Deciding which of three layers a
  value belongs in is the whole problem.
- **Local only.** Loopback by default, no authentication, no cloud control plane, no
  remote auth. Anyone who can reach the port can approve a plan and start a run.
- **Not on npm.** No published package and no GitHub release; install from a checkout.
- **No Windows CI job**, and on Windows the process timeout cannot signal a process
  tree, so a CLI that spawns children can outlive its timeout.
- **Visual baselines are per platform.** darwin and Linux sets are both committed and
  never compared against each other; font rasterisation differs.
- **A lock claim can be unreadable under contention.** Mutual exclusion is unaffected,
  but the refusal then says the claim could not be read rather than naming who holds
  it. Deferred deliberately — see
  [`docs/engineering/findings.md`](docs/engineering/findings.md).

### Known defects — validation review

A structured review of the first complete implementation confirmed 17 findings.
All twelve code-level defects are fixed; each reproduction was inverted and moved
into the suite of the feature it belongs to. The review itself is kept as written,
in [`docs/reviews/validation-review.md`](docs/reviews/validation-review.md), with
the re-analysis in
[`docs/reviews/reanalysis-post-fixes.md`](docs/reviews/reanalysis-post-fixes.md).

- [x] **V-01 · critical** — planner-authored strings reach `/bin/sh -c`; no allowlist → **fixed:** `validation` holds ids resolved against the project config
- [x] **V-09 · high** — the process timeout never fires when the child has children → **fixed:** the child runs in its own process group
- [x] **V-02 · high** — `FallbackRunner` is never constructed at runtime → **fixed:** wired through `runner-factory`, resolving the fallback role's own model and effort
- [x] **V-03 · high** — a task interrupted mid-flight stays `running` forever → **fixed:** recovered as `interrupted` and requeued within the attempt limit
- [x] **V-04 · high** — test-first plans cannot express an expected failure → **fixed:** `validationExpectation: pass | fail | none`
- [x] **V-05 · medium** — `agent-flow task` builds a graph missing its dependencies → **fixed:** the graph stays whole, execution is restricted
- [x] **V-06 · medium** — `result.json` records a hardcoded reasoning level → **fixed:** provenance travels from the runner that actually ran
- [x] **V-07 · medium** — the discovery cache is reused without invalidation → **fixed:** fingerprinted on HEAD, working tree, AGENTS.md and config
- [x] **V-08 · medium** — validation commands run twice, once by the agent → **fixed:** the prompt says Agent Flow owns the run
- [x] **V-10/11/12 · low** — `approvedAt` now recorded, dead prompt role metadata removed, CLI copy corrected

See [Findings §8](docs/engineering/findings.md#8-a-structured-review-found-things-the-build-did-not).

### Next

Not started. Listed so the boundary of Spec v3 is visible, not as a commitment.

- [ ] Git worktrees for task isolation
- [ ] Parallel execution — the scheduler loop takes N; nothing may hand it more
      than 1 until tasks are isolated, so `parallelism.maxTasks` is accepted
      above 1 and capped at 1 at runtime
- [ ] Model escalation after repeated failure
- [ ] Monorepo workspaces

---

## What building this taught us

[`docs/engineering/findings.md`](docs/engineering/findings.md) documents what
driving coding CLIs from a program actually involves — including the problems
still unsolved. Short version:

- Every CLI has its own dialect of JSON Schema, and they are mutually incompatible
- Neither CLI validates its reasoning-level flag; a wrong mapping is invisible
- Text-matching on model output will eventually misclassify a success as a failure
- Read-only mode is real, but "read-only" does not mean "writes nothing anywhere"
- A modal Radix dialog restores focus to a `Dialog.Trigger` and to nothing at all
  when there is none — every dialog here supplies its own focus return

[`docs/runner-capabilities.md`](docs/runner-capabilities.md) records what each
CLI actually does, with the command that proves each claim and the version it
was probed against.

---

## Development

```bash
npm install
npm run build          # the CLI bundle
npm run build:web      # the dashboard bundle
npm run check          # typecheck + lint + Vitest + dashboard unit tests

npm run dev:web        # dashboard against a running `agent-flow ui`
```

Once built, the CLI runs from the checkout as `node dist/bin/agent-flow.js`, or
`npm link` it and use `agent-flow` as documented above.

Three further test layers, answering three different questions — and none of them
is a cheaper version of another:

```bash
npm run test:e2e                # Playwright, through the real local server
npm run test:visual             # Playwright, screenshots (this platform's baselines)
npm run test:packaging          # pack, install elsewhere, drive the installed product
npm run test:packaging:browser  # the same, through gsd-browser
```

[`docs/testing.md`](docs/testing.md) explains what each one can and cannot prove,
including why the gsd-browser smoke does not replace Playwright and why it runs
locally rather than in CI.

No suite invokes a real CLI. Runners are exercised through a scripted
`AgentRunner`; the adapters are tested by asserting the exact argv they build and
by parsing recorded tool output — the two cases that could not be provoked on
demand are labelled `SYNTHETIC-` in `test/fixtures/`. That is what keeps the suite
fast, free and runnable in CI.

Architectural rules are executable (`test/architecture.test.ts`):

- `src/core/` imports no Node built-ins and no adapters
- `src/core/` mentions no provider, model or CLI name
- no framework name appears in `src/` outside stack detection
- topological ordering exists in exactly one module
- the core side never imports the server; the server never imports the CLI
- no server module names an auth file or reads the environment
- no request contract accepts a filesystem path, a command or a plan hash
- there is one project registry and one run execution lock
- no browser E2E intercepts `/api/**`

The dashboard's layout is checked by screenshot against
[`docs/assets/agent-flow-ui-reference.png`](docs/assets/agent-flow-ui-reference.png),
at 1440, 1280, 1200 and 1024 — the last two being the sides of the boundary where
the inspector stops sharing the row with the table and becomes a drawer. Stubbed
API, pinned clock, fixed locale and timezone.

Baselines are per platform, because font rasterisation is: `desktop-1440-darwin`
comes from a maintainer's machine, `desktop-1440-linux` from the pinned Playwright
container CI compares in. Regenerate the Linux set only in that container:

```bash
npm run test:visual:linux    # docker, pinned image
npm run test:visual:update   # this platform
```

CI runs `check` on Node 20 and 22, the browser E2E and the screenshot suite in the
pinned container, and coverage as a report rather than a gate. The packaging smokes
run locally.

---

## Containment

Read-only stages run under the runner's own sandbox — `--permission-mode plan`
for Claude Code, `-s read-only` for Codex. Agent Flow never passes the flags
that disable them.

Being precise about the limit: Agent Flow spawns a CLI as a child process and
cannot intercept what that process runs. The containment is the runner's, not
ours. Anything stronger needs a container.

[`docs/security.md`](docs/security.md) covers the local server: why the browser
never sends a path, a command or a plan hash, how symlink containment works, and
what having no authentication does and does not mean.

---

## License

MIT — see [`LICENSE`](LICENSE).
