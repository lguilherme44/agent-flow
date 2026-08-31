# Baseline forensic audit

> **What this is.** The state of the repository at `741941c`, established by running the
> gates and reading the code — not by reading the roadmap. Every claim below names the
> command or the file that produced it. Where documentation and runtime disagree, the
> runtime wins and the disagreement is recorded as a finding.
>
> **Established:** 2026-08-30 · **HEAD:** `741941c` · **Branch:** `hardening/production-readiness`
> **Platform:** darwin 25.6.0 · Node v24.13.0 · npm 11.6.2 · git 2.52.0

---

## 1. Gate baseline — measured, not assumed

| Gate | Command | Result |
|---|---|---|
| Typecheck (core) | `npm run typecheck` | **PASS** — exit 0 |
| Lint | `npm run lint` | **PASS** — exit 0 |
| Unit + integration | `npm run test` | **PASS** — 142 files, 3074 passed, 2 skipped, 1 file skipped, 24.6s |
| Dependency audit (runtime) | `npm audit --omit=dev` | **PASS** — 0 vulnerabilities |
| Dependency audit (all) | `npm audit` | **FAIL** — 6 (2 critical, 1 high, 3 moderate), all dev-only |
| Secret scan | — | **ABSENT** — no scanner configured |
| SAST | — | **ABSENT** — no CodeQL or equivalent |
| Coverage gate | `npm run test:coverage` | **REPORT ONLY** — CI runs it in a non-blocking job, no floor |

Not yet re-measured in this audit (they exist and run in CI): `build`, `build:web`,
`test:web`, `test:e2e`, `test:visual`, `test:packaging`. They are exercised as part of
the exit criteria, not as part of the inventory.

### The dependency finding, precisely

All six advisories sit in the **build and test toolchain**, none in a runtime dependency:

| Package | Severity | Substance | Fix |
|---|---|---|---|
| `vitest` | critical | Vitest UI server can read and execute arbitrary files | `vitest@4` (major) |
| `@vitest/coverage-v8` | critical | inherits `vitest` | `@vitest/coverage-v8@4` (major) |
| `vite` | high | path traversal in optimized-deps `.map`; `server.fs.deny` bypass | `vite@8` (major) |
| `esbuild` | moderate | dev server answers any origin | via `vite@8` |
| `vite-node`, `@vitest/mocker` | moderate | inherit the above | via `vitest@4` |

**Why this is not "dev-only, therefore ignorable".** `apps/web/dist` is a *published
artifact* built by `vite`. A compromised build toolchain reaches the tarball. The
exposure is real but requires the maintainer to run a dev server and visit a hostile
page; it is not reachable from a released install. Classified **P1**, not P0.

---

## 2. Architecture — what actually exists

153 TypeScript modules, 43,436 lines, in a ports-and-adapters layout with the dependency
rule enforced by `test/architecture.test.ts`.

```
src/contracts/   19 modules   Zod schemas — the only shared vocabulary
src/core/        30 modules   pure decision logic, no I/O
src/app/         39 modules   use cases; the layer the CLI and the server both call
src/ports/       10 modules   interfaces for everything that touches the world
src/adapters/    18 modules   git, fs, process, clock, host, runners, utility-model
src/cli/         19 modules   commander entrypoints
src/server/      11 modules   fastify local control plane
apps/web/                     react dashboard, separate workspace
```

**Load-bearing and confirmed present in code, not merely documented:**

| Mechanism | Where | Evidence it is reachable |
|---|---|---|
| Validation authority (orchestrator runs the commands) | `app/verification-commands.ts` | `app/task-executor.ts` calls it after every agent exit |
| Validated tree identity | `app/attempt-receipt.ts` | `test/app/attempt-marker.integration.test.ts` — real Git |
| Receipt-first evidence | `app/integrator.ts` | 20 refusal tests in `test/app/integrator.integration.test.ts` |
| Deterministic topological integration | `app/scheduler.ts` + `app/integrator.ts` | `test/app/wave-integration.integration.test.ts` |
| `completed = integrated` | `core/task-state.ts` | `test/app/parallel-wave.integration.test.ts` |
| Git hook isolation | `adapters/git/git-command.ts` `core.hooksPath` | `test/adapters/git-hook-isolation.integration.test.ts` |
| Git environment scrubbing | `GIT_HOSTILE_ENVIRONMENT`, 11 variables | `test/adapters/git-environment.integration.test.ts` |
| Crash recovery from disk evidence | `app/worktree-recovery.ts` | `test/app/crash-recovery.integration.test.ts` |
| Secret redaction on the write path | `core/evidence-redaction.ts` | `test/core/evidence-redaction.test.ts` |
| Run execution lock (inter-process) | `app/run-execution-lock.ts` | race + stress tests present |
| Autonomy budgets | `app/autonomy-budget.ts` | `test/app/autonomy-budget.test.ts` |

