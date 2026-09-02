# Production invariants

> **What an invariant is here.** A statement that must be true of every run, on every
> platform, at every moment — including mid-crash. Not a goal, not a guideline. Each one
> names the mechanism that enforces it and the test that would catch its violation.
>
> **The rule for this file.** An invariant with no mechanically verifiable test is
> recorded as `TEST: none` and is a debt, not a claim. It may not be cited as evidence in
> the final report.
>
> Companion to [`BASELINE_AUDIT.md`](BASELINE_AUDIT.md). Statuses here are re-measured at
> the end of the program in [`FINAL_REPORT.md`](FINAL_REPORT.md).

---

## The principle these serve

> **Intelligence proposes. Deterministic infrastructure decides.**

An LLM never answers: *did tests pass · is this the validated tree · is this dependency
complete · may this task run · may this tree integrate · did a budget expire · is this run
done*. Those belong to the kernel. Every invariant below is a consequence.

---

## PRI-01 — Completion means what the isolation mode says it means

No task reaches `completed` without satisfying the completion semantics of its isolation
mode.

- **worktree mode:** `completed` ⇔ the task's marker commit is merged into the integration
  branch. Not "the agent exited". Not "validation passed".
- **inline mode:** `completed` ⇔ validation passed against the working tree.

Degrading worktree completion to either weaker condition is a violation even if every
other step succeeded.

- **MECHANISM:** `core/task-state.ts`, `app/integrator.ts`
- **TEST:** `test/app/parallel-wave.integration.test.ts`, `test/app/wave-integration.integration.test.ts`
- **STATUS:** enforced

---

## PRI-02 — An integrated tree is the tree that was validated

No tree is integrated unless it matches evidence produced *after* validation completed.

The chain is: agent exits → orchestrator runs validation → `git write-tree` → post-agent
nonce → attempt receipt → marker commit → integration. Integration reads the receipt and
refuses any mismatch. Git trailers and commit messages are corroborating evidence, never
authority — an agent can write those.

- **MECHANISM:** `app/attempt-receipt.ts`, `app/integrator.ts`
- **TEST:** `test/app/integrator.integration.test.ts` — 20 refusal cases against real Git
- **STATUS:** enforced

---

## PRI-03 — No agent changes a gate, a validation result, or the Definition of Done

Gates, validation outcomes and DoD are computed by the kernel from evidence on disk.
Nothing an agent emits — prose, JSON, a Git trailer, a file it wrote — is an input to them.

**This invariant is about authority, not about agents.** Any actor that is not the
operator is covered, including a web page in the operator's browser (see PRI-05).

- **MECHANISM:** `app/verification-commands.ts`, `core/definition-of-done.ts`, `core/acceptance.ts`
- **TEST:** `test/core/definition-of-done.test.ts`, `test/app/run-actions.gate.test.ts`
- **STATUS:** enforced for agents; **violated for browser origins** until P0-1 closes

---

## PRI-04 — No agent approves its own work

Where independent review is enabled, the reviewing runner is a different *provider* from
the implementing runner — not merely a different configuration key pointing at the same
CLI. A single-runner configuration degrades to same-provider review and **records the
degradation on the artifact** rather than passing silently.

- **MECHANISM:** `core/independence.ts`, `registry.providerOf`
- **TEST:** `test/core/independence.test.ts`
- **STATUS:** enforced

---

## PRI-05 — An HTTP request carries ids, never authority

No request may supply, directly or by influence: a filesystem path, a Git ref or branch, a
command, an executable, or a plan hash treated as authoritative. Ids are resolved
server-side against the registry the operator chose.

**And the request itself must be authorised.** A request whose *origin* is not the
dashboard is refused before any handler runs, regardless of how well-formed its body is.
Deny by default: an unknown or absent origin on a write is a refusal, not a pass.

- **MECHANISM:** `server/project-registry.ts`, `contracts/api.schema.ts`, request guard
- **TEST:** `test/server/*` — the origin/host cases are the new ones
- **STATUS:** ids enforced; **origin unenforced** until P0-1 closes

---

## PRI-06 — Internal Git never runs user-controlled hooks, and never inherits Git state

