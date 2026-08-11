# Findings

What building Agent Flow taught us about driving coding CLIs from a program —
including the things that are still broken.

Everything here was observed by running the tools, not inferred from their
documentation. Where a claim came from a probe, the command that produced it is
in [`docs/runner-capabilities.md`](../runner-capabilities.md).

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
confirm. All seventeen were real. Reproductions were written first, in a single
`test/validation-review.repro.test.ts`, where each assertion described the
**defect**; each was inverted as its fix landed and then moved into the suite of
the feature it belongs to, which is why that file no longer exists.

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

## 10. The whole cycle ran, and the second reviewer earned its keep

The first end-to-end run that reached the Definition of Done was against a real
repository, with Codex planning, Claude implementing, and Codex doing the final
review. It ended `NOT DONE`, and that is the result worth reporting.

The feature was a `maxLength` option on a `slugify` function: truncate the slug,
never leave a trailing dash, never split a word when a dash boundary exists
inside the limit. The implementation cut at the last dash whenever the slug
exceeded the limit — including when the cut had already landed exactly on a word
boundary. `slugify('hello world alpha', { maxLength: 11 })` returned `'hello'`,
throwing away a whole word, when `'hello-world'` is exactly eleven characters,
ends in no dash, and splits nothing.

The path that bug took is the entire argument for §3.2:

    SDD (Claude)            described the behaviour correctly
    plan (Codex)            sequenced it correctly, RED before GREEN
    implementation (Claude) got it wrong
    tests (Claude)          passed — written by the same author, against the
                            same misreading
    verification (Claude)   PASS
    final review (Codex)    FAIL, with the failing input named

Five of those six steps agreed. The one that disagreed was the one running on a
different provider. A same-provider review would have produced six agreements
and a shipped bug, and every artifact would have looked exactly as green.

The same review caught something about agent-flow itself: `init` appends to
`.gitignore`, and when that happens after the last commit, the change lands in
the diff the final review is later asked to judge. The tool contaminated its own
evidence. It is minor and it is real, and no test would have found it, because
no test runs `init` and `review` against the same working tree.

**A killed process found a third one.** A background job was terminated during
discovery, and `agent-flow status` reported `Discovery ✓` for a run whose event
log held a single `stage_started` and no completion. Two causes: `createRun`
initialises `stage: 'discovery'` before anything happens, and the marker was
`index < reached ? '✓' : index === reached ? '✓' : '·'` — a nested ternary whose
first two branches are the same value, left over from a version that
distinguished done from in-progress. Underneath both: `state.stage` cannot
answer the question at all, because "about to start discovery" and "finished
discovery" are the same byte. Progress now comes from `stage_completed` events.
There was no test file for `status` — which is why a dead branch survived two
adversarial reviews.

**The Python run exposed the detector's asymmetry.** `case 'python'` never reads
the project name from `pyproject.toml`, so a package named `retrykit` was
configured as its directory name; `rust` has the same gap with `Cargo.toml`,
while `node`, `flutter` and `go` all read theirs. Python also declares only
`test: pytest` — no lint, despite `ruff` being declared in the manifest it
already parsed to identify the stack. The detector is as good as Node and
shallow everywhere else, and only running a second stack made that visible.

**What this round says about method.** Not one of these came from reading code.
The truncation bug needed a second provider to judge; the `status` bug needed a
process to be killed at the wrong moment; the detector gaps needed a repository
that was not Node. Two adversarial reviews of the source found neither of the
first two. Running the thing is not a formality after the review — it is a
different instrument, and it reaches what review cannot.

---

## 11. The prompt could set the error code

The Python run failed at planning with `quota_exceeded`. Codex had plenty of
quota — it answered a test prompt seconds later — and the log of the failed
stage showed it had produced a complete, valid plan.

The feature under development was a retry helper with exponential backoff. Its
SDD explained, correctly, that retry exists to survive *rate limits*. The
planning prompt embeds the whole SDD. And `codex exec` echoes its prompt into
stderr, because stderr is not an error channel at all — it is the session
transcript:

    user
    Return {"answer":"OK"}. Context to ignore: ... rate limit failures.
    hook: UserPromptSubmit
    codex
    {"answer":"OK"}

Two rules read that transcript as diagnosis, and both were wrong.

`parseEnvelope` took the first parseable JSON object anywhere in stderr, on the
assumption that JSON there means an error envelope. The transcript echoes the
*answer* too, so a successful structured reply parsed as an error envelope. That
disarmed the success guard, whose condition is "exit zero and no envelope" —
which means the guard was never armed for exactly the four stages that request
structured output, the same four whose prompts carry the SDD.

With the guard down, the text rule ran and matched `rate limit` in the echoed
prompt.

So the subject matter of the work set the error code. Any SDD about throttling,
billing, quotas or backoff would do it. And the consequence is worse than a
wrong label: `quota_exceeded` is one of the three fallback-eligible codes, so
with fallback configured this spends the *other* provider's quota to escape a
limit nobody hit — and the run records a substitution that had no cause.

Both halves are fixed. Envelopes are read only from lines the CLI marked
`ERROR:`, and the prose rules read only those lines too. An unmarked failure now
lands on `execution_failed`, which is deliberately not fallback-eligible: an
unknown failure should stay visible rather than be routed around.

The Claude adapter had the same shape from a different angle — its text rule
read `envelope.result`, which is the model's own answer whenever the envelope is
not an error. Its structural success guard made that unreachable in practice,
but "unreachable because another check happens to hold" is how the codex bug
worked too. The rule now names its evidence: `result` counts only when the
envelope calls itself an error.

**The principle this belongs to.** The project already refuses to let a
model-authored string become a shell command. This is the same boundary one step
over: a model-authored string must not become a *classification* either.
Deciding what went wrong is a control-flow decision, and control flow may not be
sourced from content. §6 found the first instance and fixed the instance. What
was missing was the rule — which is why it came back in the other adapter, in a
form the first fix did not cover.

---

## 12. Two reviewers, two providers, the same defect — and I overruled the first

The second stack went through the whole workflow: a Python package, planned by
Codex, implemented by Claude, reviewed by Codex. It also ended `NOT DONE`, and
the way it got there is the strongest evidence in this document for why there
are two review gates rather than one.

Before any code existed, the plan review said:

> nenhum dos onze testes exercita o caminho do default. Uma implementação com
> `backoff: float = 0.05` (ou `5.0`, ou `0`) passa a suíte inteira verde.

