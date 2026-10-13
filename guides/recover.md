# Recover: pause, resume, cancel, a failed stage, a task left unfinished

## Pause, resume, cancel

- `agent-flow pause` / `POST /api/v1/runs/:runId/pause`: starts no new task; the task in
  flight finishes first, so "pausing" comes before "paused".
- `agent-flow resume` / `POST /api/v1/runs/:runId/resume`: clears the pause and continues
  the approved plan.
- `agent-flow cancel --yes --decided-by "<name>" --words "<their words>"` /
  `POST /api/v1/runs/:runId/cancel` with `{"decidedBy": {"by": "<name>", "words": "<their words>"}}`
  (MCP: run_cancel): ends the run and stops its agents. Not reversible; every artifact and
  worktree is kept. Only on the human's words.

## A planning stage failed

Read the error first: `agent-flow status`, or `GET /api/v1/runs/:runId/stages/:stage/log`.
- Resume from that stage, keeping the earlier ones:
  `agent-flow feature --file request.md --from <stage>`, or
  `POST /api/v1/runs/:runId/plan` with `{"from": "<stage>"}`.
- quota or auth errors: tell the human; they are not fixed by retrying.
- timeout: the message names the config key that raises the limit. Raising it is the
  human's call.

## A task is not completed

`agent-flow status` names each task and its state (HTTP: `GET /api/v1/runs/:runId/tasks`).
- `blocked` or `failed`: read `agent-flow instructions blocked`.
- `review_required`: the attempt ran, but its validation or acceptance evidence was not
  satisfied, or its merge into the integration branch conflicted. The reason is in the
  task's `notes` (`GET /api/v1/runs/:runId/tasks/:taskId`). Show it to the human; then
  `agent-flow retry TASK-004` to run it again, or `agent-flow revalidate TASK-004` if the
  human fixed its worktree by hand.
- `interrupted`: the process running it died. `agent-flow run` requeues such a task by
  itself while it is under its attempt limit; one that stays `interrupted` is past it:
  `agent-flow retry TASK-004`, only with the human's go-ahead.
- `queued`: it has not run yet. `agent-flow run`.

## The run is NOT DONE

Read `agent-flow instructions done`: what each unmet condition means, what to do when
e2e could not run, and what `agent-flow review --fix` changes.

## Never

- Never cancel, or raise a timeout or budget, without the human's explicit words.
- Never use `revise` to recover a crashed stage; `--from` resumes it without spending a
  revision cycle.
- Never `retry` the same failure twice without reading why it failed.
