# MCP server

`agent-flow mcp` serves agent-flow's operations as MCP tools over stdio, so a model can
drive runs without a human typing commands. It is a thin client of the hub that
`agent-flow ui` serves (`http://127.0.0.1:4782` by default): every tool is one HTTP request
to it, and the MCP server holds no state of its own.

## Set it up in Claude Code

The hub has to be running: `agent-flow ui --no-open`, or `agent-flow autostart install`
once. The MCP server never starts it; a tool called while it is down answers with the
command that does.

```sh
claude mcp add agent-flow --scope user -- agent-flow mcp
```

The syntax was checked against `claude mcp add --help` (Claude Code 2.1.292). On native
Windows, where `agent-flow` is an npm `.cmd` shim, Claude Code's documentation asks for a
`cmd /c` wrapper on such commands — **not verified on this machine**:

```sh
claude mcp add agent-flow --scope user -- cmd /c agent-flow mcp
```

The same, as a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "agent-flow": { "type": "stdio", "command": "agent-flow", "args": ["mcp"] }
  }
}
```

Another hub: `agent-flow mcp --hub http://127.0.0.1:4783`, or `AGENT_FLOW_HUB_URL`
(the flag wins). A hub off this machine is refused unless `--allow-remote-hub` is passed:
the hub has no authentication, so decisions, project paths and plans would cross the
network unauthenticated.

## Tools

| Tool | Hub request |
|---|---|
| `flow_instructions` | none: the shipped guides (also resources `agent-flow://flows/<key>`) |
| `project_list` | `GET /api/v1/projects` |
| `run_start` | `POST /api/v1/runs` (description, or a file under a served project or the temp directory, ≤ 32 KB; at most 8000 characters) |
| `run_list` · `run_status` · `run_timeline` | `GET /api/v1/runs`, `/runs/:runId`, `/runs/:runId/timeline` (read-only) |
| `job_status` | `GET /api/v1/jobs/:jobId` (read-only) |
| `gate_get` · `run_artifacts` | `GET /api/v1/runs/:runId/approval`, `/runs/:runId/artifacts[/:artifact]` (read-only) |
| `gate_decide` | `POST /api/v1/runs/:runId/approve`, `reject` or `revise`, with `decidedBy`; no `force` |
| `task_answer` | `POST /api/v1/runs/:runId/tasks/:taskId/answer`, with `decidedBy` |
| `task_retry` | `POST /api/v1/runs/:runId/tasks/:taskId/retry`; `decidedBy` required with `force` or `expectNoChange` |
| `run_execute` | `POST /api/v1/runs/:runId/start`: executes the approved plan, as a job (CLI: `agent-flow run`) |
| `run_control` | `POST /api/v1/runs/:runId/pause` or `resume` |
| `run_cancel` | `POST /api/v1/runs/:runId/cancel`, with `decidedBy` (destructive) |
| `review_run` | `POST /api/v1/runs/:runId/review` |

The read tools carry `readOnlyHint`, `run_cancel` and `gate_decide` carry `destructiveHint`,
and every other write is marked non-destructive, so a client knows which call to confirm.

End to end: `run_start` → `job_status` → `gate_get` → the human decides → `gate_decide` →
`run_execute` → `job_status` / `run_status` → `review_run`.

## What the hub records

Every request carries `x-agent-flow-client: mcp` and no `Origin`, so the hub records it
with channel `api`, which the Deck shows in a warning tone. The hub records the channel
(`cli`, `deck`, `api`) on every operator action, and the run detail lists them
(`operatorActions`).

The human decisions — approve, reject, revise, a task answer, a cancel, a retry that
overrides a gate — need `decidedBy`:
the human's name and their exact words. **The hub enforces it** for every non-browser
client, so `curl` cannot skip it either; the Deck keeps working unchanged, filled from its
session. The hub echoes the decision it recorded, and when it does not (a hub built before
this) the tool says the decision was applied without the name and asks for a restart of
`agent-flow ui`. The name and the words are free text: the channel is what tells a human
reading the run that a decision in their name came through an AI.

A hub refusal reaches the model with its suggestion framed for the human ("ask them before
acting on it"): the hub writes its refusals for a person at the Deck, and "approve
deliberately" read bare by a model is an override it must not choose.

The hub has no authentication beyond loopback and its Origin guard. Do not bind it to
`0.0.0.0` while an MCP client can reach it.