I forced the gate with `--force` and let it run.

After the implementation, the final review — a different provider, at a
different point in the pipeline, with no sight of the earlier review — said:

> No test proves that the default backoff is exactly 0.5. Every new timing test
> passes backoff explicitly, so changing the declared default would leave all
> eleven tests green.

The same defect, found twice, independently. The workflow was right at both
ends; the human in the middle was the failure. That is worth stating plainly,
because the value of a gate is not that it is clever — it is that it holds when
the person operating it is in a hurry.

It is also what made the `--force` finding concrete. `approve --force` promised
in its own help that the override was "recorded on the run", and it was: as
`forced: true` inside a `run_approved` event that `status` never opens and the
Definition of Done never consults. So the run that overruled a correct review
looked exactly like one whose review had passed. RK-12 and AF-R02 are the same
lesson; this was the third time, and the third different place. A forced
approval is a degradation now, and `review` prints the run's degradations above
the verdict — the screen that says FEATURE COMPLETE is the one that has to say
on what terms.

**Both reviewers, in both stacks, also caught the tool contaminating its own
evidence.** `init` appends to `.gitignore` and writes `AGENTS.md`, and it runs
before the first feature, so unless the user commits in between, both sit in the
working tree when `review` reads the diff. Codex named `AGENTS.md` "an
instruction file that can alter future agent validation and workflow behavior" —
which is precisely why it should not arrive unreviewed inside a feature
delivery. The changed-file list now marks what agent-flow wrote itself, and
`init` says to commit before starting. Marked rather than filtered: a
hand-edited AGENTS.md is a real part of a change, and hiding it to reduce noise
would trade a wrong finding for a missing one.

**What the second stack was actually worth.** Not the Python-specific bugs —
there were two, both in the stack detector. It was that running a different
shape of project put a different SDD in front of the same code, and that SDD
happened to be about retry and rate limits, which is how §11 surfaced. A second
stack is not a checkbox for portability. It is a second sample of the *input
distribution*, and the input is what this system routes on.

---

## 13. A run reached DONE, and the last thing in its way was us

The Python repository went through the corrective loop and came out the other
side: `FEATURE COMPLETE`, all four gates of the Definition of Done satisfied.
It is the first run to get there, and the route is worth reading in order.

    feature       Codex plans, Claude reviews        FAIL
    revise        Codex replans                      FAIL — a new finding
    approve --force                                  degradation recorded
    run           three tasks, RED then GREEN        all completed
    review        Codex rejects it                   NOT DONE, two real defects
    review --fix  findings become FIX-001, FIX-002   gate reopens
    approve --force, run                             corrections executed
    review        clean diff                         PASS — FEATURE COMPLETE

The defect that drove the corrective round is the same one from §12: no test
exercised the declared backoff default. The plan review predicted it, I forced
the gate past it, the final review found it, `--fix` turned it into a task, and
the task produced a test. That test was then verified by mutation rather than by
its name — changing the default from `0.5` to `0.05` kills it, and wrapping the
re-raised exception kills the other one. A test that passes proves nothing about
what it would catch; a test that fails when you break the thing does.

**Closing the loop found two defects in the part that already existed.** The
generator emitted `validation: []`, so a fix for a review finding would have run
no validation at all — the single outcome this workflow exists to prevent. And
`FINDINGS` described that generator as "written and tested" when it had neither
tests nor callers. A line of documentation asserting coverage that does not
exist is worse than saying nothing, because it stops the reader from checking.

**It also found a design bug that no unit test could reach.** Adding FIX tasks
changes the plan, which reopens the approval gate — correct, and deliberate: a
person approved a set of tasks and this is a different set. But the gate then
re-read `plan-review.json`, a verdict about the *previous* plan, and refused the
corrected plan while quoting the very finding a FIX task had been created to
resolve. A review is a statement about one specific document. `ReviewResult`
carries `planHash` now, and the gate says "this plan has not been reviewed" —
true, and forceable — instead of citing findings that are neither.

**And the last three findings were ours.** With everything else resolved, the
final review still failed on `.gitignore`, `AGENTS.md` and `.atl/` — all written
by `init`, none by the feature. Rather than change the design on a hypothesis, I
committed the scaffolding, which is exactly what `init` now tells the user to
do, and re-ran. The review passed. The tool was right and the operator was
wrong, which was worth one review's quota to establish rather than assume:
the alternative was filtering files out of the diff, and a hand-edited
`AGENTS.md` changes how every future agent behaves and is squarely a reviewer's
business.

**What the whole day argues.** Nine defects were fixed here, and not one came
from reading the code. Two adversarial source reviews had already passed over
most of them. They needed a second provider to judge, or a process killed at the
wrong moment, or a repository that was not Node, or a feature whose subject
matter happened to be rate limiting. Review and execution are different
instruments, and they do not overlap as much as a green suite suggests.

---

## 14. The corrective loop's normal path required waiving its own gate

The run in §13 reached `FEATURE COMPLETE`, and the table above shows how:
`approve --force` appears twice. The second one is the interesting one.

`review --fix` appends corrective tasks. That changes the plan, which changes its
hash, which invalidates the approval — all correct, and deliberate. What it did
not do was give the corrected plan a review. The only `plan-review.json` on disk
described the *previous* document, so `approve` refused it as unreviewed, and the
way forward was `--force`.

`--force` records a degradation on the run saying the review gate did not hold.
So the ordinary route through a corrective round left every run asserting, in its
own state file, that its plan had not really been reviewed. A gate whose normal
path is an override is not a gate — and worse, `forced_approval` stops meaning
anything once it appears on every corrected run.

The fix is not to relax the check. The check is right: a verdict about one
document is not a verdict about another. The fix is that there are now two
producers of plans and only one of them had a review. Plan review moved into a
service both use, and the corrective round takes its plan through it.

**Judging that review honestly needed a second look at who wrote the plan.** The
original tasks came from the planner. The FIX tasks are a transcription of the
final reviewer's own findings — so a plan review run by that reviewer's provider
is a fresh context, not an independent one. Independence for a corrective plan is
assessed against both authors, and the run in §13, whose reviewer and planner sat
on different providers, would now correctly report `same-provider-fresh-context`
for the corrective round rather than claiming a protection it did not have.

**Two things nearby turned out to be fabrications.**

A review with no `planHash` was treated as covering whatever it was shown. That
was a compatibility shim for artifacts written before the field existed, and it
invents the one relationship the gate exists to verify. It is now
`review_unverifiable` — refused, forceable, and never automatic.

