# Live dogfood — agent-flow planning a feature for agent-flow

> Every claim here was executed. Where a run is quoted, its `events.jsonl` is the source.
> Where a Git or filesystem behaviour is asserted, the command that measured it is shown.
>
> **Sandbox:** `agent-flow` itself — 1107 tracked files, Windows 11, `master` at `225b0be`.
> **Runners:** `agy 1.1.28` on discovery, architecture-impact, SDD, planning and
> implementation; `claude 2.1.267` on plan-review and final-review.
> **Feature:** device pairing for the Deck, so a second device on the same network can
> open the screen and operate a run. Chosen because the product's own security model
> forbids it today: `agent-flow ui` binds loopback with **no authentication**, and
> `--host 0.0.0.0` exists with a warning that anything reaching the port reads every run,
> every artifact and every project path on the machine.
> **Goal:** drive the whole pipeline the way a person would, from the dashboard, and write
> down everything the record could not answer.
>
> **Outcome:** the feature was not built. Planning produced a 12-task plan, cross-provider
> review refused it with 11 findings, and the revision that would have answered them was
> killed by a defect introduced in this same session. That is the honest result, and the
> findings below are worth more than the feature would have been.

## Status

| # | Finding | Severity | State |
|---|---|---|---|
| 1 | `agent-flow ui` answers a busy port with a Node stack trace | low | open |
| 2 | `cross_provider_required` is refused *after* the run is created | medium | open |
| 3 | The ceremony budget's task bound is declared and never enforced | **high** | open |
| 4 | `doctor` leaks one worktree per invocation | medium | open |
| 5 | Nothing reclaims an orphaned directory under the owned root | medium | open |
| 6 | `?lang` broke every route with a strict query schema | **high** | closed in session |
| 7 | A read-only stage's cleanup could kill the stage | **high** | closed in session |

Findings 6 and 7 were introduced by the two changes that shipped immediately before this
run. They are listed with the rest because a dogfood that only reports other people's
defects is a dogfood that flatters the person running it.

---

## What worked, and it is the headline

**Cross-provider plan review earned its keep.** §3.2 exists on the argument that one model
confirming its own hypothesis is not a review. Measured: `agy` planned, `claude` reviewed,
and the verdict was FAIL with 11 findings — every one of them anchored in a file and a line
of this repository rather than phrased as general advice. Two were blocking:

- **critical** — no task defines how the CLI and the running UI server share pairing and
  session state, *and the SDD's own two choices make it impossible*. It had said pairing
  codes are "held strictly in server memory during the active process lifetime and are
  never written to disk", and then planned a CLI `pair` command. The CLI is a different
  process.
- **high** — the SDD cited `serializeStateWrite` as the crash-consistency mechanism for
  `device-sessions.json`. That module's own first line says: *"One writer at a time per
  state file, within this process"* (`src/app/state-write-queue.ts:1`).

Four more were checked by hand against the repository and were correct:

- `typecheck` and `test` at the root do not cover `apps/deck` — it has its own `tsconfig`
  and its own vitest config — so two tasks declared validation that would not run against
  the code they changed.
- `@fastify/cookie` is not a dependency, and the design required an HttpOnly cookie.
- A task edited `src/server/request-guard.ts` against the documented decision at lines
  104–109 without naming any attack that required it.
- `src/contracts` must not depend on `src/core`, and three tasks declared a dependency on
  a core module none of them imports.

A reviewer that finds a contradiction *inside the document it is reviewing* is doing the
job the milestone was written for. This is the strongest evidence for §3.2 the project has.

~~**The planning repair loop fired.**~~ **It did not, and this report said it had.**

`stage_completed` for planning carries `repairs: 1`, which was read here as "one repair".
It is not: `stage-runner.ts` increments the counter at the *top* of the loop, so `1` means
one attempt and no re-prompt at all. The 04/09 change may well work; this run is no
evidence either way, and neither was the second one.

The field is worth a finding of its own (D6). Its own doc-comment says it counts "how many
times the stage had to re-prompt for a well-formed answer", and it insists at length on the
distinction between a *repair* and an *attempt* — while reporting 1 for zero repairs. The
reader it misled was the author of this report, which is about as direct a demonstration as
a naming defect gets.

**Workflow classification read the description correctly.** `workflow_classified` recorded
`highRiskSignals: ["authentication", "session", "credential", "secret"]` — detected from
the prose, independently of the explicit override.

**§6.1b's containment held.** Every read-only stage ran in a disposable twin. The
repository under judgement was untouched by five stages of an agent that §6.1 had measured
writing into it.

---

## 1 — `agent-flow ui` answers a busy port with a Node stack trace

An earlier `agent-flow ui` still held 4782. The new one died with:

