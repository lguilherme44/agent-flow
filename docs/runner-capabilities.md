# Runner capabilities — empirical probe

> Produced by AF-10 (Claude Code), AF-11 (Codex) and AR-00 (AGY).
> Every claim below was executed, not inferred from documentation.
> **Re-run this probe when a CLI changes version.** The fixtures under
> `test/fixtures/responses/` are what let the adapters be tested offline, and
> they are only as accurate as the version they were captured from.

---

## Two different questions, and the page used to answer only one

**CLI surface capability** — what the command-line tool *accepts*. Read off `--help`,
verifiable in a second, and the same for every model the CLI can point at.

**Effective (runner, model) capability** — what the model *behind* that flag actually
offers. A property of the pair, and the only one that predicts whether an invocation will
do what was asked.

Until AR-00 the adapters reported the first and the core believed it was the second, because
`AgentRunner.capabilities()` took no argument (AD-30) — so the question could not even be
asked. AR-00 makes it askable and records the answers below; **AR-01 is the milestone that
acts on them** (see the AGY section's boundary note).

The two coincide for Claude Code and Codex, whose effort surface is a property of the CLI.
They do **not** coincide for AGY, and the gap cost the AF-2026-002 dogfood a task attempt on
its first executor call:

```
agy --help          →  --effort  low | medium | high        ← CLI surface
Gemini 3.1 Pro      →            low |        | high        ← effective pair
role executor.normal configured effort: medium              ← neither refused nor honoured
```

The invocation was accepted, the effort was not the one requested, and nothing said so.
`clampReasoning`, the `reasoningClamped` field and the `reasoning_clamped` degradation all
already existed and had never fired — they were being fed the CLI's answer.

**So a section below may only narrow a capability where the narrowing was measured.** An
unmeasured model falls back to the CLI surface: claiming a narrower set for a model nobody
probed would clamp work for no evidence, and claiming a wider one is the defect above.

---

## `openai-compatible`, against a real server

**Probed:** 2026-08-30 · macOS (darwin 25.6.0), Node v24.13.0
**Server:** `llama.cpp` (`b1-cd644c3`) on `lellis-dev` (RTX 3060 Ti), reached over an SSH
tunnel at `http://127.0.0.1:8151/v1`
**Model:** `moe` — Qwen3.6 35B-A3B `UD-IQ4_NL`, 49152 context, `-ngl 99 --n-cpu-moe 30`

**This adapter shipped with no live evidence at all.** Its unit tests stub `fetch`, and its
fixtures were written from a specification rather than from a serialisation — the shape
that agrees with a bug rather than catching one. Everything below was executed through the
adapter's own port, by `scripts/live-runner-probe.ts`.

| Capability | Verdict | Proven by |
|---|---|---|
| `healthCheck` reaches the server | ✅ | `installed=true auth=configured version=moe` |
| Declares it cannot write or hold a cwd | ✅ | `supportsWorkingDirectory=false`, `fileEdit=false` |
| Plain prompt round-trips | ✅ | 195 ms, answered `ok` |
| **Structured output, natively** | ✅ | schema in → `{"verdict":"PASS","findings":["none"]}` out |
| A refused key normalises to `auth_required` | ✅ | server answered `401 Invalid API Key` |
| An unreachable server is `runner_unavailable` | ✅ | `fetch failed` against a closed port |

**The structured-output row is the one that was a guess.** The adapter declares
`structuredOutputStrategy: 'native'`, which is a claim about the *server* — and this server
is `llama.cpp`, not OpenAI. It holds: the schema was enforced and the response parsed
without the repair loop. Had it not held, every stage routed to a local endpoint would have
been paying for a repair round nobody could see.

Not probed, and therefore not claimed: rate limiting (a local server has none), cancellation
mid-stream, and behaviour under a model that emits a partial envelope.

Reproduce with the server up:

```bash
ssh lellis-dev '~/local-llm-lab/linux/llm-server.sh start moe'
ssh -f -N llm-dev
node --experimental-strip-types scripts/live-runner-probe.ts
```

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

---

## AGY (Antigravity CLI)

**Version probed:** `1.1.13`
**Probed on:** 2026-08-17, macOS (darwin 25.6.0)
**Auth:** local CLI session
**Binary:** installed outside `PATH`, so `runners.agy.command` names it explicitly

> This section exists because its absence caused the AF-2026-002 dogfood's first failure.
> The adapter had been written from the CLI's `--help` output, which is a true description
> of the flag and a false description of the pair behind it.

### Capability summary

| Capability | Verdict | Proven by |
|---|---|---|
| Non-interactive | ✅ | `--print` / `-p` with `--output-format json` |
| Model selection | ✅ | `--model <id>`, ids from `agy models` |
| Reasoning level | ⚠️ **CLI accepts three; a model may offer fewer** | see the table below — encoded in the adapter since AR-01 |
| Structured output | ⚠️ `prompted` | `--json-schema` exists; enforcement in headless mode needs permission configuration the adapter does not assume |
| Read-only mode | ❌ **declared false** | `--mode plan` exists, but the probe observed writes to `~/.gemini/antigravity-cli/`, so strict containment is not guaranteed by flags alone |
| Working directory | ✅ | `--add-dir <path>` |
| Non-interactive **file edits** | ✅ | `--mode accept-edits` |
| Non-interactive **command execution** | ❌ **not granted** | the dogfood's own failure — see below |

### Invocation shape used by the adapter

```
agy --output-format json
    [--model <model>]                 # omitted when config sets none (AD-13)
    --effort <low|medium|high>
    --mode <plan|accept-edits>
    --add-dir <workingDirectory>
    [--add-dir <path> ...]
    [--json-schema <json>]
```

Prompt on stdin, as with the other two runners. `--dangerously-skip-permissions` exists and
is **never** passed: it removes the containment AD-14 assigns to the runner.

### Reasoning level — CLI surface

```
$ agy --help
  --effort   Reasoning effort for the current CLI session (low|medium|high)
```

| agent-flow (logical) | AGY CLI (physical) |
|---|---|
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `very_high` | `high` — the CLI offers nothing above it |

This is what `capabilities()` returns when **no model is configured**, what it returns for a
family nobody has measured, and what the adapter returned unconditionally before AR-01.

### Reasoning level — effective per model

`agy models` enumerates one model id **per offered effort**, which makes the effective set
directly observable rather than inferred:

```
$ agy models
gemini-3.7-flash-high      Gemini 3.7 Flash (High)
gemini-3.7-flash-medium    Gemini 3.7 Flash (Medium)
gemini-3.7-flash-low       Gemini 3.7 Flash (Low)
…
gemini-3.1-pro-high        Gemini 3.1 Pro (High)
gemini-3.1-pro-low         Gemini 3.1 Pro (Low)     ← no -medium id exists
claude-sonnet-4-6          Claude Sonnet 4.6 (Thinking)
gpt-oss-120b-medium        GPT-OSS 120B (Medium)
```

| Model family | Effective efforts | How it was measured |
|---|---|---|
| `gemini-3.1-pro-*` | **`low`, `high`** | enumeration lists `-high` and `-low` and no `-medium` |
| everything else | *not measured* | no probe was run; see the rule below |

Only that one row is a measurement. The other families show a `-medium` id and would
plausibly offer all three, and *plausibly* is not a measurement — so they have no entry, and
adding one requires probing them first.

The effort suffix is a **setting, not a distinct model**: `gemini-3.1-pro-low` and
`gemini-3.1-pro-high` are one model at two settings, so a table encoding this must match on
the family prefix and answer identically for both. Otherwise the clamp would depend on which
id somebody typed.

### ✅ This measurement is acted on — AR-01 activated it

**AR-00 landed the seam and this table; AR-01 encoded it in the adapter.** The boundary was
drawn in the specification rather than by preference:

| | AR-00 | AR-01 |
|---|---|---|
| `capabilities(model?)` in the port | ✅ landed | — |
| `nonInteractiveToolGrants` on all adapters | ✅ landed | — |
| this measured table, as documentation | ✅ landed | — |
| the table **encoded in the adapter** | ✖ non-goal | ✅ landed (C-03, I-20) |
| the clamp firing, degradation recorded, 0 attempts consumed | ✖ non-goal | ✅ landed |
| `doctor` reporting the pair mechanically, and probing **each configured effort** | ✖ non-goal | ✅ landed |

AR-00's non-goal was "no behaviour change" and its migration was "none — additive and
defaulted". AR-01 owns `core/role.ts` and all four adapters, carries C-03 and I-20, and its
migration note is *"a previously-fatal configuration now clamps"*. An adapter narrowing its
answer is precisely that clamp, which is why it belongs there and not in AR-00.

The table lives in `MEASURED_MODEL_REASONING` in `src/adapters/runners/agy-runner.ts`, keyed
by family prefix. An architecture test confines it to `src/adapters/runners/` — the core
receives the model as an opaque string and a table keyed by model name may never live there
(AD-13, AD-30).

What AR-01 produces, for the exact configuration that failed:

```
role executor.normal   runner: agy   model: gemini-3.1-pro-high   effort: medium
                    →  effective effort: low
                    →  reasoningClamped: true
                    →  degradation: reasoning_clamped (requested medium, effective low,
                                    supported [low, high], runner agy, model
                                    gemini-3.1-pro-high)
                    →  stage_started detail: reasoningRequested / reasoningSupported /
                                    reasoningClamped, structurally
                    →  attempts consumed: 0        (AD-31, I-20, I-22)
```

The clamp *mechanism* already existed and was already wired: `clampReasoning`,
`ResolvedAgentConfig.reasoningClamped`, and the `reasoning_clamped` degradation recorded at
`app/stage-runner.ts`. It had never fired, because it was being fed the CLI's answer. AR-01
changed what it is fed; the only new machinery is the evidence the degradation now carries.

#### The model id and the effective effort disagree, and that is correct

`gemini-3.1-pro-high` says `-high`; the effective effort above is `low`. Nothing reconciles
them, and nothing should:

- the model is an **opaque string** to the core (AD-13) — the core is not permitted to know
  that this vendor encodes an effort in an id, and a layer that took the id apart would be
  applying a heuristic nobody measured;
- the effective effort is decided by `clampReasoning` against what `capabilities(model)`
  declared;
- the adapter forwards **both verbatim**: `--model gemini-3.1-pro-high --effort low`.

This is what the specification prescribes, and it is pinned by a test on the arguments the
adapter actually builds. If the CLI is ever observed to *reject* that combination, that is a
contract conflict to report — not a licence to invent a reconciliation rule. An architecture
test forbids any layer above `src/adapters/` from taking a model string apart.

### Non-interactive is not the same as permitted

`--mode accept-edits` grants **file edits** without a confirmation prompt. It does not grant
**command execution**, and the two were conflated under `supportsNonInteractive` until
AD-32 split them.

The dogfood's evidence, from the vendor's own log directory — which a person had to open by
hand, because `StageFailure.raw` was being discarded at both persistence points:

```
soft-denying tool confirmation "Bash"
permission check failed
```

The process was genuinely non-interactive: it did not block on a prompt. It asked to run
`grep`, local policy required a confirmation, nobody was present to give one, and the run
recorded a generic `execution_failed`. So the adapter declares:

```ts
nonInteractiveToolGrants: { fileEdit: true, commandExecution: false }
```

`false` does **not** block execution. It produces a `permission_not_ready` warning from
`doctor` and a preflight finding (C-04), so an ungranted tool class is visible *before* an
attempt is spent rather than discovered by spending one. A grant is declared, never inferred
from a run that happened to succeed.

### What is deliberately not claimed here

- **No effort was probed by invocation.** The effective table comes from the CLI's model
  enumeration, not from running each effort and comparing output. AR-01 extended
  `probeRunner` to exercise every *configured* effort and a read-only tool-use question,
  but that is `doctor --deep` — opt-in, and it spends quota. The table above is still
  enumeration, and re-measuring it by invocation would be a separate exercise.
- **`deniedCommands` is left absent.** The capability shape allows a discoverable deny-list
  and this environment exposes none through the CLI. An empty array would read as "nothing
  is denied", which is the opposite of what was observed.
- **No fixtures yet.** `test/fixtures/responses/agy/` does not exist. AR-02 adds captured
  fixtures for the permission denial, an unsupported effort and a quota error, so those
  paths can be replayed without spending quota.

### Fixtures

| File | Origin |
|---|---|
| — | none captured yet; see above |

---

## OpenAI-compatible endpoints (local or hosted)

**Probed:** 2026-08-17, against a llama.cpp server on the LAN
**Server:** `llama-server`, `--jinja`, one model at a time
**Adapter:** `src/adapters/runners/openai-runner.ts` (`type: openai-compatible`)

> This is the first runner in the table that is **not a coding CLI**, and the difference
> decides everything about it.

Claude Code, Codex and AGY are *agents*: they hold a working directory, read files, run
commands and edit code. An OpenAI-compatible endpoint holds a conversation. There is no
filesystem on the other side of the HTTP call.

### Capability summary

| Capability | Verdict | Proven by |
|---|---|---|
| Non-interactive | ✅ | it is an HTTP request |
| Model selection | ✅ | `model` in the request body; the server usually serves one |
| Reasoning level | ➖ **not differentiated** | no effort dial exists; all four levels declared, none distinguished |
| Structured output | ✅ **`native`** | `response_format: json_schema` is enforced by the server's grammar sampler |
| Read-only mode | ✅ **by construction** | there is nothing to write to |
| Working directory | ❌ **declared false** | the endpoint cannot see the repository |
| Non-interactive **file edits** | ❌ | no tools are sent |
| Non-interactive **command execution** | ❌ | no tools are sent |

### What it can and cannot serve

`supportsWorkingDirectory: false` is not a limitation to work around — it is the fact that
routes the roles. Of the eleven shipped prompts, **nine carry their whole input**:

```
sdd · planning · planning-simple · planning-trivial · plan-review · plan-review-simple
verification · final-review · architecture-impact
```

They receive text and produce text or JSON, and open no file. **Two do not**: `discovery`,
whose own text says *"prefer reading a file over inferring from its name"*, and
`implementation`, which writes the code. Those two declare `workingDirectory: true` in
their front matter, and the resolver refuses to route them here.

This was previously unexpressible: `core/role.ts` required a working directory of every
runner, on the grounds that *"every role requires"* one. The prompts disprove it, and the
requirement now comes from the prompt exactly as `permissions` already does.

### Measured, on a Qwen3.6-35B-A3B MoE (3B active), RTX 3060 Ti + CPU offload

| Question | Result |
|---|---|
| `models` endpoint | answers, names the served model |
| trivial completion | `ok`, ~3.7 s |
| **enforced JSON schema** (enum + nested object array) | **valid on the first response**, ~8–17 s |
| tool calling | works, well-formed arguments, ~6 s |
| review quality on a seeded flaw | found the missing rate limiting *and* the missing test task, severities sensible |

The dense 27B on the same machine measured ~3 tok/s and did not answer a trivial prompt
inside 120 s. **The MoE is the viable shape here**, and it is the one the lab's own profile
table already marks as the only one validated for agentic work.

### What is deliberately not claimed

- **Reasoning levels are declared, not differentiated.** A server is started with one model
  at one quantisation; asking for `high` changes nothing. Declaring all four is honest —
  declaring fewer would make `clampReasoning` fire and record a downgrade that did not
  happen.
- **No tool loop.** The adapter sends no tool definitions, so `nonInteractiveToolGrants` is
  false on both counts. Making this a coding agent would mean building the read/write/exec
  loop, which is a different piece of work with its own security surface.
- **A write stage is refused before the request is sent**, rather than accepted and quietly
  producing nothing — which would be an AR-05a false positive arriving from the opposite
  direction.