And a finding with no requirement produced a FIX task citing `FR-001`. Most
findings name no requirement: `out_of_scope`, `missing_test`, `security` and
`architectural_deviation` are about the shape of the work. So the common case
manufactured a citation, and coverage checking then counted it as real work
against a requirement nobody had connected it to. Corrective tasks now carry
`correctiveFor` — the stage, the finding type, the severity, the description, and
the requirement *only when the finding named one*. Planned tasks still must cite
a requirement; the exception is narrow and stated in the schema.

**And the event log had the same disease as the artifacts once did.**
`stage_completed` recorded the runner the role *resolved to*, not the one that
ran. Under a fallback the audit trail credited the runner that was down. The
invariant — actual execution beats configured intent — held everywhere except in
the log that exists to record what happened. Found while building telemetry on
top of it, which is the argument for building the reader: nothing else had ever
asked the event log a question it could get wrong.

---

## 15. Building a reader found the bugs that writing had hidden

The dashboard is read-only, and it still changed the core three times — because
nothing had ever asked the persisted state a question it could get wrong.

**Every task but the last one had lost its log.** `StageRunner` wrote
`logs/<stage>.log`, and implementation runs once *per task*. Nine tasks, one
file, last writer wins. Nobody noticed because nothing read the logs back; the
CLI prints its own progress, and the file existed, which is what "it works"
looks like from the outside.

**The event log recorded the runner that was down.** `stage_completed` carried
`resolved.runner` — the runner the role was configured for — rather than the one
that executed. Under a fallback the audit trail credited the wrong one. The
invariant that actual execution beats configured intent held in every artifact
and failed in the log whose whole job is recording what happened. Found while
building telemetry on top of it.

**The dashboard would have gone quiet, and looked idle doing it.** Query keys
carried the project as a positional segment, and a single-project dashboard
fetches without naming a project while every SSE event names one — so the
invalidation never matched. Everything rendered; nothing updated. That failure is
indistinguishable from a run that is simply not doing anything, which is the one
mode a live view cannot afford. Keys now carry their scope as an object, which
the cache matches partially, and a test asks the real matcher rather than
comparing arrays.

**And four defects the screenshot found that no assertion would have.** A card
title wrapping into a fixed-height header and pushing the card's own content out
of view. An artifacts list clipped with no indication that more existed. `sdd`
title-cased to "Sdd" in the one place it is not spelled the way the CLI spells
it. A duration badge upper-cased into `25M04S`, which is a different unit in
every other context a reader has ever seen. All four render, none throws, and
every one of them is wrong.

**What the dashboard deliberately does not do.** It has no write path. Approve,
run, retry and revise are state transitions the StateStore owns, and an HTTP
handler performing one would be the parallel state machine §60 rules out. It
also never accepts a filesystem path: the browser names a project by an id the
server issued, so there is no request shape that can address a directory the
operator did not register — which is a smaller surface to defend than path
normalisation on three platforms.

---

## 16. Every element was present and the screen was still wrong

The dashboard shipped with everything §66–§78 lists. Run header, nine-stage
pipeline, five task metrics, table, inspector with four tabs, four summary
cards. Fifty-two DOM assertions passed. Put it beside the reference and it was
obviously a different product.

The cause was one decision repeated sixteen times: `rounded-lg border
bg-surface` on every region. Run, pipeline, each metric, table, inspector, each
summary — the same rectangle at the same weight. Sixteen things of equal
importance is not a hierarchy, it is a grid, and the eye has nowhere to land.
The screen read as an admin panel because that is what a uniform grid of cards
*is*, regardless of what the cards contain.

**What actually fixed it was subtraction.** Two surfaces instead of one, and a
question asked of every remaining border: why does this need to be an
independent plane? The run and its pipeline became one panel, because they
answer one question. Five metric cards became a strip inside the tasks header,
because they are a caption to the table rather than a peer of it. The pipeline
stopped being nine tiles and became connected chips, because a sequence has to
be legible as a sequence and a connector does that in one glance where nine
identical rectangles do not.

**One addition mattered as much: something had to go *below* the page.** The log
view is darker than the ground everything else sits on. Nothing else in the app
is, which is precisely why it reads as a terminal without needing a heavier
border to announce itself. Depth was available the whole time and the first pass
only ever went up.

**Three of the ten problems were only visible in a picture.** The title column
collapsed to 40px under auto table layout, so every task read "Cri…". A single
unbreakable word — "Implementation" — clipped in the pipeline at every viewport.
At 1280×800 the terminal rendered two lines tall. None throws, none fails an
assertion, and all three make the screen useless for the thing it exists to do.

So the layout is now checked by screenshot, at both target viewports, against a
fixture rich enough to have edges: nine tasks, a stage in flight, four models, a
corrective task, durations spanning three orders of magnitude. **An empty run
has no edges, and layout is only ever wrong at the edges** — which is the real
lesson, and the reason the previous milestone's green suite proved so little.

