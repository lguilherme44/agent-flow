# Findings

What building Agent Flow taught us about driving coding CLIs from a program —
including the things that are still broken.

Everything here was observed by running the tools, not inferred from their
documentation. Where a claim came from a probe, the command that produced it is
in [`docs/runner-capabilities.md`](docs/runner-capabilities.md).

Versions probed: Claude Code `2.1.226`, Codex CLI `0.147.0`, macOS, Node 22.

---

## 1. Every CLI has its own dialect of JSON Schema

Both tools support structured output. Neither accepts the same schema.

| Tool | Requirement | Failure when violated |
|---|---|---|
| Claude Code | `$schema` must be **absent** | `no schema with key or ref https://json-schema.org/draft/2020-12/schema` |
| Codex | `additionalProperties: false` on **every** object | `'additionalProperties' is required to be supplied and to be false` |
| Codex | `required` must list **every** key in `properties`, optional ones included | `'required' is required to be supplied and to be an array including every key in properties. Missing 'likely'` |

Zod emits `$schema` by default and never emits the other two, so a schema
generated from the same contract fails on both tools for opposite reasons.

The third requirement is the one with teeth. It is OpenAI strict mode, and it
means a schema cannot express an optional field. Our task contract has three
(`scope`, `workspace`, `files`). Satisfying it would mean rewriting them as
nullable-and-required on the way out and stripping nulls on the way back — a
lossy translation in both directions.

**What we did:** removed `$schema` in the shared generator; declared the Codex
adapter `structuredOutputStrategy: 'prompted'` and put the schema in the prompt,
validating the response afterwards with a bounded repair loop.

**What this cost:** nothing measurable. The repair loop already existed for
exactly this case. But it means Codex responses are validated after the fact
rather than constrained during generation, and a malformed response costs one
extra round trip.

---

## 2. Neither CLI validates its own reasoning-level flag

```
$ claude -p --effort ultra
Warning: Unknown --effort value 'ultra' — ignoring it and using the default effort.
Valid values: low, medium, high, xhigh, max.
```

Codex behaves the same way: `-c model_reasoning_effort=...` parses as TOML and
an unrecognised value passes straight through to config.

Neither fails. Both continue at their default.

This makes a wrong logical→physical mapping **invisible**. There is no error, no
non-zero exit, nothing in the output. The only symptom is that results are
quietly worse than the configuration says they should be.

**What we did:** the adapters carry the mapping table, and a test asserts that
every value they can produce is one the CLI actually accepts. That catches our
mistakes; it cannot catch a CLI changing its accepted set.

**Still open:** there is no way to verify at runtime that the effort we asked
for is the effort that ran. If a future release renames a level, we will find
out from a warning nobody reads.

---

## 3. Read-only mode is real, and testing it is harder than it looks

Both tools have genuine containment: `--permission-mode plan` for Claude Code,
`-s read-only` for Codex. In both cases the agent tried to create a file, could
not, and said so.