Every internal Git invocation sets `core.hooksPath` to an empty location and removes the
Git environment variables that can redirect which repository is acted on or what a commit
says:

```
GIT_DIR  GIT_WORK_TREE  GIT_COMMON_DIR  GIT_INDEX_FILE  GIT_OBJECT_DIRECTORY
GIT_ALTERNATE_OBJECT_DIRECTORIES  GIT_NAMESPACE  GIT_CEILING_DIRECTORIES
GIT_EXEC_PATH  GIT_CONFIG_COUNT  GIT_CONFIG_PARAMETERS  + author/committer identity
```

Identity is scrubbed for a second reason: a marker commit must be a deterministic function
of its artifact, so re-running `commit-tree` after a crash yields the same SHA and
`update-ref` is idempotent.

`--no-verify` is explicitly **not** the mechanism: it disables a smaller set than
`core.hooksPath` does.

- **MECHANISM:** `adapters/git/git-command.ts` — `GIT_HOSTILE_ENVIRONMENT`, `GIT_INTERNAL_CONFIG`
- **TEST:** `test/adapters/git-environment.integration.test.ts`, `git-hook-isolation.integration.test.ts`
- **STATUS:** enforced

---

## PRI-07 — The machine's retry loop is bounded; every continuation past the bound costs a human act

`retry.maxAttempts` bounds a streak of attempts made **with nobody watching**. Reaching it
stops the automatic loop and produces a terminal, named state carrying one human action.

An explicit operator retry ends the streak. It is never refused for budget, because a
budget that exists to bound unattended work has nothing to say to an attended request —
the principle `app/autonomy-budget.ts` already states about the run-level counters. The
lifetime `attempts` count is evidence and never moves; the streak is the difference
between it and `attemptsBeforeHumanRetry`.

**This invariant was rewritten after the code was read, and the first draft was wrong.**
It said "a task has a maximum attempt count", which describes the product before AR-03
turned `recovery.enabled` on by default. After that the repair loop spent the whole budget
before anybody was asked — so the run escalated with `retry` as its one named human action,
and `retry` then answered `attempts_exhausted` and offered `--force`. The machine refused
the action it had just asked for, and the E2E suite that encoded the old behaviour has been
red on `master` since commit `ab8a460`.

- **MECHANISM:** `core/recovery-policy.ts` (`unattendedAttempts`), `app/run-actions.ts`
- **TEST:** `test/core/recovery-policy.test.ts` — "bounds the unattended streak, not the
  lifetime count"; `test/app/run-actions.gate.test.ts` — "does not refuse the very action
  the machine stopped to ask for", "gives the recovery loop one fresh budget per
  intervention, and no more"; `apps/web/e2e/execute.spec.ts`
- **STATUS:** enforced

---

## PRI-08 — Recovery is bounded

Corrective rounds have a run-level ceiling, and spent rounds stay spent across restarts.
Autonomous model calls have a run-level ceiling that stops an unattended run and asks.

- **MECHANISM:** `app/autonomy-budget.ts`, `core/recovery-policy.ts`
- **TEST:** `test/app/autonomy-budget.test.ts`, `test/e2e/autonomy-acceptance.test.ts`
- **STATUS:** enforced

---

## PRI-09 — No timeout and no cancellation leaves an orphan process on Tier 1

On macOS and Linux, every spawned child is placed in its own process group and the whole
group is signalled — `SIGTERM`, then `SIGKILL` after a bounded grace period.

This must hold for **both** paths: the child's own timeout, and an operator cancellation.

The two paths share one kill. A cancellation that signalled only the direct child would be
the defect the timeout path already documents: agent CLIs spawn children, those children
hold the stdout pipes, and Node reports `close` only once every stream is closed.

An already-aborted signal spawns nothing — on a cancelled run, a process started and
immediately killed is still an agent invocation somebody is billed for.

- **MECHANISM:** `adapters/process/node-process-runner.ts` — `detached`,
  `process.kill(-pid)`, `ProcessSpawnOptions.signal`