```
Error: listen EADDRINUSE: address already in use 127.0.0.1:4782
    at Server.setupListenHandle [as _listen2] (node:net:1941:16)
    at listenInCluster (node:net:1998:12)
    at node:net:2207:7
    at process.processTicksAndRejections (node:internal/process/task_queues:89:21)
```

The product knows exactly what happened and does not say it: that 4782 is taken, that the
holder is almost certainly another `agent-flow ui`, and that `--port` exists. This is
`plan.md`'s whole thesis in three lines of stack trace.

**It cost something.** The failure was silent to the caller, the old server kept answering
on 4782 serving a workspace under `%TEMP%`, and the feature was very nearly planned
against the wrong repository.

## 2 — `cross_provider_required` is refused after the run is created

`AF-2026-001` exists. It has no plan, no stages, and a lifetime of 2.2 seconds:

```json
{"status":"failed","error":{"error":"planning_refused",
 "message":"HIGH-RISK workflows require independent cross-provider review. Both planner
            and planReviewer resolve to provider \"agy-cli\".",
 "action":"Configure independent providers for roles.planner and roles.planReviewer in
           config.yaml."}}
```

**The refusal itself is good**: fast, it names both roles and the provider, and it says
what to change. The defect is *when* it fires. Both facts it rests on — the configured
roles and the requested workflow class — are known at the moment of the `POST`, before
anything is created. Nothing needed disk, a runner or a model to answer it.

This is the same shape as C-19, which `start` already fixed: *"Refused before the lock,
not inside it… a run with nothing to do still cost a full acquire/refuse/release cycle and
wrote two events describing work that never happened."* The planning path did not get the
same treatment, and the residue is a corpse in the run history.

## 3 — The ceremony budget's task bound is declared and never enforced

The highest-value finding, because the run states the bound itself and then ignores it.

`AF-2026-002`'s own event log:

```json
{"type":"workflow_classified","detail":{"workflow":"high-risk",
 "budget":{"workflow":"high-risk","maxPlanningCalls":5,"maxRevisionCycles":3,"maxTasks":8}}}
```

The plan it then accepted has **12 tasks**, and the approval gate reports
`taskCount: 12`. Nothing refused it, nothing warned, nothing recorded a degradation.

The cause is one line. `src/app/planning-pipeline.ts` enforces the bound for two of the
four classes and passes an empty check for the other two:

| class | `maxTasks` | enforced |
|---|---|---|
| `trivial` | 1 | yes — `planning-pipeline.ts:226` |
| `simple` | 3 | yes — `planning-pipeline.ts:248` |
| `standard` | 8 | **no** — `ceremonyProblems: () => []` |
| `high-risk` | 8 | **no** — `planning-pipeline.ts:346` |

A budget that is recorded in the audit trail and not applied is worse than no budget: it
tells a reader that a bound held when it did not. And the cost is not theoretical — the
review's own third finding was that one task carried six independent responsibilities,
which is what a plan does when nothing pushes back on its size.

## 4 — `doctor` leaks one worktree per invocation

Six directories in the owned root after six `agent-flow doctor` calls on this repository:

```
~/.agent-flow/worktrees/doctor-install-probe-pid-16440    node_modules
~/.agent-flow/worktrees/doctor-install-probe-pid-202060   node_modules
~/.agent-flow/worktrees/doctor-install-probe-pid-27152    node_modules
~/.agent-flow/worktrees/doctor-install-probe-pid-33100    node_modules
~/.agent-flow/worktrees/doctor-install-probe-pid-45792    node_modules
~/.agent-flow/worktrees/doctor-install-probe-pid-67048    node_modules
```

None registered with Git (`git worktree list --porcelain` names none of them), each holding
nothing but `node_modules`. The §8.4 install probe is on by default in a terminal, so a
person running `doctor` five times has paid for five `npm ci` and kept five copies.

**The cause is not what it looks like.** The first explanation written into the code was
that `git worktree remove --force` spares ignored files. That was measured and it is false:

```bash
git worktree add --detach --lock --reason probe -- "$D" HEAD
mkdir -p "$D/dist" "$D/node_modules/x"; echo built > "$D/dist/bundle.js"
git worktree unlock "$D"; git worktree remove --force -- "$D"   # exit 0
test -d "$D" && ls -A "$D" || echo no                            # no
```

`--force` deletes ignored files. So these six are removals that **failed** — and
`probeInstallCleanliness` discards `removeWorktree`'s `GitResult`, so nobody was told.
A cleanup nobody checks is a cleanup that leaks silently, and the only evidence is a
folder somebody notices months later.

## 5 — Nothing reclaims an orphaned directory under the owned root

Follows from 4, and it is why 4 accumulates rather than self-healing.

```
$ agent-flow clean --worktrees --dry-run
Nothing to remove — 2 run(s), keeping 5.
```

`clean --worktrees` is scoped to *the retained worktrees of removed runs*, derived from run
state. These belong to no run — the probe's are named by pid, not by run id — and Git has
already unregistered them, so `git worktree prune` does not see them either. No command in
the product reclaims them. A person deletes them by hand, which is what happened here.

