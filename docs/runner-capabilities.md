# Runner capabilities — empirical probe

> Produced by AF-10 (Claude Code) and AF-11 (Codex).
> Every claim below was executed, not inferred from documentation.
> **Re-run this probe when a CLI changes version.** The fixtures under
> `test/fixtures/responses/` are what let the adapters be tested offline, and
> they are only as accurate as the version they were captured from.

---

## Claude Code

**Version probed:** `2.1.226`
**Probed on:** 2026-08-09, macOS (darwin 25.6.0), Node v22.23.2
**Auth:** local CLI session (no API key set)

### Capability summary

| Capability | Verdict | Proven by |
|---|---|---|
| Non-interactive | ✅ | `echo "..." \| claude -p` → exits 0 with the answer on stdout |
| Model selection | ✅ | `--model sonnet` → `modelUsage` reports `claude-sonnet-5` |
| Reasoning level | ✅ | `--effort low\|medium\|high\|xhigh\|max` |
| Structured output | ✅ **native** | `--json-schema '<schema>'` → response carries `structured_output` |
| Read-only mode | ✅ | `--permission-mode plan` → file creation did not happen (see below) |
| Working directory | ⚠️ via spawn | No `--cwd` flag; the process inherits its cwd |
| Model fallback | ✅ | `--fallback-model` (unused — agent-flow does its own, at role level) |

### Invocation shape used by the adapter

```
claude -p
       --output-format json
       [--model <model>]                # omitted when config sets none (AD-13)
       --effort <low|medium|high|xhigh|max>
       --permission-mode <plan|acceptEdits>
       [--disallowedTools <tool> ...]
       [--append-system-prompt <text>]
       [--add-dir <path> ...]
       [--json-schema <json>]
```

The prompt goes in **on stdin**, never as a positional argument.

### Why the prompt goes on stdin

The first probe failed like this:

```
$ claude -p --disallowedTools "Write" "Reply with exactly: PROBE_OK"
Permission deny rule "Reply" matches no known tool — check for typos.
Permission deny rule "with" matches no known tool — check for typos.
Error: Input must be provided either through stdin or as a prompt argument when using --print
```

`--disallowedTools` is variadic (`<tools...>`), so it swallowed the positional
prompt word by word. Ordering flags around it would work but stays fragile as
soon as another variadic flag appears. Stdin sidesteps the parsing question
entirely and removes any argv length ceiling on long prompts.

### Reasoning level mapping

| agent-flow (logical) | Claude Code (physical) |
|---|---|
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `very_high` | `xhigh` |

`max` exists and is deliberately **not** used: the cost is disproportionate and
the gain over `xhigh` is marginal for these stages.

**An invalid `--effort` does not fail the process.** It prints a warning and
silently uses the default:

```
Warning: Unknown --effort value 'ultra' — ignoring it and using the default effort.
Valid values: low, medium, high, xhigh, max.
```

This matters: the CLI will not protect us from a wrong mapping, so the adapter
must produce a valid physical value on its own. Getting it wrong means silently
running at the default level while believing otherwise — the failure would be
invisible in the output and only show up as worse results.

### Structured output

`--json-schema` is enforced by the runtime, not merely requested in the prompt.
The response gains a `structured_output` field alongside the string `result`:

```json
{
  "subtype": "success",
  "result": "{\"feature\":\"recurring-bookings\",\"count\":3}",
  "structured_output": { "feature": "recurring-bookings", "count": 3 },
  "stop_reason": "tool_use"
}
```

`stop_reason: "tool_use"` and `num_turns: 2` show it is implemented as an
internal tool call. The adapter reads `structured_output` when present and falls
back to parsing `result` when it is not.

This is why `structuredOutputStrategy` is `native` for this runner, and why the
repair loop (AF-20) exists for runners that lack the equivalent.

### Read-only enforcement

`--permission-mode plan` is a real barrier, not a request. Probed with a
deliberately mundane instruction (a canary-flavoured one made the model refuse
on its own, which would have proven nothing):

> Please create a file called notes.txt in the current directory with a one-line
> summary of what package.json contains. This is a normal file-creation task.

The agent tried to comply, could not leave plan mode, and `notes.txt` was never
created. Containment came from the mode, not from the model's judgement.

**Caveat worth knowing:** plan mode still writes *outside* the working
directory — the probe left a plan file in `~/.claude/plans/`. So "read-only"
means "does not modify the project", not "writes nothing anywhere". For §35 that
is sufficient, but it should not be described more strongly than it is.

The adapter additionally passes `--disallowedTools Write Edit NotebookEdit` as a
belt-and-braces measure, and **never** passes `--dangerously-skip-permissions`.

### Exit codes and error shape

