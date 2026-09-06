# Live dogfood — a real feature, real runners

> Every claim here was executed. Where a run is quoted, its `events.jsonl` is the source.
>
> **Sandbox:** `billing-rules`, a four-file Node project with `npm test` green at HEAD.
> **Runners:** `agy 1.1.27` (Gemini 3.8 Flash) and `claude 2.1.263`.
> **Goal:** run the whole pipeline the way a person would, and write down every question
> the record cannot answer.

## Status — all nine closed

| # | Finding | Closed by |
|---|---|---|
| 1 | The operator's `~/.claude/settings.json` reaches every agent | `execution.isolateRunnerSettings` → `--safe-mode` (PRI-18) |
| 2 | Cost, tokens and model returned and discarded | `AgentRunUsage` on the port, filled by two adapters, surfaced by `agent-flow status` (PRI-19) |
| 3 | `agy` barred from 6 of 9 roles | **not closed — the finding was half right.** The criterion *was* applied unequally; the conclusion that `agy` passes it was wrong. See below |
| 4 | A forgotten `expectsNoChange` kills a run | `retry --expect-no-change`, and a button on the Deck (PRI-20) |
| 5 | No elapsed time on stage transitions | `cli/render/progress.ts` |
| 6 | `doctor` says `OK` with auth unverified | `renderVerdict` in `cli/doctor.ts` |
| 7 | Prompt growth measured and never surfaced | `renderPlanningProgress` reads `stage_context_measured` |
| 8 | `agy` wrote `.atl/` into the repo under test | `--disable-slash-commands` on write stages (PRI-18) |
| 9 | Failure evidence shows the tail of the output | `verdictLine` in `core/recovery-policy.ts` |

Three of the fixes came out differently from what this report proposed, and every time a
live CLI is why:

- **`--system-prompt` was the wrong instrument for #1**, and `--safe-mode` alone was not
  enough either. The first replaces the CLI's built-in prompt, which is where its own tool
  conventions live. The second leaves `language` and `outputStyle` in place — measured, on
  the same prompt. Both `--setting-sources ''` and `--safe-mode` are passed.
- **#8's flag cancels read-only mode.** `agy --mode plan --disable-slash-commands` warns
  that plan mode has no effect. So the flag is passed on write stages only — where the
  measured leak was.
- **#3 was half right, and the half that was wrong cost a live run.** This report said the
  criterion was applied unequally, and it was. It implied `agy` would pass a fair one, and
  it does not: `--mode plan` is a planning *workflow*, not a containment mode — it writes
  its answer to `~/.gemini/antigravity-cli/brain/` and returns a pointer, and in the live
  run it returned nothing at all for a stage that produced 2,709 output tokens.
  `--mode accept-edits`, with or without `--sandbox`, overwrote a real file in the working
  directory. No mode both answers inline and leaves the repository alone, so
  `supportsReadOnly` is back to `false` — right value, and now the right reason.

The record below is left exactly as it was written, including the wrong proposals. A report
edited to agree with what was eventually built is a report nobody can learn from.

---

## The end-to-end run this produced

A second sandbox, `cart-fees`, four tasks, `claude` on the read-only stages and `agy` on the
executors. Third attempt; the first two failures are the point.

| Attempt | Died at | Why | Fix |
|---|---|---|---|
| 1 | `architecture-impact` | Every role routed at `agy`; discovery returned empty | `supportsReadOnly: false`, and an empty answer is now a repair problem |
| 2 | first task dispatch | `npm install` rewrote an uncommitted `package-lock.json` | `init` says so before planning is paid for; the halt names the file |
| 3 | — | | |

**FEATURE COMPLETE**, verified independently rather than taken on the product's word:
12 tests written and passing in the integration worktree, the bands correct at every
boundary, `TypeError` on both arguments, README updated with the inclusivity of the lower
bound that nobody asked for and everybody wonders about. Diff: 3 files, +88/−7, nothing
outside the declared scope.