These are the invariants the program says to preserve. **They are real.** The findings
below are about what surrounds them.

---

## 3. Findings

### P0 — production blockers

---

#### **P0-1 · The local dashboard accepts writes from any web page the operator visits**

**Status: proven by execution, not by reading.**

`src/server/server.ts` performs no `Origin` check, no `Host` check, no CSRF token, and
declares no CORS policy. Five write endpoints exist. Four of them accept a **bodyless**
`POST`, because their request schemas make every field optional:

```
ApproveRequestSchema  { force: default(false) }        → {} is valid
RejectRequestSchema   { reason: optional() }           → {} is valid
StartRequestSchema    { taskId: optional() }           → {} is valid
RetryRequestSchema    { force: default(false) }        → {} is valid
ReviseRequestSchema   { instruction: required }        → {} is rejected
```

A bodyless cross-origin `POST` is a **CORS simple request**: no preflight, the browser
sends it, the side effect happens, and only the *response* is hidden from the attacker.

Measured against the real server (`app.inject`, foreign `Origin: https://evil.example`):

```
POST /api/v1/runs/:id/start   (no body)   → 202  {"id":"job-0001","status":"running"}
POST /api/v1/runs/:id/reject  (JSON)      → 200  {"runId":"AF-2026-001","warnings":[]}
GET  /api/v1/projects  (Host: evil…)      → 200  [{"path":"/repo", …}]
OPTIONS  (preflight)                      → 404  (no CORS headers)
```

`202 … "status":"running"` is the whole finding. `start` spawns coding agents with
**write** permission inside the operator's repository and then executes the validation
commands from that project's config. Any page open in the operator's browser while
`agent-flow ui` is running can trigger it.

**Two distinct vectors, both open:**

1. **Classic CSRF** — bodyless `POST` from a hostile origin. Not blocked by CORS, because
   a simple request is *sent* regardless. Reaches `start`, `approve`, `reject`, `retry`.
2. **DNS rebinding** — no `Host` validation. A hostile domain whose DNS rebinds to
   `127.0.0.1` becomes *same-origin* to the browser, which removes CORS from the picture
   entirely and opens every read endpoint as well: project paths, artifacts, plans, SDDs,
   config, run history.

**Invariants violated:** PRI-03 (an agent — here, a web page — must not open a gate),
PRI-04 (self-approval), and the whole premise of the human approval gate. `approve` is
described in the source as "no hash crosses this boundary … there is no version of this
call that approves a plan the person did not see" — true of the *body*, and defeated by
the *request itself*.

**Fix direction:** deny-by-default Origin/Host validation ahead of every route, a
required non-simple header on writes, and a test proving each vector is refused.

---

#### **P0-2 · `pause`, `resume` and `cancel` do not exist**

`src/cli/index.ts` registers: `doctor setup config init feature status approve reject
revise run task retry review ui clean`. There is no `pause`, no `resume`, no `cancel`,
and no server route for any of them. `docs/pause-resume-cancel-design.md` is a design;
the README's capability table says "Designed, not built" and is accurate.

**Consequence.** The only way to stop an autonomous run is to kill the coordinator.
Killing it leaves the *agent's* process group alive: `NodeProcessRunner` only kills a
tree on **its own timeout**, and nothing signals children when the parent dies. An
operator who wants to stop a run has no bounded, evidence-preserving way to do it.

**Invariants violated:** PRI-14, PRI-15. Blocking for `LOCAL_AUTONOMOUS_READY` — autonomy
you cannot stop is not autonomy, it is a runaway.

---

#### **P0-3 · The process boundary has no cancellation and no environment allowlist**