| Situation | Exit | Where the message lands |
|---|---|---|
| Success | `0` | stdout |
| Invalid model | `1` | stdout (`There's an issue with the selected model …`) |
| Missing binary | n/a | spawn fails with `ENOENT` before the CLI starts |

With `--output-format json`, failures keep the same envelope and set
`is_error: true` plus an `api_error_status`.

### Fixtures

| File | Origin |
|---|---|
| `success-text.txt` | **real** |
| `success-json.json` | **real** (ids scrubbed) |
| `success-structured-output.json` | **real** (ids scrubbed) |
| `error-invalid-model.txt` | **real** |
| `SYNTHETIC-error-auth.json` | ⚠️ **synthetic** |
| `SYNTHETIC-error-quota.json` | ⚠️ **synthetic** |

The two `SYNTHETIC-` files are hand-written. Forcing a genuine 401 or 429 would
mean either breaking the developer's local login or burning through a real quota
limit, and neither is a reasonable price for a fixture.

They are prefixed so nobody mistakes them for captured output. Because they are
guesses about wording, the adapter deliberately **does not** depend on the exact
strings: normalisation keys on `api_error_status` first and treats text matching
as a secondary signal. Replace these files the first time a real failure occurs.

---

## Codex

**Version probed:** `codex-cli 0.147.0`
**Probed on:** 2026-08-09, macOS (darwin 25.6.0)
**Auth:** local ChatGPT account (no API key set)

> Earlier the CLI was installed at `0.130.0` with its native binary missing, so
> every invocation died with `ENOENT` — the `installed ✓ / executable ✗` state
> that keeps those two checks separate in `doctor`. It has since been reinstalled.

### Capability summary

| Capability | Verdict | Proven by |
|---|---|---|
| Non-interactive | ✅ | `echo "…" \| codex exec` → exits 0 |
| Model selection | ✅ | `-m, --model <MODEL>` |
| Reasoning level | ✅ | `-c model_reasoning_effort=<level>` |
| Structured output | ✅ **native** | `--output-schema <FILE>` → response is the object |
| Read-only mode | ✅ | `-s read-only` → file creation did not happen |
| Working directory | ✅ **native flag** | `-C, --cd <DIR>` |

Both runners therefore report `structuredOutputStrategy: 'native'`. The repair
loop still exists, because a schema constrains shape and not correctness — and
because a future runner may lack the feature entirely.

### Invocation shape used by the adapter

```
codex exec
      --skip-git-repo-check
      --ephemeral                       # no session files for a one-shot run
      --color never
      -C <workingDirectory>
      -s <read-only|workspace-write>
      [-m <model>]                      # omitted when config sets none (AD-13)
      -c model_reasoning_effort=<level>
      [--output-schema <tmpfile>]
      -o <tmpfile>                      # the answer, written cleanly
```

Prompt on stdin, as with Claude Code.

### Two differences that shape the adapter

**`--output-schema` takes a file path, not a string.** Claude Code accepts the
schema inline; Codex wants it on disk. The adapter therefore needs filesystem
access, which is why `CodexRunner` is constructed with a `FileSystem` port while
`ClaudeCodeRunner` is not.

**stdout is not usable as the answer.** It carries hook output, ANSI colour and
a token counter:

```
hook: UserPromptSubmit
hook: UserPromptSubmit Completed
codex
PROBE_OK
hook: Stop Completed
tokens used
14.303
```

`-o <file>` writes just the final message, so the adapter reads that instead of
parsing stdout. `--color never` reduces the noise but does not remove the hooks,
which come from the user's own configuration.

### Reasoning level mapping

| agent-flow (logical) | Codex (physical) |
|---|---|
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `very_high` | `xhigh` |

Same table as Claude Code, which is a coincidence rather than a guarantee — the
translation stays inside each adapter precisely so the two can diverge.

An unrecognised value is not rejected: `-c` parses as TOML and an unknown effort
is passed through to config. As with Claude Code, the CLI will not catch a bad
mapping for us.

### Exit codes and error shape

| Situation | Exit | Where the message lands |
|---|---|---|
| Success | `0` | `-o` file (and stdout, mixed with noise) |
| Invalid model | `1` | stderr, as structured JSON |
| Missing binary | n/a | spawn fails with `ENOENT` |

Errors arrive with an HTTP status, which makes normalisation robust without
matching on wording:

```json
{"type":"error","status":400,
 "error":{"type":"invalid_request_error",
          "message":"The 'not-a-real-model' model is not supported when using Codex with a ChatGPT account."}}
```

### Fixtures

| File | Origin |
|---|---|
| `success-text.txt` | **real** |
| `success-structured-output.json` | **real** |
| `error-invalid-model.txt` | **real** |

No synthetic auth or quota fixtures here: normalisation keys on the `status`
field above, so a 401 or 429 is recognised structurally rather than by phrasing.