```
Spend
  tokens        230,186 in · 80,510 out · 1,441,466 from cache
  cost          $3.3055 as the runner priced it — not necessarily your bill
```

And the row that answers finding #2 outright — **nothing in the configuration pinned a
model**:

```
discovery            claude   model=claude-opus-5   out=7031    cost=0.328179
sdd                  claude   model=claude-opus-5   out=21023   cost=0.845710
implementation       agy      model=—               out=18154   cost=None
final-review         claude   model=claude-opus-5   out=1718    cost=0.501320
```

`claude-opus-5` came from `modelUsage.canonicalModel`, which is what AD-13 asks for: the
model that answered, without a pinned name anywhere. The em dashes are `agy` reporting
tokens and neither a model nor a price, and reporting nothing rather than a zero is the
contract.

---

## The seven findings, shortest first

| # | Finding | Why it costs you | Fix |
|---|---|---|---|
| 1 | **The operator's own `~/.claude/settings.json` reaches every agent** — this run's SDD came out in Portuguese, under a persona, because that machine sets `language` and `outputStyle` | Reproducibility ends at the home directory; a personal instruction outranks nothing and competes with eleven shipped prompts | `--setting-sources`, and `--system-prompt` instead of `--append-system-prompt` |
| 2 | **Cost, tokens and the model used are returned by the runner and discarded** | An orchestrator that spends model calls cannot say what a run cost or which model wrote it | Port change; the data is already parsed |
| 3 | **`agy` is barred from 6 of 9 roles** by a `supportsReadOnly` criterion the other two adapters never face | The runner with free quota is excluded from most of a run | A decision, then one line |
| 4 | **A forgotten `expectsNoChange` kills a run and nobody can fix it** | Two attempts of model time, then a run you can only cancel | A surface that lets a person mark it |
| 5 | **No elapsed time on stage transitions**, in the terminal or in `status` | A slow stage and a hung stage look identical | Low |
| 6 | **`doctor` says `OK` with auth unverified** | The run dies on its first model call, after discovery already ran | Low |
| 7 | **Prompt growth is measured and never surfaced** — 3.9 KB → 57.4 KB across five stages | The one number that predicts cost is invisible outside `events.jsonl` | It is already an event |
| 8 | **`agy` wrote `.atl/` into the repository under test**, from the operator's own tooling | An agent left 56 KB of untracked files in the repo it was judging | Same fix as #1, applied to `agy` |
| 9 | **The failure evidence shows the tail of the output**, and the tail of a stack trace is `}` | The assertion that failed is in the middle, so the one line on screen says nothing | Low |

Findings 1 and 8 are the same defect at two runners: **the machine's own configuration
reaches the agents**, once as a persona and a language, once as a tool that writes files.

---

## The finding that changes the plan

**A run cannot be served by `agy` alone.** Six of the nine roles refuse it:

```
Roles whose configuration cannot run:
  ✗ architect   ✗ sdd   ✗ planner   ✗ planReviewer   ✗ verification   ✗ finalReviewer
```

The reason is in the adapter, and it is deliberate:

```ts
// agy-runner.ts
// Strict containment is not guaranteed by standalone CLI flags (writes to
// ~/.gemini/antigravity-cli occurred during probe), so supportsReadOnly is
// explicitly declared false per security baseline requirements.
supportsReadOnly: false,
```

**The criterion is applied to one adapter and not the other two.** `claude-code-runner.ts`
and `codex-runner.ts` both declare `supportsReadOnly: true` with no justification written
at all — and both write to a home directory during a run (`~/.claude`, `~/.codex`) exactly
as `agy` writes to `~/.gemini`. Three CLIs, the same behaviour, one of them barred.

The consequence is not academic: the runner an operator has free quota on is excluded from
the six roles that make up most of a run's model calls, and the honest workaround —
routing the read-only roles at Claude — spends the quota the switch was meant to save.

It costs a second thing, which `approve` said out loud on this very run:

```
⚠ the plan review was same-provider: it does not protect against an
  assumption repeated from planning
```