**A note on what did not change.** Not one line outside `apps/web`. The core,
the workflow, the StateStore, the server and its security model were untouched,
and the redesign needed nothing from them — every field it renders was already
being served. A visual problem that requires reshaping the data underneath it is
usually a sign the data was wrong, and this one was not.

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
| ~~`doctor --deep`~~ | Closed. Probes each installed runner through the `AgentRunner` port with a one-line read-only prompt at the lowest effort it supports, and folds the answer back into the verdict. Missing credentials now fail the environment — the shallow check's own note said to use `--deep` "to check for real", and it did not. A spent quota and a failed call are reported without changing the verdict: a billing window is not a property of the machine, and a bad answer is not a broken runner. |
| ~~Local telemetry~~ | Closed, as a projection rather than a file. Stage entries are derived from `events.jsonl`, task entries from the result files; `summariseTelemetry` aggregates by runner, model, role and stage with fallback and retry counts. Nothing is stored, so nothing can disagree with the state and the event log. Reachable via `status --json`. |
| ~~`review --fix`~~ | Closed. Findings at or above `medium` become FIX tasks in the plan, which reopens the approval gate — the plan is no longer the one that was approved. The old generator claimed here to be "written and tested" had no tests at all, and produced tasks with `validation: []`: a fix for a review finding that ran no validation. |
| Codex strict-mode schemas | Would restore runtime-enforced structured output for Codex. Needs optional→nullable rewriting plus null-stripping on parse. |
| `packages/*` split | §63 puts core, contracts, config and adapters in separate packages. The dependency *direction* it exists to guarantee is enforced today by an executable architecture test; the directory move is not done, because rewriting every import in a validated CLI buys nothing functional and risks the thing that works. |
| ~~UI write actions~~ | Closed in UI-B. Approve, reject, revise, retry and start are use cases in `app/run-actions.ts`, and the CLI and the HTTP API are two adapters over them — not two implementations. An architecture test asserts that no handler writes state, decides an approval or accepts a plan hash. |
| ~~`agent-flow-ui-reference.png`~~ | Closed. The file is in the repository — at [`docs/assets/agent-flow-ui-reference.png`](../assets/agent-flow-ui-reference.png) since the documentation was reorganised — and the dashboard was rebuilt against it. See §16. |
| ~~Visual regression in CI~~ | Closed in UI-D. The blocker was stated as "this machine cannot generate Linux baselines", and the mistake was treating the platform as the pinned thing. Both sides now use one pinned Playwright container: `scripts/visual-linux.sh` generates in it, CI compares in it, and `test/visual-ci.test.ts` fails if the two ever name different versions. |
| ~~E2E through the real server~~ | Closed in UI-D. Sixteen Playwright scenarios boot the real `agent-flow ui` against a real temp repository and stub nothing; the coding CLI is replaced at the executable boundary, so both real adapters still do the parsing and no quota is spent. An architecture test forbids `page.route`. |
| Windows | Path containment is decided with `node:path` and its Windows rules are asserted on Linux with `path.win32`, so a workspace on Windows resolves correctly. Two things remain: no CI job runs there, and the process timeout cannot signal a process tree — `detached` opens a console rather than a process group, and killing the tree needs `taskkill /T /F`. |
| A distinct "rejected by a human" run status | `plan_rejected` means both "the automated plan review returned FAIL" and "a person said no". Approving over the second is now a deliberate, recorded act (see UI-D), but separating the two properly is a contract change of the same shape `cancel` needs. |
| ~~Inspector as a drawer below 1200px~~ | Closed. Below 1200 the inspector opens as an overlay and the table takes the full width; the choice is made in JavaScript so only one inspector is ever in the document. Validated at 1440, 1280, 1200 and 1024. |
| Long titles truncate on one line | A feature description of 80+ characters and a task title over ~28 characters do not fit beside a run id, a progress bar and three buttons — or in a seven-column table with the inspector open. Both truncate with the full text on hover. Widening either would take the space from the other. |
| End-to-end tests against real CLIs | The suite runs entirely on fakes. The real-CLI cycles were run by hand, and their findings are in §7 and §8; nothing reruns them. Automating it means spending quota on every push, which is why it has not been done rather than why it should not be. |

### Not validated

**Node and Python have been through the whole workflow; nothing else has.**
Stack detection also handles Flutter, Go and Rust and is unit-tested, but no
repository in those has been through it. There is no Flutter SDK on the machine
this was built on, which is a reason and not an excuse.

**One run has reached DONE; the corrective loop has run once.** That is one
sample. The loop converged on the second review, and there is no evidence yet
about what happens when a correction introduces a new finding — the revision
round in §12 did exactly that at the planning stage, so it is not hypothetical.

**No live fallback, and no live reasoning clamp.** Both are covered by tests
with scripted runners. Forcing them for real would mean exhausting a quota or
misconfiguring a runner on purpose, and a staged outage proves less than it
appears to: it exercises the handler, not the condition.

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

---

## What UI-B changed, and the three claims it caught being false

The dashboard grew five pages and the ability to write. Most of the work was
ordinary; four things in it are worth writing down.

**A modal Radix dialog returns focus to a `Trigger`, and to nothing without one.**
Replacing the hand-rolled task drawer with `@radix-ui/react-dialog` bought the
focus trap, Escape, and the `aria-hidden` that makes "one dialog" true for a
screen reader rather than only for the DOM. It also silently broke focus return:
`DialogContentImpl` overrides its own `FocusScope` restore with
`context.triggerRef.current?.focus()`, and these dialogs open from table rows and
ordinary buttons rather than from a `Dialog.Trigger`. Left alone, closing dropped
focus on the document body — in a browser, not just in jsdom. Every dialog here
supplies its own `onCloseAutoFocus`, and captures the element to return to in a
*layout* effect: a passive effect in the parent runs after the child that has
already moved focus into the panel, so it reads the close button instead.

**Playwright's `reuseExistingServer` will serve a stale bundle at you.** Several
screenshot baselines were generated against a build from an earlier run, because
the `webServer` command is `npm run build && vite preview` and Playwright skips
the whole command when something is already listening. Two of those baselines
recorded a bug as correct. The visible symptom was a date format that had already
been changed in the source. The lesson is smaller than the bug: a baseline is only
worth what the build behind it was.

**A screenshot cannot fail on an ellipsis.** Truncation looks deliberate, which is
exactly why nobody notices it. The visual suite now measures instead: any element
whose `scrollWidth` exceeds its box, has `text-overflow: ellipsis`, and carries no
`title` is reported by name, across every route and every viewport. A `title` is
the opt-out, and it means something specific — "this value is genuinely variable,
here is the rest". That check found five real clips, one of them pre-existing in
the task table, and one that only a live run had: the real
`architecture-impact` prompt declares four required variables and the fixture
declared one.

**Three pieces of copy had quietly become false**, and this is the failure mode
worth naming. The breadcrumb hardcoded "Runs" as its third segment — true of the
two pages that existed, a lie the moment there were seven, so the Projects page
announced itself as Runs. The approval card told people to run `agent-flow
approve` while the button to do it sat forty pixels above. And the analytics page
claimed the implementation stage was excluded from "time per stage" to avoid
double-counting; it never was. Telemetry carries one entry per planning stage and
one per *task*, and every task entry's stage is `implementation` — so that row is
the sum of the tasks, and the panel beside it is the same total split by executor
role. Running the page against a real run is what showed it: 7m43s of
implementation across nine calls, and 4m00s + 2m12s + 1m30s of executor time that
adds up to the same thing.

None of those three were caught by a test, because each was a sentence rather than
a behaviour. The first two are now derived from the same table the sidebar reads
and from the run's actual state; the third is a label that describes the
arithmetic instead of contradicting it.

## The rules of UI-B, as tests

The architectural review the milestone required is a list of ways the browser and
the CLI could start enforcing the workflow separately — the kind of divergence
that is silent until it matters. Reviewing for them by hand works on the day
somebody looks. So they are checks now, nine over the server and five over the
browser.