- **TEST:** `test/adapters/node-process-runner.test.ts` — "reaches the whole process group,
  leaving no grandchild behind", on both the timeout and the cancel path, against real
  process trees
- **STATUS:** enforced, on both paths. `agent-flow cancel` reaches it through
  `terminateSignal`.

---

## PRI-10 — The operator's checkout is never written to

A run leaves the working tree the operator is sitting in byte-for-byte identical. In
worktree mode all work happens in locked worktrees under Agent Flow's own Git home;
integration targets an integration branch, never the checked-out branch.

- **MECHANISM:** `adapters/git/agent-flow-git-home.ts`, `app/task-workspaces.ts`
- **TEST:** `test/app/integrator.integration.test.ts` — "leaves the user's working tree byte-for-byte unchanged"
- **STATUS:** enforced

---

## PRI-11 — No known secret reaches an artifact, report, event, log or export

Redaction happens on the **write** path and is irreversible. There is no unredacted mirror.
Covered: `Authorization` headers and bearer tokens, documented vendor key prefixes,
`key = value` assignments to credential-shaped names, URL userinfo, PEM private-key blocks,
the values of environment variables the configuration names as secret-bearing, and absolute
worktree and home paths.

Redaction keys on *structural markers*, never on entropy — an entropy heuristic would
redact tree hashes and nonces, destroying the evidence PRI-02 depends on.

- **MECHANISM:** `core/evidence-redaction.ts`
- **TEST:** `test/core/evidence-redaction.test.ts`
- **STATUS:** enforced on the paths that use it; **coverage of every persistence path is unverified**

---

## PRI-12 — Fallback is infrastructure recovery, never semantic replacement

A runner that is missing, unauthenticated, rate-limited or out of quota may be routed
around. A runner that **produced bad output** may not: retrying that elsewhere replaces a
visible failure with a quiet one.

The rule is enforced by the type system — the failure classes eligible for fallback are a
closed union, and `execution_failed` is not in it.

- **MECHANISM:** `adapters/runners/fallback-runner.ts`, `core/failure-classification.ts`
- **TEST:** `test/adapters/fallback-runner.test.ts`, `test/core/failure-classification.test.ts`
- **STATUS:** enforced

---

## PRI-13 — A crash resumes safely or refuses safely — never a silent partial mutation

Killing the coordinator at any point must leave the run in a state where the next `run` or
`resume` either continues correctly from evidence on disk, or stops with an actionable
diagnosis. Never: a task integrated twice, a completed task re-run, a successful attempt
lost, or state accepted that does not parse.

- **MECHANISM:** `app/worktree-recovery.ts`, `app/state-store.ts`, marker idempotency (PRI-06)
- **TEST:** `test/app/crash-recovery.integration.test.ts`; **the full fault-point matrix is unexercised**
- **STATUS:** partial

---

## PRI-14 — Cancel is a defined terminal state

`cancel` means, in order: no new task is dispatched · running process groups are
terminated · diagnostic evidence is retained · the integration branch and failed worktrees
are **not** deleted · the operator's checkout is untouched · the run reaches an unambiguous
terminal state · calling it again is a no-op.

Cancel takes no execution lease, and that is what makes it cancel: it has to work while
something else holds one. The intent goes on disk as the terminal `cancelled` status, and
the executing process — in this terminal or another — observes it and aborts its attempts,
which reaches the agents' process groups through the same kill the timeout already uses.

Nothing is deleted. Not the integration branch, not the failed worktrees, not an attempt
artifact: a cancelled run is the one somebody is most likely to want to read.

- **MECHANISM:** `app/run-actions.ts:cancel`, `app/run-lifecycle.ts:watchLifecycle`,
  `RunOptions.terminateSignal` → `AgentRunInput.signal` → `ProcessSpawnOptions.signal`
- **TEST:** `test/app/run-lifecycle.test.ts`, `apps/web/e2e/lifecycle.spec.ts` — the E2E
  drives the built binary against a real repository, because the property that matters is
  that the intent survives *between* two invocations of it
- **STATUS:** enforced

---

## PRI-15 — Pause stops at a safe boundary and is resumable

