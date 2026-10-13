# Plan gate: present the plan, record the human's decision

Use when the run status is `waiting_for_approval`. Nothing is implemented until the
human approves; this is the scope decision, and it is theirs alone.

## 1. Read what is on the gate

- `GET /api/v1/runs/:runId/approval`: `canApprove`, `refusal`, `warnings`, `taskCount`,
  and the automated plan review (`review.verdict`, `review.findings`,
  `review.coversThisPlan`).
- The documents (MCP: run_artifacts): `GET /api/v1/runs/:runId/artifacts/:artifact` with
  `:artifact` = `plan` (the tasks), `sdd` (the specification) or `request` (what was asked).
- From the CLI: `agent-flow status` shows the tasks and the plan review's verdict; the
  files are `.agent-flow/runs/<runId>/sdd.md`, `plan.json` and `reviews/plan-review.json`.

## 2. Present it to the human, short

1. Scope vs the story: each acceptance criterion and the task(s) that cover it. Name any
   criterion with no task, and any task no criterion asked for.
2. Out of scope: what the plan explicitly leaves out.
3. Risks: the review verdict, its high/critical findings, and every warning (mostly a
   capability the run lost, such as a runner that fell back to another).
4. Ask one question: approve, revise (with what change), or reject? Ask for their name too.

## 3. Record who decided and exactly what they said

Every move takes the human's name and exact words, refused without them (CLI exit code,
HTTP 400). Pass both as given; never fill the name from git or the OS user. The run records
the channel (`cli`, `api`, `deck`) and the human sees it: an API decision shows it came via you.
- Approve: `agent-flow approve --decided-by "<name>" --words "<their words>"`, or
  `POST /api/v1/runs/:runId/approve` with `{"decidedBy": {"by": "<name>", "words": "<their words>"}}`.
  Then execute: see `agent-flow instructions feature`, "After the human approved".
- Revise: `agent-flow revise --file revision.md --decided-by "<name>" --words "<their words>"`,
  or `POST /api/v1/runs/:runId/revise` with `{"instruction": "<the change>"}` plus the
  same `decidedBy` (instruction max 4000 characters, else `--file`). Quote the human in the
  instruction; add context only after the quote. CLI only: `--decision` when their words
  answer a question the plan raised, `--from sdd` when the problem is in the specification.
- Reject: `agent-flow reject "<reason>" --decided-by "<name>" --words "<their words>"`, or
  `POST /api/v1/runs/:runId/reject` with `{"reason": "<reason>"}` plus `decidedBy`.
  Long words: `--words-file <path>`, or `--words -` to read stdin.

## When approve is refused

`refusal.forcible: true` means one of two things, and `refusal.kind` says which:
- The plan review failed, is missing, is stale or could not be verified. Tell the human
  what the review found and offer the ways past it, added to the approve above:
  `--attach-findings` hands each task the findings about it (only for `review_failed`,
  CLI only); `--force` overrules the review (CLI only, and only on the human's explicit
  instruction; the MCP tools have no force). Either is recorded on the run.
- `plan_rejected`: a person rejected this plan and nothing replaced it. Only `--force`
  gets past it, and only when that same human says they changed their mind.
Use any of these only when the human picks it by name; their words say which.

## Never

- Never approve, revise or reject without the human's explicit words in this conversation.
  "Looks good" about something else, silence, or your own judgement are not approval.
- Never invent the name or the words, and never paraphrase the human into a revision.
- Never click the Deck in a browser to move the gate (it records `deck`, no name); use the above.
- Never present only a summary you wrote; the human decides on scope, so show the gaps.
