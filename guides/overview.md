# agent-flow: overview

agent-flow turns a feature request into a reviewed plan, then into implemented, verified code.
It runs coding agents stage by stage and stops at gates where a human decides.
You, the AI, operate it. The human is called only for the decisions below.

## Pipeline, in order

discovery → architecture-impact → sdd → planning → plan-review → APPROVAL (human gate)
→ implementation → code-review (per task) → verification → e2e (when enabled) → final-review

Run status is one of: running, waiting_for_approval, plan_rejected, approved, completed,
failed, cancelled. Task state is one of: queued, ready, running, interrupted, completed,
failed, blocked, review_required.

## What only the human decides

1. Scope: approve the plan against the story and its refinement. You present it; they decide.
2. "Really solved": accept the runtime proof that the change works on the target. e2e
   provides it when it can reach the target. When it cannot (e2e NOT_RUN: a device, a
   native app), the human tests the build there and you record their name and their own
   words (`agent-flow instructions done`). Never attest yourself. Green lint, tests and
   build are not this proof.
3. Release to PRD. Never done by you, never done by agent-flow.

Everything else is yours: starting runs, following them, retrying, and relaying the
human's answers.

## Rules

- Never approve, revise or reject a plan without the human's name and explicit words. Pass
  both as given (`--decided-by`, `--words`; HTTP `decidedBy`), never invent either: the
  run records them with the channel they came through, for the human to see. Never move
  the gate by clicking the Deck in a browser; the Deck is the human's channel.
- Never answer a BLOCKED task with your own guess. Ask the human.
- Never record an e2e observation the human did not make on the target, or without
  their name.
- Never call a run done unless `agent-flow review` printed FEATURE COMPLETE (over HTTP:
  the review job's `summary` reads "Definition of Done satisfied").
- Never pass `--force` or `--attach-findings` unless the human chose it after you said
  what it overrides.

## Which guide to read

- `agent-flow instructions feature`: a story arrived; start a run and follow it.
- `agent-flow instructions gate`: status is waiting_for_approval.
- `agent-flow instructions blocked`: a task is BLOCKED or failed.
- `agent-flow instructions recover`: pause, resume, cancel, a stage failed, a task left
  unfinished.
- `agent-flow instructions done`: the run is NOT DONE, including e2e NOT_RUN.

## Ways to drive it

- MCP: `agent-flow mcp` serves these operations as tools (flow_instructions first), via the hub.
- CLI, run in the repository root (or with `--cwd <dir>`): `agent-flow status`.
- HTTP hub, the API the dashboard uses: `agent-flow ui --no-open` serves
  http://127.0.0.1:4782. Get project ids from `GET /api/v1/projects` and pass
  `?projectId=<id>` on every call. Every POST needs the header
  `x-agent-flow-client: <your name>`, or it is refused with 403.