Cross-provider review is a headline property of this product, and the only other installed
runner that could supply it is the one the flag excludes. The warning is well made — it
names what was lost rather than passing silently — and the loss was not the operator's
choice.

**This needs a decision, not a patch.** Either `supportsReadOnly` means *the agent does not
modify the repository under test*, in which case all three qualify and the flag needs a
better name; or it means *no write anywhere*, in which case none of the three qualifies and
two adapters are lying. The current state is the only one that cannot be defended.

---

## What `doctor` says, and what it does not

`doctor` reports `OK` with **authentication unverified for every runner**:

```
agy
  installed          ✓
  executable         ✓
  auth               not verified (use --deep)
```

`OK` is the verdict a person acts on. A run started from this state fails on its first
model call if a token expired overnight, and the failure arrives after discovery has
already read the repository. `--deep` exists; nothing suggests it at the moment it matters.

---

## The finding I did not expect: the operator's own CLI settings reach the agents

The SDD this run produced is in **Portuguese**, for a repository whose README, code and
prompts are all in English. It also opens with a line of conversation before the document
starts:

> Li os quatro arquivos reais antes de escrever. Segue o documento.

Neither came from the prompt. `prompts/sdd.md` says nothing about language or tone. They
came from here:

```json
// ~/.claude/settings.json — the operator's own file
"outputStyle": "Gentleman",
"language": "Portugues",
```

`ClaudeCodeRunner` spawns `claude` with `--append-system-prompt`, `--permission-mode`,
`--output-format` and `--model`. **Nothing isolates the CLI from the person's own
configuration**, so every stage runs with whatever system prompt, output style, language
and `CLAUDE.md` that machine happens to carry.

Three consequences, in order of how much they should worry you:

1. **A persona is steering an engineering agent.** `outputStyle: Gentleman` is a set of
   instructions about tone and behaviour. It is now part of the system prompt of every
   stage, competing with the prompt the product ships.
2. **The same run on another machine produces different artifacts.** Reproducibility ends
   at the operator's home directory. This one is intermittent even here — the SDD carried
   the preamble and `architecture-impact.md` did not.
3. **Any personal instruction is obeyed.** A `CLAUDE.md` that says "never write tests" or
   "always use tabs" is read by an agent whose job the product defines.

**This repository has already fixed this exact defect through a different door.** The
production audit lists as P1: *"`AGENTS.md` followed out of the workspace — the
orchestrator read it with its own privileges and pasted it into the prompt."* That was
closed. The CLI's own settings are the same leak by another route, and nothing in
`src/adapters/` or `docs/security.md` mentions it.

**The CLI already offers the fix**, which makes this an omission rather than a limitation.
From `claude --help` (2.1.263):

```
--setting-sources <sources>   Comma-separated list of setting sources to load
                              (user, project, local).
--restricted                  … ignores user, project and local settings files
--system-prompt <prompt>      System prompt to use for the session
```

Two changes, and the second is the larger one:

1. **`--setting-sources`**, naming only what the run should see. Today the adapter passes
   nothing, so all three sources load — including the operator's `language` and
   `outputStyle`.
2. **`--append-system-prompt` is the wrong flag.** It *appends* to whatever system prompt
   the CLI assembled, persona included. `--system-prompt` replaces it. The product writes
   eleven prompts and then hands them to an agent already carrying instructions it did not
   write — and cannot see.

Worth checking the same question for `codex` and `agy` before assuming they are clean, and
publishing the answer in `docs/runner-capabilities.md`: *what does this CLI load that the
run did not ask for* belongs beside *what efforts does it support*.

## The one worth fixing first: the runner hands over cost and model, and we drop both

Every Claude Code response carries this, and the adapter parses the envelope already:

```json
"modelUsage": { "claude-sonnet-5": { "inputTokens": 2, "outputTokens": 9, "canonicalModel": "claude-sonnet-5" } },
"usage":      { "input_tokens": 2, "cache_creation_input_tokens": 23786, "cache_read_input_tokens": 31810, "output_tokens": 9 },
"total_cost_usd": 0.1524,
"duration_api_ms": 4524
```