The server ones assert that no HTTP handler calls `updateRun`, `appendEvent` or
`writeArtifact`; that nothing under `src/server` imports `app/approval`,
`app/scheduler`, `core/dag` or `app/task-executor`; that no write request schema
accepts a `planHash`, a `path`, a `command` or a `cwd`; that no request schema
takes an unconstrained `z.string()`; that no provider or model name appears
anywhere in the server; that no route matches `/pause`, `/resume` or `/cancel`
while the core has no semantics for them; and that both adapters reach the use
cases through `app/run-actions.ts`.

The browser ones assert that no store, reducer or `RunStateSchema` exists; that
nothing imports the contracts as a value; that `fetch` appears in exactly one
file; that no plan hash appears in a request body; and that the only timer in the
whole app is the one belonging to the SSE fallback.

That last one failed when it was written, against code written the same day. The
job-status query polled every two seconds — a reasonable-looking choice, and
exactly the thing §89 forbids. It was replaceable: a job's lifecycle now goes down
the same stream as everything else. It has to be published explicitly rather than
inferred from the run, because a job the workflow *refused* never touched
`state.json`, so the watcher would never see it happen and a page waiting for the
run to change would wait forever.

---

## AF-L01 — the lock, and the bug the race test found in it

Two processes could schedule the same run. `agent-flow run` in a terminal and
`POST /runs/:id/start` in the local server would both move the same task to
`running`, spawn the same agent, pay for it twice and write over each other's result
files. The server's in-process guard covered a double-clicked button and nothing
else. This was the largest operational risk in the tool.

**The obvious implementation is wrong, and it took real processes to show it.**

The first version was one file, `execution.lock`, created with `open(path, 'wx')` —
atomic, no TOCTOU, and correct for acquisition. Recovery of a lock whose process had
died was the problem: read it, find the pid gone, `rename` it aside, then create your
own. Renaming rather than deleting was already the careful choice, because
`remove` then `create` lets a second process delete the *winner's* fresh lock.

Eight real child processes racing one abandoned lock failed two runs in five. The
data named it exactly:

```text
ACQUIRED 59013 … stale=null      ← created in the empty window
ACQUIRED 59014 … stale=59012     ← won the rename, then created
```

A process that judged the lock stale at T renamed whatever was at that path at T+δ.
By then it could be a *live* lock somebody else had published — in the gap the rename
itself had created. Two holders, both convinced.

Every repair for that is a conditional delete: "remove this file only if it is still
the one I judged". POSIX has no such call, and every layered fix — a reclaim mutex,
verify-then-restore, an inode check — moves the same race one level down. So the lock
stopped needing one.

**Generations.** A claim is `execution.lock.1`, `.2`, `.3`; the holder is whoever owns
the highest number present; claiming is a single exclusive create, and creating the
file *is* publishing. A stale holder is superseded rather than removed, so contention
never destroys anything a live process might be relying on. Two details finish it: a
claimant confirms its generation is still the highest before returning a lease, so a
process that wins a low generation late discovers it lost *before* doing any work; and
the files below a confirmed-highest generation are tidied on the way in, which is safe
precisely because their owners are by definition not the holder.

Forty rounds of eight processes — 320 attempts, both fresh and stale — produce exactly
one holder per round and zero overlapping holds.

**Two things the test suite taught us about testing a lock.**

An in-memory filesystem cannot prove mutual exclusion. It is single-threaded and has
no window to lose, so the policy tests are green on a design that fails in two runs
out of five with real processes. The race suite bundles the lock with esbuild and
spawns real children; the fake covers stale recovery, cross-host caution and the
refusal shape, which is all it can honestly cover.

And counting acquisitions is the wrong assertion. A refused process retries, and a
retry that lands after the holder released is a perfectly correct second acquisition —
the first version of the test failed on behaviour that was right. The invariant is that
no two holds *overlap*, which needs the interval stamped after acquisition and before
release, so the measured window sits inside the real one. Stamping after the release
syscall made a slow unlink look like a stolen lock.

**No heartbeat.** A pid is a liveness signal that needs no maintenance: nothing has to
be refreshed, so nothing can fail to be refreshed. A timer-based lease adds a second
way to be wrong, and the way it is wrong is the exact failure the lock exists to
prevent — a slow run whose heartbeat missed its window would have its lock taken while
it was still executing. Process death by any means, including Ctrl-C and SIGKILL, is
covered by liveness rather than by cleanup, which is also why no signal handler was
added: it would be global shutdown machinery for a case stale detection already
handles.

The residual risk is pid reuse, and it errs toward refusing a legitimate run rather
than toward running two. That is the direction to err in.

**A lock from another machine is never judged.** The pid in it names a process on
another host, and a local liveness check would answer a question about whichever local
process happens to share the number. Agent Flow is local-first, this is not a
distributed lock, and it does not pretend to be one: a foreign lock is held until
somebody removes it deliberately.

---

## AF-L01.1 — two ways to leak a lock that had nothing to do with the lock

The generational algorithm survived review. The code holding it did not. Both bugs
below leave a claim on disk that stale detection can never clear, which is worse than
losing the race the algorithm was rewritten to win: a lost race is two executions, and
these are a run that can never be executed again without a person deleting a file.

**The audit trail could strand the lease.** `withExecutionLock` acquired, appended
`stale_execution_lock_recovered` and `execution_lock_acquired`, and *then* opened its
`try/finally`. Both appends write `events.jsonl`, and a full disk, a permission change
or any I/O error there throws out of a function that has already claimed the run. The
claim left behind names the process that is still executing, so liveness reports it
alive and every later `start`, `revise` and `retry` is refused — for as long as the
server lives, which for a long-running server is indefinitely. The fix is one line of
placement: the `try` opens on the line after the lease exists, and the audit happens
inside it. Nothing about the lock changed.

The `finally` then needed an order and a policy, because it does two things that can
fail. Release is physical and goes first; the event is a record and goes second, so a
failed append can never leave a claim on disk. They are treated differently on purpose:
`lease.release()` propagates, because it is the one failure that keeps the run refused
and there is no other channel to say so, and the `execution_lock_released` event is
best-effort, because by that line the claim is already gone and throwing from a
`finally` would swap a real execution error for a logging one. The loss is visible
anyway — an `execution_lock_acquired` with nothing closing it.

