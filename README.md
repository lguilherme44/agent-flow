# Agent Flow

**English** · [Português (BR)](README.pt-BR.md)

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
| `doctor` | Can this environment work? Reports `OK` / `DEGRADED` / `FAIL`. |
| `feature "<description>"` | Discovery → impact → SDD → plan → review. Stops at the gate. |
| `status` | Where the run is, what it produced, what is degraded. |
| `approve` | Open the gate. Refuses a failed review unless `--force`. |
| `reject` · `revise "<instruction>"` | Close a run, or re-plan with guidance. |
| `run` · `task TASK-004` · `retry TASK-004` | Execute the approved plan. |
| `review` | Run validation, inspect the code, judge it against the SDD. |
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
552 tests, no CLI invoked by the suite.

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

### Incomplete

- [ ] `doctor --deep` — live auth probing (currently reports that it is unimplemented)
- [ ] `review --fix` — generates corrective tasks but does not feed them back
- [ ] Local telemetry — schema exists, nothing writes it
- [ ] Test-first plans — see [FINDINGS §7](FINDINGS.md#7-the-tool-caught-a-contradiction-three-reviews-had-missed)

### Not yet validated

- [ ] Verification and final review against a live CLI (covered by tests only)
- [ ] Any stack other than Node
- [ ] Cost across models and repository sizes

### Known defects — validation review

A structured review after MVP 1 confirmed 17 findings, reproduced in
[`test/validation-review.repro.test.ts`](test/validation-review.repro.test.ts).
Fix order and severity:

- [ ] **V-01 · critical** — planner-authored strings reach `/bin/sh -c`; no allowlist
- [ ] **V-09 · high** — the process timeout never fires when the child has children
- [ ] **V-02 · high** — `FallbackRunner` is never constructed at runtime
- [ ] **V-03 · high** — a task interrupted mid-flight stays `running` forever
- [ ] **V-04 · high** — test-first plans cannot express an expected failure
- [ ] **V-05 · medium** — `agent-flow task` builds a graph missing its dependencies
- [ ] **V-06 · medium** — `result.json` records a hardcoded reasoning level
- [ ] **V-07 · medium** — the discovery cache is reused without invalidation
- [ ] **V-08 · medium** — validation commands run twice, once by the agent
- [ ] **V-10/11/12 · low** — `approvedAt` unset, prompt role metadata unused, stale CLI copy

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

[`docs/runner-capabilities.md`](docs/runner-capabilities.md) records what each
CLI actually does, with the command that proves each claim and the version it
was probed against.

---

## Development

```bash
npm install
npm run check    # typecheck + lint + test
npm run build
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