`src/ports/process-runner.ts` exposes exactly one operation, `run(options)`, and no
`AbortSignal`. A spawned child can only be stopped by *its own* `timeoutSeconds`. There
is no path by which an operator decision terminates a running agent.

`src/adapters/process/node-process-runner.ts:environmentFor` builds the child environment
as `{ ...process.env }` minus `unsetEnv` plus `env`. Every coding agent therefore inherits
**the orchestrator's entire environment**, including any credential unrelated to it. The
comment argues the inheritance is required for vendor auth, which is true for the vendor's
own variables and not for the rest.

**Invariants violated:** PRI-09 (orphan processes on cancel — the timeout path is correct,
the cancel path does not exist), PRI-14. **P0** because it is the mechanism P0-2 needs.

---

### P1 — serious reliability or security issues

| # | Finding | Evidence |
|---|---|---|
| **P1-1** | **No adversarial security suite.** `test/` has 155 files and no directory for hostile input. Nothing exercises: path traversal, symlink escape from a worktree, hostile branch/ref names, prompt injection from repository content, oversized or malformed agent output, duplicate terminal results, HTTP abuse. `contracts/utility-model-security.test.ts` is the only file with "security" in its name and it covers one narrow contract. | `fd . test -t f` |
| **P1-2** | **No chaos harness.** `test/fixtures/crash.ts` is a good `Proxy`-based fault injector and is used by exactly one suite, `crash-recovery.integration.test.ts`. The program's fault-point matrix (14 points) is not enumerated anywhere and most points are unexercised. | `rg -l 'killAfter' test/` |
| **P1-3** | **No soak test.** Nothing runs the kernel repeatedly to detect leaked worktrees, refs, processes, locks or temp files. | absent |
| **P1-4** | **No adapter contract suite.** Four adapters (`claude-code-cli`, `codex-cli`, `agy-cli`, `openai-compatible`), each with its own bespoke test file. There is no single suite every adapter must pass, so a fifth adapter has no definition of correct. | `test/adapters/*-runner.test.ts` |
| **P1-5** | **No external/generic runner protocol.** `registry.ts:FACTORIES` is a closed table of four types. Supporting OpenCode, Gemini CLI or any wrapper requires a first-party adapter and a release. Five agent CLIs are installed on this machine; two of them are unreachable by the product. | `src/adapters/runners/registry.ts` |
| **P1-6** | **Dev-toolchain vulnerabilities reach a published artifact.** See §1. | `npm audit` |
| **P1-7** | **CI actions are floating tags.** `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4` — not pinned to commit SHAs. A compromised tag executes in a workflow that has the repository checked out. | `.github/workflows/ci.yml` |
| **P1-8** | **No branch protection, no Dependabot, no release pipeline.** `.github/` contains exactly one file. `npm run build` produces a tarball no pipeline verifies; `test:packaging` exists but does not run in CI. | `fd . .github -t f` |

---

### P2 — important hardening

| # | Finding | Evidence |
|---|---|---|
| **P2-1** | **Atomic writes do not `fsync`.** `writeFileAtomic` writes a sibling temp file and renames, with no `fsync` on the file and none on the directory. Rename is atomic against concurrent readers; it is not durable against power loss, and the ordering of the data write against the rename is not guaranteed. | `src/adapters/fs/node-file-system.ts:19` |
| **P2-2** | **No production `doctor`.** `agent-flow doctor` checks runner health and capabilities. It does not produce a `READY / DEGRADED / NOT_READY` verdict and does not evaluate security posture, worktree support, process-group support, disk, or package integrity. | `src/cli/doctor.ts` |
| **P2-3** | **No support bundle.** A failing run says what failed; there is no single command that packages version, platform, sanitized config, state summary, runner versions and doctor output for diagnosis. | absent |
| **P2-4** | **No `accept` / finalization command.** Getting an integrated result onto the operator's branch is a manual Git operation. Not necessarily wrong — but undecided, and therefore undocumented. | `src/cli/index.ts` |
| **P2-5** | **No coverage floor.** Coverage runs in CI as a report. A regression is invisible. | `.github/workflows/ci.yml` |
| **P2-6** | **No documented threat model.** `docs/security.md` exists; there is no `docs/security/THREAT_MODEL.md` enumerating threats against assets with mitigations and tests. | `fd . docs -e md` |
| **P2-7** | **No platform support policy.** Windows is called "not a supported platform for this MVP" in a source comment in `node-process-runner.ts`. That is the only statement of it, and it is not in the README. | `src/adapters/process/node-process-runner.ts:20` |
| **P2-8** | **No stated output bound on persisted logs.** `ProcessRunner` bounds stdout/stderr at 8 MiB with explicit truncation — good. Persisted attempt logs are not separately bounded. | `src/adapters/process/node-process-runner.ts:9` |