**A claim can be created and not written.** `createExclusive` is `open(path, 'wx')`
then `writeFile`, and the open is what wins the race — it wins it before a single byte
exists. A failing write left an empty `execution.lock.N` behind, and an empty claim is
the worst possible one: the reader treats an unreadable claim as held, which is right,
and there is no pid in it for liveness to judge, so no recovery path can ever reach it.
Fail-closed plus unjudgeable is a run locked forever. So a claim this call created and
could not fill in is removed again — only that path, only on the write failure, never
on `EEXIST`, and the original error is what propagates rather than whatever the cleanup
made of it.

Neither bug is reachable through the in-memory fake: it has no separate open and write,
so it has no state in which the file exists and the content does not. The regression
test for it stands in for the two members `createExclusive` uses and lets the open be
real, so the file it asserts about is a real file on a real disk. The four for the lease
go through `retryTask` rather than a hand-written `try/finally`, because the shape of
production was the bug and only production can be asked whether it still has it.

**Recovery copy named a file that does not exist.** The refusal for an unreadable claim
told the operator to remove `.agent-flow/runs/<id>/execution.lock` — the single-file
path from the design that was replaced. Wrong instructions are worse than none: they
teach the reader that the message is guessing. It now names the mechanism that exists,
and it leads with the check rather than the delete. An unreadable claim is the one case
where Agent Flow knows nothing about who holds it, so `rm` is the last step and
"confirm nothing is running" is the first.

**And `FileSystem.rename` was deleted.** It existed for the reclaim-by-moving-aside
design, that design is gone, and nothing had called it since. A port kept for a
mechanism nothing uses is how the mechanism comes back: the next person who needs to
move a file finds it declared, assumes it is load-bearing, and builds on the thing that
failed. An architecture test now asserts its absence, and another asserts that no
operator-facing string names a lock file without a generation.

**Volume, not a green run.** A lock race is not a test that passes; it is a test that
passes often enough. The design this one replaced failed two runs in five, which a
single green race suite would have cleared. So the stress run is in the repository
rather than in somebody's shell history — forty rounds of eight processes against a
fresh run and forty more against an abandoned one, 640 processes, zero overlapping
holds. It is opt-in behind `AF_LOCK_STRESS=1` because 640 spawns is not what every
`npm test` should pay for; the eight-process race suite still runs every time.

---

## AF-L01.2 — the lock ordered execution, and left the gate outside it

AF-L01 made `start`, `revise` and `retry` mutually exclusive. `approve` and `reject`
stayed outside, and the hole that leaves is not a corrupted file. It is a run that says
something untrue about itself:

```text
start acquires the lease
→ scheduler spawning agents against the plan

reject
→ status = plan_rejected

scheduler keeps going
```

The run now records that its plan was turned down while the work that plan describes is
being done. The only honest orderings are "rejected, therefore not executed" and
"executed, and rejecting afterwards is too late" — so `reject` takes the same lease the
other three take, and is refused rather than queued. A rejection that waited would land
on a run that had already finished, which is the retrospective rejection this exists to
prevent. Not a second mutex, and not `describe()` followed by an update: that is the
`exists()`-then-`write()` shape the whole mechanism exists to avoid.

**Ordering was necessary and not sufficient.** With the lease alone, "rejected therefore
not executed" still held only by luck. `reject` writes `status` and nothing else, so a
run approved *before* it was rejected satisfied every gate in `execute` — the approval
flag, the plan hash, the SDD — and executed a plan a person had explicitly refused.
`execute` now refuses a `plan_rejected` run outright, checked before the approval gate
rather than through it, because it has to hold even where
`approval.requiredBeforeImplementation` is off. That switch turns off the review
ceremony, not a person's "no".

**Approve was the harder question, and the answer is the same.** The test is not whether
approving during an execution looks harmful; it is whether there is a moment at which it
is *useful*. There is not. `start` reads the gate once, before the first runner is
spawned, so an approval landing afterwards changes no execution — it only records that
one was authorised when it was not. Under `revise` it is worse than useless: `replan`
clears the approval and then rewrites `plan.json` through the pipeline, so an approval
racing it hashes whichever version of the plan happened to be on disk — the old one, or
a new one nobody has read. The plan hash catches most of that, and stops catching it the
moment anybody passes `--force`. Safe-as-long-as-you-do-not-force-it is safe by
accident. So `approve` takes the lease too, and `describeApprovalGate` does not: it is a
read, and refusing to *show* somebody the gate because a run is busy helps nobody.

`LOCK_OPERATIONS` grew `approve` and `reject` rather than reusing `run`. A refusal that
said "already being executed" about a rejection would send the reader looking for a
scheduler that does not exist; diagnostic metadata that lies is worse than none.

**Holding the lease for real, in a test.** The in-flight cases pause a genuine `revise`
inside its planning pipeline — a `ProcessRunner` that stops in the first agent
invocation and waits — so what the racing `reject` meets is the production
`withExecutionLock` body, held open. Six of the seven new tests fail without the change.

### Open — a claim caught mid-write reads as unreadable

Found by the race suite failing once in roughly thirteen full-suite runs, under the CPU
contention of the rest of the tests running alongside it. Not a safety failure: no two
holders overlapped, and none can. What broke was the *refusal message*.

`open(path, 'wx')` is what wins the race, and it wins it before any content exists. A
reader that arrives in that window sees a file it cannot parse and — correctly, by
design — treats it as held-but-unreadable. Acquisition then retries, but `MAX_ATTEMPTS`
rounds run back to back with nothing between them, so under load all four can land
inside another process's open-to-write window. The claimant ends up refused with no
holder to name, which is the branch whose message tells an operator to confirm nothing
is running and then remove the highest generation — about a holder that is alive and
merely finishing its write.

Reproduced deterministically by seeding an empty `execution.lock.1`: acquisition returns
`{ sameHost: false }` with no holder. In 480 processes without contention it never
happened, so this is rare rather than routine, and the practical cost is a confusing
message: by the time a person reads it and looks, the claim is legible again.

The fix is to space the retries rather than burn them — which is a change to the
acquisition loop and needs somewhere to wait, so it is left for a round that is allowed
to touch the algorithm.

## UI-C — three views the tool had described and never drawn

DAG view, workspace mode and the empty/error/degraded sweep. Together they moved the
dashboard from "one project, working" to "several projects, one of which is on fire".

### The task table had been saying `QUEUED` about two different things

