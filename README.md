# Agent Flow

**English** · [Português (BR)](README.pt-BR.md)

[![CI](https://github.com/lguilherme44/agent-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/lguilherme44/agent-flow/actions/workflows/ci.yml)

Turn a feature request into a reviewed design document, a task breakdown, a
human approval gate — and only then code.

Agent Flow orchestrates the coding CLIs you already have installed and logged
into. It knows nothing about Claude Code or Codex in its core, and nothing about
your framework. Roles are logical; configuration decides who runs them.

```bash
npm install -g agent-flow

cd ~/your-project
agent-flow init
agent-flow doctor

agent-flow feature "Allow bookings to repeat weekly"
agent-flow status      # read the SDD and the plan
agent-flow approve
agent-flow run
agent-flow review
```

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

## Requirements

- Node 20+
- git
- At least one agent CLI, installed and logged in:
  [Claude Code](https://claude.com/claude-code) · [Codex CLI](https://github.com/openai/codex)

**No API keys.** Agent Flow invokes the CLIs you have already authenticated. It
never reads, stores or transmits credentials. If a CLI works in your terminal,
it works here.

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
| `ui [root]` | Serve the local dashboard on `127.0.0.1:4782`. With a directory, serves every initialised repository under it as a workspace. Approve, revise, retry and run go through the same use cases this CLI does. |
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

```
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
overwrite each other.

---

## Status

MVP 1 is complete and has been run end to end against Claude Code and Codex.
The suite invokes no CLI: every runner is faked, so it costs nothing to run and
proves nothing about the CLIs themselves. What it does prove is in `FINDINGS.md`
— as is what it does not. The badge above is the current count and the current
result; a number written here would be neither for long.

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
- [x] Seven pages: run detail, runs, projects, agents & models, prompts, analytics, settings
- [x] Write actions — approve, reject, revise, retry, start — as one set of use cases
      the CLI and the HTTP API are both adapters over
- [x] Inter-process run lock: the CLI and the local server cannot schedule the same
      run at once, proved with eight real processes racing one lock file — and with an
      opt-in stress run of 640 (`AF_LOCK_STRESS=1`), because a race is a test that has
      to pass often rather than once
- [x] Dashboard layout checked by screenshot at 1440, 1280, 1200 and 1024
- [x] Dependency graph — the plan's edges, ranked and drawn by the server's answer,
      never rebuilt in the browser
- [x] Workspace mode — `agent-flow ui ~/wk` serves several projects, bounded by
      `ui.workspaceDepth`, and discovers nothing that resolves outside the root
- [x] Empty, error and degraded states — what happened, where, whether the run
      stopped, and what to do about it

### Incomplete

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
`FINDINGS.md` §10–§13 records what that surfaced, including a defect where the
prompt could set the runner's error code.

### Not yet validated

- [ ] Flutter, Go or Rust repositories (stack detection is unit-tested only)
- [ ] Fallback and reasoning clamping against a live CLI
- [ ] Cost across models and repository sizes

### Known defects — validation review

A structured review after MVP 1 confirmed 17 findings. All twelve code-level
defects are fixed; each reproduction was inverted and moved into the suite of
the feature it belongs to.

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

See [FINDINGS §8](FINDINGS.md#8-a-structured-review-found-things-the-build-did-not).

### Next

- [ ] Git worktrees for task isolation
- [ ] Parallel execution — the scheduler already runs with concurrency > 1
- [ ] Model escalation after repeated failure
- [ ] Monorepo workspaces

---

## Findings

[`FINDINGS.md`](FINDINGS.md) documents what building this taught us about
driving coding CLIs from a program — including the problems still unsolved.
Short version:

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
npm run check         # typecheck + lint + CLI tests + dashboard tests
npm run build         # the CLI bundle
npm run build:web     # the dashboard bundle

npm run dev:web       # dashboard against a running `agent-flow ui`
npm run test:visual   # screenshot regression, local only — see below
```

The suite never invokes a real CLI. Runners are exercised through a scripted
`AgentRunner`; adapters are tested by asserting the exact argv they build plus
parsing output recorded from the real tools. That keeps it fast, free and
runnable in CI.

Architectural rules are executable (`test/architecture.test.ts`):

- `src/core/` imports no Node built-ins and no adapters
- `src/core/` mentions no provider, model or CLI name
- no framework name appears in `src/` outside stack detection
- topological ordering exists in exactly one module
- the core side never imports the server; the server never imports the CLI
- no server module names an auth file or reads the environment

The dashboard's layout is checked by screenshot against
[`agent-flow-ui-reference.png`](agent-flow-ui-reference.png), at 1440, 1280,
1200 and 1024 — the last two being the sides of the boundary where the inspector
stops sharing the row with the table and becomes a drawer. Stubbed API, pinned
clock, fixed locale and timezone. Those baselines are darwin
images — font rasterisation differs by platform — so `test:visual` is not in CI
and running it elsewhere means regenerating baselines there first with
`npm run test:visual:update`.

---

## Containment

Read-only stages run under the runner's own sandbox — `--permission-mode plan`
for Claude Code, `-s read-only` for Codex. Agent Flow never passes the flags
that disable them.

Being precise about the limit: Agent Flow spawns a CLI as a child process and
cannot intercept what that process runs. The containment is the runner's, not
ours. Anything stronger needs a container.

---

## License

MIT
