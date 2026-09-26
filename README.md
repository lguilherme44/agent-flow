# Agent Flow

**English** · [Português (BR)](README.pt-BR.md)

[![CI](https://github.com/lguilherme44/agent-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/lguilherme44/agent-flow/actions/workflows/ci.yml)

**A local orchestrator for the coding agents you already use.** Agent Flow turns "implement
this feature" into a workflow with a human gate: it plans, has the plan reviewed, waits for
you to approve it, runs the tasks, validates them itself and reviews the result. It drives
Claude Code, Codex, AGY or an OpenAI-compatible endpoint, and keeps every step on your machine.

```text
request → impact analysis → design doc (SDD) → plan → plan review
        → you approve (bound to this exact plan)
        → tasks run, each in its own Git worktree when isolation is on
        → Agent Flow runs your lint/test/build, not the agent
        → code review by a model that did not write the code
        → final review → Definition of Done
```

## Why

- **A human decides.** Nothing is implemented before you read the design and the plan.
  Revise the plan and the approval no longer applies.
- **Done is decided by code.** Approved plan, every task complete, your gates green, final
  review PASS. An agent saying "finished" is not one of the conditions.
- **The agent cannot grade its own work.** Validation runs after the agent exits, and review
  is done by a different model (or a fresh context when you have only one provider).
- **Local-first.** Run state, artifacts, the audit log and the dashboard live on your machine.
  No cloud control plane, no telemetry upload, no API keys for the coding CLIs.

## Status

`v0.1.0`, pre-release, not published to npm. Built and used daily: the execution core,
parallel waves in isolated worktrees, recovery, review gates, the Deck dashboard, turns and
permission denials in telemetry, per-directory rules, and GitHub delivery. What comes next —
answering a blocked task, live progress in the dashboard, evals, native sandboxes, work-item
intake — is in [`docs/platform-roadmap.md`](docs/platform-roadmap.md), with the queue in
[`docs/platform-todo.md`](docs/platform-todo.md). Shipped **off** by default: parallel
execution, the agent-to-agent channel and every remote write to a forge.

## Requirements

- **Node 20+** to run it (Node 22.12+ to develop on it — the test runner needs it).
- **git** (2.33+ for worktree isolation).
- At least one coding CLI installed and logged in: **Claude Code**, **Codex** or **AGY**.
  Optional: an OpenAI-compatible endpoint (Ollama, llama.cpp, vLLM) for the planning and
  plan-review stages, which need no file access.

## Install

```bash
git clone https://github.com/lguilherme44/agent-flow
cd agent-flow
npm install
npm run install:global     # builds, packs, installs, then checks the installed binary
```

After `git pull`, run `npm install && npm run install:global` again.

## Quick start

```bash
cd ~/my-project
agent-flow init            # detects the stack and reads your real scripts
agent-flow doctor          # can this machine run it?

agent-flow feature "Add recurring bookings"   # plans, reviews, stops at the gate
agent-flow status          # read the SDD, the plan and the review
agent-flow approve
agent-flow run
agent-flow review          # verification, final review, Definition of Done

agent-flow ui              # Deck, the dashboard, on http://127.0.0.1:4782
```

Long requests go in a file: `agent-flow feature --file request.md`. A full walkthrough with a
four-task feature: [`docs/example-walkthrough.md`](docs/example-walkthrough.md).

## Commands

| Command | What it does |
|---|---|
| `init` · `doctor` | Prepare a repository · check the environment (`--deep` probes each runner for real) |
| `feature` | Plan a feature and stop at the gate. `--workflow <class>` corrects the risk class; `--grounded` skips re-mapping the repo when the request carries its own investigation |
| `status` | Where the run is, what it produced, what it spent |
| `approve` · `reject` · `revise` | Open the gate · close the run · re-plan with an instruction (`--from sdd` to reopen the design) |
| `run` · `retry <task>` · `revalidate <task>` | Execute · run a task again · re-check a task you fixed by hand, without a model |
| `review` | Verification, final review and the Definition of Done |
| `pause` · `resume` · `cancel` | Stop starting work · carry on · end the run, keeping every artifact |
| `ui` · `projects` · `autostart` | Dashboard · the project hub · start the dashboard at logon |
| `clean` | Remove old runs and their worktrees; deletes branches only with `--branches` |

## Configuration

Two YAML files: `~/.agent-flow/config.yaml` for your preferences, and
`<project>/.agent-flow/config.yaml` for what makes the repository different.

```yaml
# ~/.agent-flow/config.yaml
runners:
  claude: { type: claude-code-cli, enabled: true }
roles:
  planner:       { runner: claude, model: claude-opus-5-5, effort: high }
  executors:
    normal:      { runner: claude, model: claude-opus-5-5, effort: high }
  finalReviewer: { runner: claude, model: claude-opus-5-5, effort: high }
trust:
  projectConfig: [/home/me/work]   # project configs under here may loosen permissions
```

```yaml
# <project>/.agent-flow/config.yaml
commands:            # run by Agent Flow, never by an agent
  install: npm ci
  lint: npm run lint
  test: npm test
validationCommands:  # extra gates a task may name
  typecheck-ui: npm run typecheck:ui
worktree:
  copy: [.env.test]  # git-ignored files a task worktree needs (empty by default)
```

- **Pin the model.** Without `model:` each CLI uses its own default. In Deck, the Crew page
  pins one model for every role.
- **A project config only tightens.** From a directory not listed in `trust.projectConfig`,
  a project cannot switch on `dangerouslySkipPermissions`, add tool-granting `args`, point
  `mcp` servers or turn off the approval gate; `doctor` lists what it ignored.
- **Let the executor run commands.** Claude Code in headless mode runs only what is allowed:
  `runners.claude.args: ['--allowedTools', 'Bash(npm run:*)', 'PowerShell(npm run:*)']`
  (on Windows commands go through PowerShell, so each rule is needed twice). From a project
  config this needs the directory in `trust.projectConfig`. `doctor` warns when it is missing.
- **Parallelism is opt-in.** `git.useWorktrees: true` plus `parallelism.maxTasks: N` (up to 8)
  runs independent tasks at the same time, each in its own locked worktree. It costs one
  checkout and one install per task, and full test suites in parallel compete for the CPU.
- **Repository rules** come from `AGENTS.md` (or `CLAUDE.md` when there is none), and the
  implementation and code-review stages also get the nested `AGENTS.md`/`CLAUDE.md` of the
  directories a task touches.

## Runners

| Runner | `type` | Read-only stages |
|---|---|---|
| Claude Code | `claude-code-cli` | `--permission-mode plan` |
| Codex | `codex-cli` | `-s read-only` |
| AGY (Antigravity) | `agy-cli` | cannot be made read-only; serves executor roles |
| OpenAI-compatible | `openai-compatible` | has no file access at all; planning and plan review only |

One provider is a supported setup. A second one makes plan review and final review
cross-provider. What each CLI really does, measured with the command that proves it:
[`docs/runner-capabilities.md`](docs/runner-capabilities.md).

## Safety

- Plans name validation **ids**, never commands: model output cannot reach a shell.
- Your Git hooks never run inside an Agent Flow operation, and Agent Flow never writes `git config`.
- Coding CLIs get an environment allowlist, not your whole shell. Claude Code runs with your
  personal settings and hooks off; Codex and AGY are only partly isolated (Codex still loads
  skills, AGY still loads your MCP servers) — measured in `docs/runner-capabilities.md`.
- Containment during execution is the CLI's own; Agent Flow does not sandbox the process yet
  (native sandboxes are on the roadmap).
- The dashboard binds to `127.0.0.1` by default and takes ids from the browser, never paths.

Details and stated limits: [`docs/security.md`](docs/security.md).

## Documentation

| | |
|---|---|
| [`docs/platform-roadmap.md`](docs/platform-roadmap.md) · [`docs/platform-todo.md`](docs/platform-todo.md) | Where the product is going, and the queue (pt-BR) |
| [`docs/roadmap.md`](docs/roadmap.md) | Milestones already built |
| [`docs/web-ui.md`](docs/web-ui.md) | The dashboard and its HTTP API |
| [`docs/runner-capabilities.md`](docs/runner-capabilities.md) | What each coding CLI actually does, measured |
| [`docs/security.md`](docs/security.md) | The trust model and its limits |
| [`docs/testing.md`](docs/testing.md) | Test lanes and what each one proves |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | What a message means and what to do |
| [`docs/engineering/`](docs/engineering/) | Field reports from real runs, retractions included |

## Development

```bash
npm install
npm run verify           # every gate required locally
npm run test:fast        # tests that spawn nothing
npm run test             # both test lanes
npm run dev:deck         # Deck against a running `agent-flow ui`
```

No suite calls a real coding CLI: runners are tested through recorded output and the exact
argv they build. Git is never faked. Before a pull request: `npm run verify` green, and
`test/architecture.test.ts` updated, never deleted.

## License

MIT — see [`LICENSE`](LICENSE).