The first attempt at testing this failed for an interesting reason. Asking the
agent to create a file containing the word `BREACH` made it refuse on its own —
it recognised the shape of a prompt-injection canary. That proves the model's
judgement, not the sandbox. Rephrasing to a mundane request ("write a one-line
summary of package.json to notes.txt") got a genuine attempt, which the sandbox
blocked.

**Worth knowing:** plan mode still writes *outside* the working directory. Our
probe left a file in `~/.claude/plans/`. "Read-only" means "does not modify the
project", not "writes nothing anywhere". For a stage that must not touch the
repository that is sufficient — but it should not be described more strongly
than it is.

---

## 4. stdout is not the answer

Codex interleaves the response with hook output, ANSI colour and a token
counter:

```
hook: UserPromptSubmit Completed
codex
PROBE_OK
hook: Stop Completed
tokens used
14.303
```

`--color never` removes the colour but not the hooks, which come from the user's
own configuration and can be anything.

**What we did:** `-o <file>` writes the final message alone; the adapter reads
that. Claude Code's `--output-format json` gives a clean envelope and needs no
equivalent.

---

## 5. A variadic flag will eat your prompt

```
$ claude -p --disallowedTools "Write" "Reply with exactly: PROBE_OK"
Permission deny rule "Reply" matches no known tool — check for typos.
Permission deny rule "with" matches no known tool — check for typos.
Error: Input must be provided either through stdin or as a prompt argument
```

`--disallowedTools` takes `<tools...>` and consumed the positional prompt word by
word. Ordering the flags differently works until the next variadic flag appears.

**What we did:** prompts always go on stdin, for both runners. It removes the
ambiguity entirely and lifts the argv length ceiling.

---

## 6. Text matching on error messages will misclassify a success

Our first error-normalisation rules scanned output for phrases like `usage
limit` and `quota`. Then a real run produced a design document *about booking
quotas and rate limits* — and a perfectly successful response was reported as
`quota_exceeded`.

The envelope had said so plainly: `is_error: false, subtype: success, exit 0`.

**What we did:** structured evidence of success is now checked **before** any
heuristic. Error rules key on `api_error_status` (Claude Code) or the `status`
field of the error envelope (Codex) first; text matching is a secondary signal
only. A wording change now degrades to `execution_failed` rather than
mislabelling something else.

**The general lesson:** any rule that greps model output will eventually match
the *content* rather than the *condition*. Structured signals must outrank it.

---

## 7. The tool caught a contradiction three reviews had missed

This is the finding we did not expect.

The workflow produced a plan, a cross-provider review rejected it for not being
test-first, a revise fixed that, and a second review passed. Then execution ran
for real: the agent wrote the failing tests, Agent Flow ran `npm run test`
itself, got exit 1, and marked the task `review_required` instead of accepting
the agent's report that everything was fine.

The tool was right. **The plan was contradictory.** In test-first development,
the task that writes the RED tests has a validation command that *cannot* pass
at that moment — the tests exist to fail. The planner had attached `npm run
test` to it anyway, and neither the plan review nor the human reading it noticed.

What caught it was the refusal to take the agent's word for it.

**Fixed.** A task now declares `validationExpectation: pass | fail | none`, and
the result is judged against it rather than against exit zero. A test-first task
declares `fail` and completes when its commands fail.

The half that was easy to miss: a task expecting failure whose commands *pass*
is also sent to review. The obvious implementation reads "expected fail, did not
fail — fine, carry on", and it is not fine. Either the test asserts nothing, or
the behaviour it describes already exists, and both deserve a person's
attention. `fail` narrows what correct means; it does not silence the check.

The judgement lives in `core/validation-outcome.ts` as a pure function with the
full truth table under test, because the asymmetric cases are exactly the ones a
plausible implementation gets backwards.

One accepted limitation: `fail` applies to the validation as a whole. It does
not distinguish a new test failing (intended) from a lint error in the same run
(not). Telling them apart would need per-command expectations, and a task whose
lint is broken is caught by the verification stage anyway.

---

## 8. A structured review found things the build did not

After MVP 1 was declared complete, the implementation went through a validation
pass against a written checklist — hypotheses to disprove, not defects to
confirm. All seventeen were real. Reproductions live in
[`test/validation-review.repro.test.ts`](test/validation-review.repro.test.ts),
where the assertions describe the **defect**; each will be inverted as its fix
lands and then moved into the suite of the feature it belongs to.

Two are worth stating here because they are exactly the kind of thing a passing
suite hides.

**Model-authored text reaches a shell.** `Task.validation` is `string[]`, filled
in by the planner. `checkPlan` never inspects it. `TaskExecutor` joins the
entries with `&&` and `runVerification` hands the result to `/bin/sh -c`. The
planning prompt asks for commands from the project's configured list — an
instruction, not a constraint. Since repository content feeds the planning
prompt, a hostile repository can influence a plan, and the resulting command
runs in the Agent Flow process, outside the runner sandbox that is our only
containment. Cutting the specification's command guard (§36) was right — it
could not see the commands the agent ran — but it left this uncovered: nothing
protected the orchestrator from executing text a model wrote.

**The timeout does not fire.** This was filed as "kills the child, not the
tree", which understates it. A grandchild inherits the stdout pipes, and Node
emits `close` only when the process has exited *and* every stream is closed —
so killing the direct child leaves the promise pending. Measured:

```
sleep 20, kill child                 → closed at 405ms
( sleep 15 ) & sleep 20, kill child  → never closed
same, detached + kill(-pid)          → closed at 406ms
```

A run asked to give up after 300ms waited four seconds for the script instead.
This is the normal case rather than an exotic one: every validation command is
shelled out, `npm test` spawns node, and the agent CLIs spawn subprocesses of
their own. The liveness guarantee simply does not hold.

The other fifteen are smaller but the same shape — `FallbackRunner` is never
instantiated outside its own tests, so configuring a fallback has no runtime
effect while `doctor` still counts it when computing routes; a task interrupted
mid-flight stays `running` forever, because `readyTasks` only admits `queued`
and `ready`; `result.json` records `reasoning: 'medium'` regardless of what ran.

**What this says about the test suite.** 540 tests passed throughout. They were
not wrong — every one of them tested something real. But a unit test asserts
that a component does what its author intended, and every one of these findings
lives in the space between components, or in an intention that was never
questioned. `FallbackRunner` has eighteen tests and works perfectly; nothing
asserted that anything constructs one.

---

## 9. A second review of the fixed code found seven more, in the same place

The twelve findings of §8 were closed and the suite went green. A fresh review
of the result found seven more — and every one of them sat in the same category
as the first round: not a wrong line, but a wrong *belief*, held consistently
enough that every test agreed with it.

**Independence was a claim about configuration, not about what ran.** The plan
review artifact recorded `cross-provider` by comparing the planner's configured
runner with the reviewer's. Two ways that lied. A fallback changes who actually
runs, so a reviewer that landed on the planner's own runner still produced an
artifact asserting independence. And ids are not providers: two entries pointing
at the same CLI under different names compared as different, which needed no
failure at all — just a plausible config file. Independence is now judged after
both sides have run, by provider. Where the authors are unknown, it reports
same-provider: an absence of evidence is not evidence of independence.

**A failed task described a run that never happened.** `runner: "unknown"`,
`reasoning: "medium"`. The first reads as a missing value; the second does not —
`medium` is a real level a run can have, so a task configured at `high` that
failed was indistinguishable on disk from one that genuinely ran low. A failure
is provenance too, and it is knowable: the work was routed somewhere specific.
`StageFailure` carries it now. The same fix surfaced a smaller one underneath:
when a fallback fired and the substitute *also* failed, the fallback runner
returned the bare failure with no provenance at all — so an outage across both
providers was recorded against the one that was tried first.

**A successful command reported failure.** `agent-flow task TASK-002` ran one
task, completed it, and exited non-zero, because the scheduler's `complete`
meant "every task in the plan finished". Two different questions had one answer.
A script driving a plan one task at a time could never make progress.

**A test-first task could expect a failure it had no way to produce.**
`validationExpectation: 'fail'` with an empty validation list parsed cleanly.
Nothing ran, nothing failed, and the expectation read as satisfied — so a RED
task that never wrote a test passed its own gate. The schema rejects the
combination now.

**The state machine was documentation.** `core/task-state.ts` encoded the seven
states of §22, transition by transition, with a full test suite. Nothing in
production called it. Every writer assigned states directly, and the policy held
only for as long as each of them happened to agree with it.

That last one is the most interesting, because enforcing it proved the machine
itself was wrong. The table required `queued → ready → running`; the scheduler
went straight from `queued` to `running`, because readiness is computed from the
DAG on every pass and a persisted `ready` would go stale the moment a dependency
failed. The design had abandoned an intermediate state the documentation still
described — and nobody noticed, because nothing checked.

It was also right about something. The recovery path moved an orphaned task from
`running` straight back to `queued`, which the table forbids. That one was a real
defect: `interrupted` exists precisely to record that a process died, and
skipping it left the task on disk looking like one that had simply never
started. The guard is enforced in `StateStore.updateRun` — the single point every
persisted state change already passes through, so it needs no cooperation from
callers and cannot be forgotten by a new one.

**The pattern held across both rounds.** Twelve findings, then seven, and not one
of them was a line of code that did something other than what it said. They were
all agreements between components about something that was never true: what a
review is independent of, what a failed run can report about itself, what
"complete" is a question about, whether a rule that is written down is a rule
that is applied. A test suite written by the same mind that held the belief will
confirm the belief. That is not a coverage problem, and more tests of the same
kind would not have found any of these.

---

## Open problems

Things we found and did not solve. Listed because a README that only describes
what works is a sales page.

### Blocked, no solution proposed

**Claude Code refuses to write under some paths, and we do not know the list.**
Writing to a repository under `~/.claude/jobs/` was denied as a "sensitive
file", with `--permission-mode acceptEdits` set. It surfaces in
`permission_denials` in the JSON envelope. We worked around it by moving the
repository. We do not know what else is on that list, and Agent Flow cannot
detect the condition in advance — it only sees a task come back BLOCKED with an
explanation written by the model.

**No way to confirm the reasoning level that actually ran.** See §2. The flag is
accepted-and-ignored when wrong, so there is no signal to check against.

### Known gaps, solution understood but unimplemented

| Gap | What is missing |
|---|---|
| `doctor --deep` | Prints that live probing is not implemented. Verifying auth for real means spending quota on each runner; the command exists so the shallow check has somewhere to defer to. |
| Local telemetry | The schema exists (`TelemetryEntry`); nothing writes it. Per-stage timings are in the run's event log, but there is no aggregated view. |
| `review --fix` | Reports the corrective tasks the findings *would* produce. Does not create them or feed them back into the pipeline. The generator (`findingsToTasks`) is written and tested; the loop that consumes it is not. |
| Codex strict-mode schemas | Would restore runtime-enforced structured output for Codex. Needs optional→nullable rewriting plus null-stripping on parse. |
| End-to-end tests against real CLIs | The suite runs entirely on fakes. The real-CLI cycles were run by hand, and their findings are in §7 and §8; nothing reruns them. Automating it means spending quota on every push, which is why it has not been done rather than why it should not be. |

### Not validated

**Verification and final review have never run against a live CLI.** They are
covered by tests with scripted agents, and the prompts are written, but the one
real execution stopped at `review_required` before reaching them. Everything
before that point — discovery, impact, SDD, planning, plan review, approval,
task execution — has run end to end against Claude Code and Codex.

**Only Node projects.** The plan called for validating two different stacks.
Both real runs were Node. Stack detection handles Flutter, Python, Go and Rust,
and is unit-tested, but no Flutter or Python repository has been through the
workflow.

**Cost is sampled, not measured.** One SDD invocation on Opus with a 1M context
window reported \$1.37. A full feature is four to five such calls before any code
exists. There is no systematic measurement across models or repository sizes.

**Prompt quality has no automated test, and cannot have one.** This is the
largest risk in the project. The prompts are what determine whether the output
is any good, and the only way to evaluate them is to run them and read the
result. Everything else here is covered by the test suite; this is covered by
judgement.

### Accepted limitations

**Two synthetic fixtures.** `SYNTHETIC-error-auth.json` and
`SYNTHETIC-error-quota.json` are hand-written. Forcing a real 401 means breaking
a working login; forcing a real 429 means burning a quota limit. They are
prefixed so nobody mistakes them for recordings, and — per §6 — normalisation
does not depend on their exact wording.

**No worktrees, so tasks share one working tree.** Concurrency is pinned at 1
and the scheduler stops on the first failure, which bounds the damage. With
parallel execution this becomes unsafe, which is why worktrees are the first
item of the next milestone.

**Agent Flow cannot contain the agent.** It spawns a CLI as a child process and
cannot intercept what that process decides to run. Containment is the runner's
sandbox, not ours. The original specification called for a command guard
blocking things like `rm -rf /` and `git push --force`; it was cut, because a
guard that cannot see the commands is worse than no guard — it produces
confidence without protection.

---

## Design decisions this pushed us toward

Three that were shaped by what the tools actually do, rather than by taste.

**Every per-invocation value travels in a context, never on the adapter.** The
first Codex adapter kept temp-file paths as instance fields. Two concurrent runs
would have overwritten each other's files. Since the scheduler is built to raise
concurrency without the layers beneath it changing, that was a fault waiting for
a configuration change to trigger it.

**Fallback triggers are a type, not a check.** `FallbackTrigger` has exactly
three members — quota, auth, availability. `execution_failed` and
`invalid_output` cannot be written into a config file, because the schema
rejects them at parse time. Retrying bad output on another model replaces a
visible failure with a quiet one, and that had to be impossible rather than
discouraged.

**Health is ternary, and "we did not check" is not a degradation.** A broken
runner should not stop work that is still possible, so the verdict is computed
over role *routes*: `DEGRADED` when everything still has somewhere to run,
`FAIL` only when something does not. The first implementation counted unverified
authentication as a degradation — which made every healthy machine report
`DEGRADED`, since the shallow check never probes auth. An alert that always
fires is an alert nobody reads. Unverified auth became a note; only a genuinely
lost capability moves the verdict.
