# Blocked or failed task: find out why, ask, then answer or retry

Use when a task's state is `blocked` or `failed`, or `agent-flow run` stopped saying a
task reported BLOCKED.

## 1. Read why

- `agent-flow status`: which tasks are blocked or failed, and the run's next step.
- `GET /api/v1/runs/:runId/tasks`: every task and its state.
- `GET /api/v1/runs/:runId/tasks/:taskId`: one task in detail: `blockReason`, `errorCode`,
  `notes`, the newest attempt's `log` and `commands`, and `attemptHistory`.
- On disk: `.agent-flow/runs/<runId>/tasks/<taskId>/` holds each `attempt-<n>.json`.

`blockReason: agent` (or absent): the agent stopped because it needs a decision only a
person can make. `blockReason: dependency`: an upstream task failed and this one never
ran. Deal with the upstream task first; do not answer this one.
FAILED means an attempt ran and did not pass (validation, scope, runner error).

## 2. BLOCKED: ask the human, then answer

1. Show the human the agent's question verbatim, the task title, and what you think the
   options are. Ask them to choose. Do not choose for them.
2. Record their answer, quoted:
   - `agent-flow answer TASK-004 "<the human's words>" --decided-by "<name>"`, or
     `--file answer.md` for anything longer than a line. The answer is recorded as their words.
   - MCP task_answer, or `POST /api/v1/runs/:runId/tasks/:taskId/answer` with
     `{"text": "<the human's words>", "decidedBy": {"by": "<name>", "words": "<their words>"}}`.
3. Answering requeues the task; it does not run it. Continue the run with
   `agent-flow run` or `POST /api/v1/runs/:runId/start`.

## 3. FAILED: retry, or revalidate a hand fix

- Transient cause (timeout, quota, runner crash): `agent-flow retry TASK-004`, or
  `POST /api/v1/runs/:runId/tasks/:taskId/retry` with `{}`. Then `agent-flow run`.
- Past its attempt limit, or retrying a BLOCKED task without an answer: `--force --decided-by "<name>" --words "<their words>"`
  (HTTP: `decidedBy`). Only with the human's go-ahead; it spends another attempt on the same question.
- A verification task that is meant to change nothing failed on an empty diff:
  `agent-flow retry TASK-004 --expect-no-change --decided-by "<name>" --words "<their words>"`
  (HTTP: `{"expectNoChange": true}` plus `decidedBy`), on the human's word.
- The human fixed the task's worktree by hand: `agent-flow revalidate TASK-004` re-runs
  only the task's checks over that worktree, without calling the model again.

## What to tell the human

The task, the one-line reason, the question or the failure, and the single decision you
need from them. Not the attempt log.

## Never

- Never answer a BLOCKED task with your own guess, even an obvious one. The answer becomes
  part of the specification the final review judges against.
- Never retry the same failure more than once without reading why it failed.
- Never edit the task's worktree yourself and then `revalidate` without telling the human.