Building the graph needed `ready` and `blocked`, and §22 is explicit that neither is
stored: readiness is a claim about *other* tasks' states and goes stale the moment one
of them fails, so `core/dag` computes both on every pass and the StateStore persists
`queued`.

Which meant the read model had been flattening two facts into one word. A task whose
dependencies had all finished read `QUEUED` — indistinguishable from one waiting behind
four unfinished tasks. So did a task downstream of a failure, which is not waiting for
anything: it is never going to start.

The fix was not to teach the graph about readiness. It was to notice there was no place
that derived it, add one — `effectiveTaskStates` in the application layer, running on
the same `core/dag` functions the scheduler runs on — and have the task list and the
graph both go through it. One derivation, two views, and a test that the two describe
every task the same way.

This is the third time in this project that building a *reader* found something the
writer had been quietly losing.

### Structure and state are two answers on two clocks

The obvious `/dag` endpoint returns nodes with their titles, statuses and durations.
It would also have been wrong.

The plan's graph changes when the plan changes — a re-plan, a corrective round — which
is rare. Task state changes every few seconds. Served together, every status tick
invalidates the structure, and a five-hundred-node layout re-runs because one duration
moved. Served apart, the layout is memoised on a query that genuinely does not change,
`task.*` events do not invalidate it, and `stage.*` and `job.*` do — because those are
the two ways a plan gets replaced.

The same split decided the layout: columns come from a rank the server computes once
from `core/dag`, so the browser never traverses to find out what depends on what. It
only reads edges it was given.

### `fitViewOptions.minZoom` is ignored on the first fit

React Flow's initial viewport is computed in `getInitialState`, before the pan-zoom
instance exists, and that path reads the component's `minZoom` — only `padding` comes
from `fitViewOptions`. The imperative `fitView()` honours all of them.

This mattered because the two floors are different numbers. The opening view wants a
*legibility* floor: nine tasks seven columns deep fit at about a third scale, where a
task id is four pixels tall and the picture answers "what shape is this plan" and
nothing else. The reader afterwards wants no floor at all — refusing to zoom out takes
away the one thing zooming out is for. Setting the floor as a component prop gave both
to the opening view and to the reader; fitting once from `onInit` gives each what it
needs.

Dropping the `fitView` prop was a second gain: it re-fits on every node array change,
so the view jumped under the reader's hands whenever a task ticked over.

### A symlink is a directory `stat` will lie about

Workspace discovery walks directories under a root the operator named. A symlink inside
one of them can point anywhere on the machine, and `stat` follows it and reports a
perfectly ordinary directory — so a link in `~/wk` pointing at `~/private` would have
published that repository on a local HTTP port with nothing to see it happening.

`realPath` had to go on the FileSystem port for this, and both sides of the comparison
have to go through it: a resolved child against a raw root rejects an entire workspace
reached through a symlinked home directory, which is common enough that the check would
have been turned off within a week.

Resolving also bought two things that were not the point. The walk terminates on a link
pointing back up its own tree, which was otherwise bounded only by depth. And a project
reached twice — once directly, once through a link — is one project rather than two ids
over one run history, because the resolved path is what gets registered.

Skipped directories are reported, not dropped. A workspace of links into repositories
elsewhere is a normal way to work, and somebody who arranged one would otherwise see
their projects absent and conclude the scan is broken.

### The invalidation was scoped to runs, and run ids are not unique

Every SSE filter matched on `runId` alone, deliberately: a single-project dashboard
fetches without naming a project while every event names one, and keying the
invalidation on the project missed exactly that case — the screen went quiet and looked
like an idle run.

With one project that was correct. With a workspace it is a bug in the other direction:
two repositories will both have an `AF-2026-001`, so a task finishing in one refetched
the other's run. Nothing looked wrong, which is the property that makes it worth writing
down.

The fix keeps both: invalidate by run, and match a cached key when its project is the
event's *or* absent. Over-invalidating costs a refetch. Under-invalidating costs the
truth.

### `--port 80.5` was port 80

`parseInt` reads a prefix and discards the rest. The command ran, on a port nobody
typed, with nothing on screen to say a character had been ignored. `--depth 2.7` was
depth 2 the same way. Found by a test written for the new depth precedence, which had
nothing to do with either.

### `--update-snapshots` does not update a snapshot it thinks matches

Two baselines in this round showed the *old* UI and passed. Playwright rewrites a
screenshot only when the comparison fails, and the comparison had been made against a
stale bundle: `reuseExistingServer` skips the whole `build && preview` command when
something already answers on the port, and a leftover preview from a previous run was
still there.

The failure mode is the dangerous one — a committed image that documents behaviour the
code no longer has, and a green suite defending it. The only reliable regeneration is to
kill the port, delete the baselines, and let them be written from scratch.

### §94's own example text was a promise the UI cannot keep

The specification's runner-offline state reads:

```text
Codex unavailable.
Workflow can continue using Claude fallback.
```

The second sentence is not something a health indicator knows. A fallback is configured
per *role*, it has to satisfy that role's requirements, and it can be disabled outright —
Agents & Models resolves all of that and reports three distinct reasons a role can have
none. So the sidebar names what is unavailable and links to the page that can answer the
rest, and says nothing about what will happen. The times a promise like that is wrong are
exactly the times somebody was relying on it.

### A gate offered on a run that was already through it

Found by opening the dashboard against a real run rather than against a fixture.

`RunActions` decides which controls exist from where the run is, and the fallthrough
was `terminal ? null : <Review & approve>`. `terminal` means `completed` or
`plan_rejected` — but a run that has been approved and has finished every task sits at
status `approved` until the final review moves it. Not terminal, `canStart` false at
100%, so the gate button appeared on a run whose gate was open. Clicking it would have
returned `already_approved`.

The file's own doc comment says a control whose only outcome is a refusal teaches people
to ignore refusals. It had one.

Nothing in the fixture suite could have caught it: every fixture run is either mid-flight
or `completed`, and `approved` at 100% is a state that only exists for the minutes
between the last task and the final review.

---

## UI-D — the phase where the tests stopped agreeing with each other

E2E, visual CI, packaging and documentation. Four of the five findings below were found
by building a test that crossed a boundary the existing tests did not, and the fifth was
found by breaking the package on purpose.

### A green screenshot suite was describing a bundle nobody had built

`reuseExistingServer` was `process.env.CI !== 'true'`, which reads as a convenience: do
not restart a server that is already up. What it actually did was adopt whatever was
listening on 4788 — usually a `vite preview` left running from an earlier session — and
*skip the build*, because the build is the first half of the `webServer` command.

