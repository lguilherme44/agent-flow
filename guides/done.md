# NOT DONE: the Definition of Done, e2e NOT_RUN, corrective work

## Read the checklist

`agent-flow review` prints FEATURE COMPLETE or NOT DONE and every Definition of Done
condition, ✓ or ✗, each unmet one with its detail; `agent-flow status` and the Deck keep
naming the unmet ones until new work or another review replaces the verdict.
HTTP: `POST /api/v1/runs/:runId/review` is a job; poll `GET /api/v1/jobs/:jobId` (its
`summary` lists every unmet condition). Evidence: `GET /api/v1/runs/:runId/artifacts/:artifact`.

## Each unmet condition

- `SDD approved`: nobody approved the plan. `agent-flow instructions gate`.
- `all tasks completed`: some task is not completed. `agent-flow instructions recover`.
- `lint, tests and build passing`: FAIL is broken code. NOT_RUN means the commands never
  ran (workspace not prepared, install failed): fix the environment, review again. A step
  in `verification.baseline` that fails on the base too is pre-existing and not counted.
- `final review PASS`: the work does not meet the SDD. Not counted while commands NOT_RUN.
- `no blocking review finding is open`: a high/critical finding is open; the detail names it.
- `required gates ran and passed`: a required validation did not run or failed; see detail.
- `e2e exercised the change and passed`: FAIL means e2e watched the change fail, and
  nothing outweighs that. NOT_RUN means agent-flow could not reach the target (a device, a
  native app, or a command it was denied: `roles.e2e.allowedCommands`). Reviewing again alone
  will not change that.

## e2e NOT_RUN: the human observes it on the target

Tell the human what e2e could not do and the build under review (the short sha in the detail); ask
them to test it (`instructions device-proof`) and give their name, what they did and saw. Record it:
- `agent-flow review --e2e-observed "<their words>" --observed-by "<their name>"`, plus
  `--e2e-head <sha>` when they named the build, `--evidence <png...>` for their screenshots.
- HTTP review body: `{"e2eObserved": "<their words>", "observedBy": "<their name>", "e2eHead": "<sha>"}`.
  The name is required; another build is refused; it counts only for that commit.

## `review --fix`

`agent-flow review --fix` (HTTP: `{"fix": true}`) turns findings into FIX tasks; with
e2e NOT_RUN as the only unmet condition it adds nothing. When it adds tasks, the plan is
rewritten and re-reviewed, and approval is usually reopened. Then `agent-flow status`:
`waiting_for_approval` or `plan_rejected` → `agent-flow instructions gate`, never approve
it yourself; still approved → show the FIX tasks to the human before `agent-flow run`.

## Delivered outside agent-flow: the human closes the run

When the human accepts the delivery as it is (a PR they opened by hand, an e2e they checked
themselves), show them the unmet conditions and ask for their decision, name and words:
- `agent-flow complete --decided-by "<their name>" --words "<their words>" --pr <url>`
- `POST /api/v1/runs/:runId/complete` with `{"decidedBy": {"by", "words"}, "pr"}` (MCP `run_complete`).
Refused until a review concluded on the work as it stands; records what it closed over.

## What to tell the human, and never

FEATURE COMPLETE or NOT DONE, every unmet condition with its detail, and the one
decision you need. For e2e NOT_RUN: "nobody has seen this working yet". When FEATURE
COMPLETE rests on their observation, say so: agent-flow did not see it work, they did.

- Never report a run as done while any condition is unmet. Green build + NOT_RUN is not done.
- Never complete a run, attest, or invent a name or words yourself: those are the human's.
  Only their own observation on the target counts, not a green build or your reading.
- Never turn e2e off (`roles.e2e.enabled`) to get past NOT_RUN: it removes the evidence.