---

### P3 — enhancements

- No `agent-flow version --json` with build metadata.
- No SBOM or artifact provenance.
- `README.md` describes `pause/resume/cancel` as designed-not-built; correct today, must
  stay correct.
- Container isolation for external runners is not designed.

---

## 4. Runner inventory — what exists versus what is installed

| Adapter type | Module | Read-only | Structured output | Effort surface | Model-aware |
|---|---|---|---|---|---|
| `claude-code-cli` | `claude-code-runner.ts` | yes | **native** | low/medium/high/very_high | no |
| `codex-cli` | `codex-runner.ts` | yes | prompted | low/medium/high/very_high | no |
| `agy-cli` | `agy-runner.ts` | **no** | prompted | resolved per model | **yes** |
| `openai-compatible` | `openai-runner.ts` | yes (cannot write) | native | fixed set | no |

Every adapter declares `nonInteractiveToolGrants.commandExecution: false`.

**Installed on this machine, and therefore available for live dogfood:**

```
claude     2.1.251           → supported by claude-code-cli
codex      0.149.0           → supported by codex-cli
agy        1.1.22            → supported by agy-cli
opencode   1.18.18           → NO ADAPTER
gemini     0.57.0            → NO ADAPTER
```

`docs/runner-capabilities.md` is an **empirical** probe record with versions and dates —
this is the right artifact and it is honest about the CLI-surface versus effective-pair
distinction. It is stale by a few patch versions (`claude` 2.1.226 probed, 2.1.251
installed).

---

## 5. Test inventory

| Kind | Present | Count |
|---|---|---|
| Unit (core, contracts, ports) | yes | ~60 files |
| Use-case / app | yes | ~40 files |
| Real-Git integration | yes | 11 files (`*.integration.test.ts`) |
| Architecture (dependency rule) | yes | `test/architecture.test.ts` |
| CLI | yes | 13 files |
| Server (HTTP, via inject) | yes | 9 files |
| Web unit (jsdom) | yes | separate workspace |
| Browser E2E (Playwright, real server, scripted runner) | yes | `apps/web/e2e` |
| Visual regression (Linux baselines, pinned container) | yes | `apps/web/visual` |
| Packaging smoke (tarball, fresh install) | yes | `scripts/packaging-smoke.mjs`, **not in CI** |
| **Security / adversarial** | **no** | — |
| **Chaos / fault-injection matrix** | **partial** | 1 suite |
| **Soak** | **no** | — |
| **Adapter contract kit** | **no** | — |
| **Live runner dogfood matrix** | **no** | — |

---

## 6. Milestone dependency graph

```
PR-00 invariants ──┬──────────────────────────────────────────────┐
                   │                                              │
                   ├─► PR-06 process boundary ─► PR-03 pause/resume/cancel
                   │        (cancel + env allowlist)      │
                   │                                      │
                   ├─► PR-07 web control plane ───────────┤   (P0-1)
                   │                                      │
                   ├─► PR-04 runner protocol ─► PR-05 first-party hardening
                   │        └─► adapter contract kit ─────┤
                   │                                      │
                   ├─► PR-08 state & crash safety ────────┤
                   │                                      ▼
                   ├─► PR-12 adversarial suite ─► PR-13 chaos ─► PR-14 soak
                   │                                      │
                   ├─► PR-09 budgets   PR-10 diagnostics  │
                   │   PR-11 accept    PR-17 threat model │
                   │                                      ▼
                   ├─► PR-01 supply chain ─► PR-02 release ─► PR-15 live dogfood
                   │                                      │
                   └─► PR-18 platform policy ─────────────┴─► PR-16 audit ─► PR-19 report
```

**First P0 to close: P0-1** (web control plane). It is the only finding that is remotely
exploitable today, it needs no other milestone to land first, and it is small.

**Then P0-3 → P0-2**, in that order: cancellation cannot be built on a process boundary
that has no way to cancel.