So the failure mode was not a red suite. It was a green one. Source changed, screenshots
passed, and the pass was a statement about an artifact from an hour earlier. Nothing on
screen distinguishes that from a real pass, which is what makes it worse than a flake.

The fix is one word — `false` — and the interesting part is what makes it safe rather
than annoying. The build lives *inside* `command`, so it runs on every invocation and
both `test:visual` and `test:visual:update` are current by construction. `--strictPort`
turns an occupied port into a named refusal rather than a silent move to another one.
Playwright's own error then suggests setting `reuseExistingServer: true`, which is
exactly the wrong advice, so the troubleshooting doc says so explicitly.

Cost: two seconds per invocation. The alternative was a suite whose green meant nothing.

### "Generate the baselines on Linux" is not specific enough

Screenshot baselines are platform-specific because font rasterisation is — and
rasterisation depends on the fonts and the freetype build available to the browser, not
on the operating system's name. A GitHub runner and an `ubuntu:24.04` container are both
Linux and do not agree.

Which makes the reproducibility problem circular: CI cannot compare against baselines a
maintainer cannot generate, and a maintainer on a Mac cannot generate Linux ones. The
answer is to make the environment the pinned thing rather than the platform. Both sides
now run `mcr.microsoft.com/playwright:v1.62.1-noble`: `scripts/visual-linux.sh` generates
in it, the CI job compares in it, and the image is verified to reproduce byte-identical
images across two runs.

That leaves three facts that must agree — the locked Playwright version, the image the
generator names, the image the workflow names — in three files written at three
different times. Drift between any two shows up as a diff on every glyph of every image,
which reads as "somebody changed the design" and costs an afternoon before anybody
suspects the runner. So `test/visual-ci.test.ts` asserts the agreement, and also that
both platforms carry the same *set* of images: a shot added on one platform and not the
other is a comparison that silently stops happening, because Playwright writes the
missing baseline and passes.

### Two projects, one run id, and a link that dropped the difference

Found by writing the workspace E2E, and it is the kind of bug that only exists at two.

Run ids are `AF-YYYY-NNN`, per project, restarting at 001 each year. So any two
repositories initialised in the same year both hold `AF-2026-001`. The Runs list linked
to `/runs/:runId` with no project, and a run route with no project resolves against the
*primary* project — the directory the server was started in.

The row said `payments-api`. The page that opened was `booking-api`'s run of the same
name, with its feature description, its tasks, and its approval gate. Nothing looked
broken.

The Projects page had already solved this and kept the solution private, as a local
`runHref`. Two pages, one of them right, and no way to tell which without reading both.
`runHref` now lives beside the URL contract it belongs to, and there is one answer to
"how is a run addressed".

The unit suite could not have found this: it has one project. The visual suite could not
either — its fixture workspace has four projects and four distinct run ids, because
someone writing a fixture naturally makes things distinguishable. Only a test that
creates two real repositories gets the collision for free.

### Approving a plan a person had rejected simply worked

`start` refuses a rejected run outright — that was AF-L01.2, and it is what makes
"rejected, therefore not executed" true rather than lucky. `approve` had no equivalent
guard, and `checkApproval` never looked at the run's status. So `POST /approve` on a
rejected run returned 200 and set `approved: true`.

Nothing executed. The harm is subtler and slower: the run was left recording that its
plan had been both turned down and approved, and a state file that contradicts itself is
one nobody can reason from later — including us, six months on, trying to work out what
happened.

The fix took a minute; deciding *where* took longer. `plan_rejected` carries two
meanings the contract does not separate: the automated plan review returning FAIL sets
it, and a person saying no sets it. Refusing on the status alone would have broken
`approve --force` after a failed review, which is a documented path. But that path is
*already* refused by `review_failed`, which is the better message because it carries the
findings — so putting the new check last, after the whole review chain, separates the two
without a contract change. Reaching it means the review passed and the rejection was
somebody's decision.

Forcible, and recorded as `forced_approval`. A rejection followed by a change of mind is
an ordinary Tuesday; doing it by accident from a browser is not.

The honest limit: `RUN_STATUSES` still has no distinct "rejected by a human", and adding
one is a contract change of the same shape `cancel` needs. Deferred, not forgotten.

### The package worked because the source tree happened to be next door

`resolveWebDir` walks a candidate list, and one candidate is `../../apps/web/dist` from
`dist/bin/`. Inside the installed package that resolves to `<pkg>/apps/web/dist`, which
is correct. Inside the repository it resolves to the checkout's own build output, which
is *also* correct — and indistinguishable. Every test that ran `agent-flow ui` from the
repository would pass whether or not the bundle was ever packaged.

So the packaging smoke renames `apps/web/dist` away for its duration. A dashboard that
still loads can only be the packaged one. Verified by removing `apps/web/dist` from
`files` and watching the smoke refuse — which it did, on the tarball contents, before it
ever got as far as a browser.

Two smaller things fell out of the same pass. `files` declared a `templates/` directory
that has never existed and nothing reads; npm skips a missing entry in silence, so the
only cost was the next person going looking for whatever deleted it. And a runtime
import of a devDependency is invisible to the type checker — in here they are all just
installed — so `test/packaging.test.ts` scans `src/` and `bin/` for bare specifiers that
are not in `dependencies`.

### gsd-browser, and being clear about what a second browser buys

The packaged product needed a check by something that does not know the codebase, and
the temptation was to reimplement a slice of the Playwright suite in it.

That would have been the wrong trade in both directions. Playwright's value is that it
*does* know this application: it selects by the roles the components render, waits on
the queries they issue, and asserts against the contracts the server declares. Hundreds
of precise assertions belong there. What it cannot do is forget all of that, which is
the only way to answer "can a browser use this as installed".

So gsd-browser runs two journeys — navigate the packaged dashboard, then approve and
start a run — with explicit `--checks` JSON, a per-run named session, and no baselines.
Visual comparison stays with Playwright: a second baseline mechanism is two things to
keep in step for no gain.

It runs locally, as a mandatory step before publishing, rather than in CI. It is a
native binary distributed per platform with no published checksum, and CI already has a
deterministic browser gate that needs no such dependency; pinning it in a workflow would
add a supply-chain surface to buy a second opinion CI does not need. The version is
pinned at 0.2.2 and the smoke refuses anything else, printing the install command rather
than reaching for `latest` — a black-box check that changes underneath you is worse than
none.
