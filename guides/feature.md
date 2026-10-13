# Feature: from a story to a running run

Use when the human hands you a story (link or text) to implement.

## 1. Check the project, once per repository

- `agent-flow doctor`: prints OK, DEGRADED or FAIL. On FAIL, stop and show the human
  the lines it printed; do not start a run.
- No `.agent-flow/config.yaml` in the repository root: run `agent-flow init`.
- `agent-flow status`: if a run is already active, do not start another. Read it instead.

## 2. Write the request

agent-flow plans from the text you give it. It does not open links.
Fetch the story AND its refinement yourself and write them to a file: title, acceptance
criteria, decisions from the refinement, what is out of scope, and the link itself.

## 3. Start planning

- CLI, blocks for minutes until the plan gate: `agent-flow feature --file request.md`
- HTTP, answers 202 with a job: `POST /api/v1/runs` with `?projectId=<id>` and body
  `{"description": "<the request text>"}`. Poll `GET /api/v1/jobs/:jobId` until it ends.
  Capped at 8000 characters (400 past it); a long story + refinement needs `--file`.

Add `--grounded` (HTTP: `{"grounded": true}`) only when the request already carries a
code investigation, and `--workflow <class>` (HTTP: `{"workflow": "<class>"}`) only when
the human asked for one.

## 4. Follow progress

- `agent-flow status` (or `--json`): stage, tasks, the plan review's verdict. Not the
  Definition of Done: only `agent-flow review` prints that.
- `agent-flow timeline`: where the wall clock went.
- `GET /api/v1/runs/:runId` and `GET /api/v1/runs/:runId/timeline`: the same, over HTTP.
- Live events: `GET /api/v1/events` with `?projectId=<id>&runId=<runId>` (Server-Sent
  Events). What already happened: `GET /api/v1/runs/:runId/events`.
- A stage silent for long: `GET /api/v1/runs/:runId/stages/:stage/log`.

Tell the human about stage changes and stops, not every event.

## 5. It stops at the plan gate

Status `waiting_for_approval` means planning and the automated plan review finished.
Read `agent-flow instructions gate` and present the plan.
A planning stage failed instead: read `agent-flow instructions recover`.

## After the human approved

- Execute: `agent-flow run` (blocks), `POST /api/v1/runs/:runId/start` (job) or MCP run_execute.
- Judge: `agent-flow review` or `POST /api/v1/runs/:runId/review` (job). It runs
  verification, e2e when enabled, the final review and the Definition of Done.
  Anything but FEATURE COMPLETE: read `agent-flow instructions done`.

## Never

- Never start a second run while one is active. Exit code 5 (or HTTP 409 `run_busy`)
  means another process holds the run: wait, do not retry in a loop.
- Never squeeze a story into a shell argument, or past the HTTP caps (description 8000
  characters; a revision or an answer 4000). Use the CLI's `--file`.
- Never pass `--skip-review` unless the human asked for it.