`pause` means: the intent is persisted · no new task attempt starts · in-flight work runs
to its safe boundary rather than being severed · nothing is marked with a state it did not
reach · the intent survives a restart · `resume` is idempotent.

`pauseRequestedAt` is a **request, not a status**. A run's `status` says where it is in the
workflow; "paused" says what a person asked for, and folding the two together would make
`waiting_for_approval` and `paused` mutually exclusive when they plainly are not.

Two signals, and the separation is the entire difference from cancel: pause aborts only the
dispatch signal, so the task in flight runs to its natural end. Its result file is written
once, at the end — there is no partial result to keep, and severing it would throw away
work already paid for. So the honest report is "pausing…", then "paused".

`start` reads the request too, so `agent-flow run` typed after a pause is refused rather
than quietly overriding it. Both entry points, or neither.

- **MECHANISM:** `app/run-actions.ts:pause` / `resume`, `app/run-lifecycle.ts`,
  `Scheduler` dispatch boundary, `refuseUnrunnable`
- **TEST:** `test/app/run-lifecycle.test.ts`, `apps/web/e2e/lifecycle.spec.ts`
- **STATUS:** enforced

---

## PRI-16 — Success is demonstrable without trusting agent prose

Every claim in the final report traces to a receipt, a Git object, an event, an exit code
or a test — never to a sentence a model wrote.

- **MECHANISM:** receipt-first evidence (PRI-02), orchestrator-run validation (PRI-03)
- **TEST:** the exit criteria themselves
- **STATUS:** enforced by design; verified at PR-19

---

## Invariants added by this program

### PRI-17 — A child process inherits only the environment it needs

The environment handed to a spawned runner is **constructed**, not inherited wholesale. It
carries what the platform, the network path and the vendor's own authentication require,
and nothing else. Measured on the machine this was built on: 77 variables in, 17 out.

Two callers inherit instead, and each states why at its call site — the Git boundary, which
subtracts the eleven repository-redirecting variables and would otherwise lose commit
signing and SSH access; and `project.commands.*`, which are the operator's own commands.
Additions are declared in `execution.passEnv`, never acquired by accident.

Two things are dropped that a vendor prefix would otherwise have passed: a **parent agent
session's** id, socket and token — §3.6 promises fresh contexts, and a channel back to the
orchestrating session is not one — and an **inherited effort**, because reasoning level is
a kernel decision (PRI-03).

- **MECHANISM:** `core/process-environment.ts`, `adapters/process/node-process-runner.ts`
- **TEST:** `test/core/process-environment.test.ts`,
  `test/adapters/node-process-runner.test.ts` — "does not hand a coding agent a credential
  it was never given"; `test/adapters/registry.test.ts` — the wiring;
  **and `scripts/env-allowlist-probe.ts`, which runs the real CLIs under it.** A list of
  names cannot prove a CLI still logs in, and the probe re-runs any failure with the full
  environment before blaming the list. Claude Code 2.1.251, Codex 0.149.0 and AGY 1.1.22
  authenticated on 2026-08-30.
- **STATUS:** enforced

### PRI-18 — Every shipped adapter satisfies one contract

There is a single contract suite. Every first-party adapter passes it, and an external
adapter is only supported to the extent it passes it. Adding an adapter without running it
is not a supported operation.

- **MECHANISM:** to be built (PR-04)
- **TEST:** pending
- **STATUS:** **not implemented**

### PRI-19 — An external adapter is configured, never discovered

Agent Flow never executes an executable it found. An external runner exists only because
the operator wrote its command into configuration. There is no plugin auto-loading, and
repository content can never introduce a runner.

- **MECHANISM:** to be built (PR-04)
- **TEST:** pending
- **STATUS:** **not implemented**

### PRI-20 — Repository content is data, never instruction

Text read from the repository under test — source, README, comments, fixtures — may shape
what a model *proposes*. It may never change policy, validation commands, gates, refs,
receipts, approval, or the boundaries of a role.

- **MECHANISM:** kernel-owned validation (PRI-03) and config authority
- **TEST:** pending (PR-12)
- **STATUS:** believed enforced by construction; **unverified**