This was also written into the code as "`agent-flow clean` reclaims it" before being
measured. It does not.

## 6 — `?lang` broke every route with a strict query schema *(mine, closed)*

Found by the operator, on screen: the Crew page said **"Não foi possível ler a
configuração"** over a configuration that loads fine.

The i18n change shipped an hour earlier made the Deck append `lang` to every request URL,
because the language is part of a read's address — a cache key that ignored it would serve
a Portuguese reader the English answer it fetched a moment ago. `ConfigEditorQuerySchema`
is `.strict()`, and a strict object refuses an unexpected key by design.

```
GET /api/v1/config/editor?scope=global            → 200
GET /api/v1/config/editor?scope=global&lang=en    → 400 invalid configuration target
```

**Closed by declaring `lang`, not by loosening the schema.** The strictness is §93 in the
shape: a request has no field for a path, and an invented `path=` gets a refusal rather
than being quietly ignored. Removing `.strict()` would have fixed the screen and opened
the door.

**Why the test suite missed it.** The locale test written with the feature asked four
endpoints, chosen by the author, and the one that broke was not among them. The replacement
walks all 27 reads the Deck actually issues — a list derived by reading `api.ts`, not by
remembering — in every locale the contract names, with two positive controls: `path=` is
still refused, and `lang=klingon` is refused rather than guessed.

## 7 — A read-only stage's cleanup could kill the stage *(mine, closed)*

The revision that would have answered the review's 11 findings ran for 14 minutes,
succeeded, and was reported as:

```json
{"status":"failed","error":{"error":"no_run",
 "message":"EBUSY: resource busy or locked, rmdir
            'C:\\Users\\lguil\\.agent-flow\\worktrees\\read-only-planning-pid-41036-7'"}}
```

§6.1b's disposable twin is released in a `finally`. The release threw, the throw left the
`finally`, and fourteen minutes of model work was lost — to a *cleanup*. The module's own
opening paragraph says "a defence that becomes an outage is a worse trade", and it had made
exactly that trade.

**Closed by making `release()` part of the contract that it never throws.** It reports a
`ReleaseOutcome` instead; the stage runner records a `read_only_workspace_retained` event
when a directory survived, and that write is itself wrapped, because a store failure in a
`finally` would reintroduce the same defect for the sake of a note about a folder.
`NodeFileSystem.remove` also gained the Windows retry that `writeFileAtomic` has carried
for the same reason since before this.

**What is still unknown, and it matters.** The directory is *empty* and remains locked with
`Device or resource busy` an hour later. Killing the `agent-flow ui` process tree did not
free it. An orphaned `agy.exe` and its unkillable `conhost.exe` child are in the picture,
but that `agy.exe` was created two hours *before* the run, so it is not the planning
stage's agent and **which process holds the handle was not established.** The retry the fix
adds spans 500 ms, which would not beat a long-lived holder — which is precisely why the
load-bearing half of the fix is the never-throwing, not the retry.

---

## Cost

The planning phase, one pass, from the dashboard:

| stage | runner | wall clock |
|---|---|---|
| discovery | `agy` | 9 min 2 s |
| architecture-impact | `agy` | 10 min 3 s |
| sdd | `agy` | 4 min 46 s |
| planning (with 1 repair) | `agy` | 4 min 1 s |
| plan-review | `claude` | 5 min 31 s |
| **total** | | **33 min 51 s** |

The revision ran 14 min 39 s before the cleanup killed it.

§6.1b's containment adds 19.9 s across those five stages — 3.4 s to open a twin and 0.6 s
to release it, measured through the real code path on this repository. Against 34 minutes
of model time that is 1%, which is the number that made per-invocation checkouts preferable
to a cache whose key cannot be made sound.

---

## What this says about the product

Four of the five open findings are the same defect wearing different clothes: **a result
that was computed and then discarded.** The port answered and nobody read it (4). The
budget was recorded and nobody applied it (3). The refusal was correct and arrived after
the cost had been paid (2). The failure was fully understood and printed as a stack trace
(1). `plan.md`'s thesis — *"o produto sabe e não conta"* — was written about the dashboard,
and it turns out to describe the internals just as well.

The two findings that were mine are a different shape, and worth naming separately:
both were **a guard that became the failure it was built to prevent**. A strict schema
protecting §93 refused a legitimate request; a cleanup protecting the repository destroyed
a run. Neither was caught by tests written with the feature, and in both cases the reason
is the same: the test asked the questions the author already had in mind.

## What is still open

Findings 1–5 are unfixed. The feature itself has a plan, a critical design contradiction
the reviewer named, and no revision — the next pass should settle whether pairing state is
server-process-only or genuinely persisted, and bring the plan inside the 8-task bound that
finding 3 shows nothing will enforce for it.