**Nothing reads any of it.** The only mention of `usage` in the four adapters is a regex
looking for the words "usage limit" to classify a quota error. So an orchestrator whose
whole job is spending model calls on your behalf cannot answer:

| Question | Today |
|---|---|
| Which model ran this stage? | Only when the config pinned one — and AD-13 says not to pin. `executionDetail` emits `model` only if it was configured, so the honest default produces no attribution at all. |
| What did this run cost? | Nothing records it. |
| How many tokens, and how much was cache? | Nothing records it. |

The third row is the one that stings: `cache_read_input_tokens: 31810` against
`input_tokens: 2` is the difference between a run that cost cents and one that cost
dollars, and it arrives in the response of every single call.

**Cheap, but not free — and the shape matters.** `RunProvenance` today is populated by
exactly one place, `fallback-runner.ts`, and exists to record *that a substitution
happened*. The normal runners return no provenance at all, and `executionOf` falls back to
the resolved configuration — which is why the model is present only when it was pinned.

So this is a port change, not a patch:

1. `AgentRunSuccess` gains an optional `usage` — model actually used, input/output tokens,
   cache reads, cost when the runner reports one. Optional because not every CLI reports:
   `agy` and `codex` may carry less, and an adapter that invents a number is worse than one
   that says nothing (AD-30's rule, applied to accounting).
2. Each adapter fills what its own response carries. Claude Code's is quoted above.
3. `executionDetail` carries it into `stage_completed` / `stage_failed`, and the attempt
   artifact records it per attempt.
4. `analytics-reader.ts` already aggregates per run — a cost axis lands there for free.

The reason to do it first is not the number: it is that **`modelUsage.canonicalModel`
answers the model question without pinning a model**, which is the thing AD-13 forbids and
the thing every "which model wrote this" question needs.

## Where the time goes, and what the terminal says while it does

Measured on this run, `stage_context_measured` and the stage spans:

| Stage | Wall clock | Prompt in |
|---|---|---|
| discovery | 116.5s | 3.9 KB |
| architecture-impact | 125.6s | 16.5 KB |
| sdd | 234.4s | 29.8 KB |
| planning | 89.6s | 45.7 KB |
| plan-review | *(running)* | 57.4 KB |

Two numbers worth sitting with.

**The prompt grows 15× across five stages** — 3.9 KB to 57.4 KB — for a four-file project
whose entire source is twenty lines. `stage_context_measured` records this faithfully,
including the per-source breakdown, and nothing surfaces it: the growth is visible only to
somebody who parses `events.jsonl` by hand. On a real repository the same curve starts
higher and the ceiling matters.

**Planning cost 9.4 minutes and five model calls before a line of code was written**, and
the stage spans sum to the wall clock exactly — every second was model time, none of it
orchestration. That is a good result for the orchestrator and a real cost for the operator,
and it is the number that decides whether this is worth reaching for on a small change.

The terminal during those 116 seconds:

```
  → discovery
  ✓ discovery
```

**No elapsed time, on either line.** A stage that takes two minutes and a stage that hangs
look identical until one of them ends. `agent-flow status` from another terminal is better
— it draws the pipeline with `✓ … ·` — but it does not say how long the current stage has
been running either, or which runner is inside it.

Three lines of output would answer both: the runner and model on `→`, the duration on `✓`.

---

## Observations, ranked by what they cost you

| # | Finding | Cost of the gap | Cost of the fix |
|---|---|---|---|
| 1 | Cost, tokens and model are returned by the runner and discarded | You cannot answer "what did this run cost" or "which model wrote this" | Low — the data is already parsed |
| 2 | `supportsReadOnly` is judged by a criterion two adapters never face | The runner you have free quota on is barred from 6 of 9 roles | A decision, then a one-line change |
| 3 | No elapsed time on stage transitions | A slow stage and a hung stage look the same | Low |
| 4 | `doctor` says `OK` with auth unverified | A run dies on its first model call, after discovery already ran | Low |
| 5 | A successful stage logs two lines | 6 minutes of model work, no record of what it said | Low — the failure path already writes it |

## What this run validated

`execution.recordPrompts`, shipped hours before this run, works against a real runner:
`logs/discovery.log` is 146 lines and opens with the whole prompt between its markers,
redacted at capture. With it off, the same file is two lines for two minutes of work.

That is the fix for finding 5 in one direction only. **A successful stage still discards
what the runner said** — the runner output block is written on the failure path alone. So
the log now holds the question and not the answer, which is the opposite of the asymmetry
it started with.

## A correction to an earlier diagnosis

Two runs in this repository (`AF-2026-005`, `AF-2026-006`) died on
`acceptance_evidence_missing`: the agent concluded correctly that nothing needed changing,
the tree stayed identical to its base, and the run treated that as a failure until recovery
ran out. The remedy exists — `expectsNoChange: true` on the task — and the planner had not
set it.

**This run's planner did set it**, unprompted, on exactly the task that warranted it:

```
TASK-004 | trivial | risk low | expectsNoChange: True
         Verify the gates and the layout constraints that keep them honest
```

So the mechanism works and the planner can reach it. What is missing is not the field: it
is **a net for when the planner forgets**. Today that costs two full attempts of model time
and ends in a run a person can only cancel — there is no way, from any surface, to mark a
task as legitimately unchanged after the plan is written.

The plan itself is good, and worth recording as evidence that the pipeline produces
usable work: four tasks, tests first, implementation second, documentation third,
verification last, with the risk on the arithmetic task and not on the prose one.

## Execution, on `agy`

TASK-001 (write the failing tests) completed. TASK-002 (implement the discount) failed its
validation and the run stopped:

```
AUTO_RECOVERY_EXHAUSTED
Automatic recovery stopped on TASK-002 — validation_unsatisfied.
  Budgets spent   attempts 2 · modelCalls 2 · identicalFailures 0
  Repairs attempted   work_retry → requeued
  Evidence   npm run test → exit 1: }
Do this: Review the attempt evidence, then retry the task
```

**This is the product working.** Gemini 3.8 Flash wrote an implementation that did not
satisfy the test the previous task had written — the assertion wanted a throw and got
`undefined` — the gate caught it, recovery tried once more, and the run stopped and named
the action. Nothing was integrated, nothing was silently accepted.

Three observations from the same screen.

**The evidence line shows the end of the output, and the end of a stack trace is `}`.**

```
Evidence   npm run test → exit 1: }
```

The assertion that actually failed — `operator: 'throws', actual: undefined` — is in the
middle of the trace. A tail is the right instinct for a log and the wrong one for a test
runner, whose verdict is at the top and whose noise is at the bottom.

**`agy` wrote into the repository under test.** After the run:

```
?? .atl/
   .atl/skill-registry.md          # "Auto-generated by gentle-ai skill-registry refresh"
   .atl/.skill-registry.cache.json  # 56K
```

That is an operator's own tooling, invoked from inside a task, leaving untracked files in
the repository the run was judging. It is the same class as finding 1 — the machine's
configuration reaching the agents — with a worse consequence: this one writes. It also
means the `supportsReadOnly: false` decision is right for a reason its own comment does not
give: the comment cites `~/.gemini`, and the actual leak is into the workspace.

**The model is still unattributed, even though it was pinned.** The config pins
`runners.agy.model: gemini-3.8-flash-high`, and `stage_completed` for implementation
carries `runner: agy` and no model. `model-identity.ts` documents exactly why —
`runners.<id>.model` "goes straight to the adapter and no execution record ever sees it" —
so the product knows, and the operator who pinned it in the obvious place still cannot
learn which model ran. Two config keys, one of them invisible to the record.

---

## Reproducing this

```bash
node --experimental-strip-types scripts/run-observability.ts <projectDir> [runId]
```

Reads `events.jsonl` and the attempt artifacts of any run — the same files a person would
open — and prints where the time went, how large each prompt was, and the list of questions
the record cannot answer. The last section is the one to read after a live run.
