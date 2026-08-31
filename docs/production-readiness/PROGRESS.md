# Where this stands, and how to pick it up

> **Read this first, then `BASELINE_AUDIT.md` for the findings and
> `PRODUCTION_INVARIANTS.md` for what must stay true.**
>
> **Branch:** `hardening/production-readiness` · **HEAD:** `ea16974` · 9 commits ahead of
> `master` · 57 files, +5746 −105 · **Last worked:** 2026-08-31

---

## Resume in one minute

```bash
cd ~/wk/agent-flow
git switch hardening/production-readiness

# The gates, in the order they get slower.
npm run typecheck && npm run lint && npm run test
npm run test:web && AF_E2E_CHANNEL=chromium npm run test:e2e
npm run build && npm run build:web && npm run test:packaging
gitleaks git --no-banner --redact          # brew install gitleaks

# The local MoE, if the UtilityModel or the openai-compatible probe is wanted.
ssh lellis-dev '~/local-llm-lab/linux/llm-server.sh start moe'
ssh -f -N llm-dev                          # tunnel: 127.0.0.1:8151 → .51's 8080
node --experimental-strip-types scripts/live-runner-probe.ts
```

**Expected, as of `ea16974`:** typecheck ✅ · lint ✅ (3 pre-existing warnings, 0 errors) ·
**3212 unit/integration** ✅ · 293 web ✅ · **38 E2E** ✅ · packaging ✅ · secret scan ✅ ·
`npm audit --omit=dev` ✅.

Anything red is a regression introduced after this commit.

---

## What is done, with the evidence

| Milestone | Landed | Proof |
|---|---|---|
| **PR-00** invariants | 20 invariants, each naming its mechanism and its test | `PRODUCTION_INVARIANTS.md` |
| **PR-01** supply chain | Gitleaks over 170 commits, split dependency audit, CodeQL `security-and-quality`, every action pinned to a SHA, Dependabot, packaging smoke in CI | `.github/`, `.gitleaks.toml` |
| **PR-03** pause/resume/cancel | Two signals; `cancelled` as a terminal status; nothing deleted | `test/app/run-lifecycle.test.ts` (24), `apps/web/e2e/lifecycle.spec.ts` (6) |
| **PR-06** process boundary | `AbortSignal` through to the process group; environment allowlist (77 → 17 vars) | `test/core/process-environment.test.ts` (16), `test/adapters/node-process-runner.test.ts` (30), `scripts/env-allowlist-probe.ts` |
| **PR-07** web control plane | Origin + Host guards ahead of routing | `test/server/request-guard.test.ts` (66), `apps/web/e2e/security.spec.ts` (6) |
| **PR-12** adversarial | *Partial.* Repository content and agent output covered | `test/security/` (14) |
| **PR-05** runners | *Partial.* `openai-compatible` verified live against llama.cpp | `docs/runner-capabilities.md`, `scripts/live-runner-probe.ts` |

### The four defects found along the way

1. **P0 · CSRF and DNS rebinding on the dashboard.** `POST /api/v1/runs/:id/start` with no
   body and `Origin: https://evil.example` answered **202 and started a job** — spawning
   coding agents with write permission in the operator's repository. A bodyless POST is a
   CORS *simple request*: the browser sends it and withholds only the response. Closed by
   `src/server/request-guard.ts`.
2. **P1 · CI red on `master` for 12 days**, since `ab8a460` "turn autonomous recovery on".
   Proved by bisect: green at its parent, red at it. Two causes — the repair loop spent the
   *operator's* retry budget, so the dashboard's Retry button refused every ordinary
   failure; and the C-19 preflight refused `run` before the recovery that reconciles a
   crashed task, so no crashed run could be resumed.
3. **P1 · `AGENTS.md` followed out of the workspace.** The orchestrator read it with its
   own privileges, outside any sandbox, and pasted it into the prompt — so a repository
   shipping it as a symlink to `~/.ssh/id_rsa` got that file into a prompt. Also unbounded.
4. **P2 · A dropped counter class.** `Scheduler.persist` rebuilt each task entry naming the
   fields to keep, so a new optional counter vanished on the next write with nothing to
   compile against. Inverted to spread-then-override.

---

## What is left

Ordered by what unblocks what. Nothing below has been started unless it says so.

### Light — a session each

- **PR-12 · finish the adversarial suite.** Done: repository content, agent output.
  Missing: **filesystem** (path traversal into `.agent-flow/`, hostile worktree names,
  newline and Unicode in filenames, extremely long paths), **Git** (hostile refs reaching
  `validRef`, a corrupted receipt, a receipt/ref mismatch — some of this is already covered
  by `integrator.integration.test.ts`, check before duplicating), and **HTTP** (oversized
  body, malformed body, concurrent writes to one run).
- **PR-17 · `docs/security/THREAT_MODEL.md`.** T1–T20 with asset, vector, trust boundary,
  mitigation, test, residual risk. Most of the substance already exists in `docs/security.md`
  and in the invariants; this is assembly plus honest residual-risk statements.
- **PR-18 · platform policy.** Tier 1 macOS/Linux, Tier 2 Windows. The evidence is already
  in `node-process-runner.ts`: `SUPPORTS_PROCESS_GROUPS` is false on Windows, so the
  timeout and cancel reach only the direct child. Say so in the README rather than in a
  source comment.
- **PR-09 · budgets.** Audit rather than build — `app/autonomy-budget.ts` and
  `core/recovery-policy.ts` already enforce every AR §6 budget. What is genuinely missing
  is **rate-limit backpressure**: check whether `rate_limited` produces a cooldown or a
  retry storm.

### Medium

- **PR-10 · operator diagnostics.** Two pieces, and the first has a finding waiting:
  **`doctor` says nothing at all about the UtilityModel** — an operator can enable an
  advisory model pointing at a dead endpoint and `doctor` answers OK. Add
  `doctor --production` with a `READY / DEGRADED / NOT_READY` verdict covering runner auth,
  worktree support, process-group support, disk, config, security posture and the
  UtilityModel endpoint; and `agent-flow support-bundle`, everything through
  `core/evidence-redaction.ts`. `droppedNames()` in `core/process-environment.ts` exists
  precisely so `doctor` can report what the allowlist withheld.
- **PR-04 · external runner protocol + adapter contract kit.** `registry.ts:FACTORIES` is a
  closed table of four types, so OpenCode and Gemini — both installed on this machine — are
  unreachable. Build `runAdapterContractSuite(adapter)` first: one suite every first-party
  adapter passes (detection, capabilities, happy path, structured output, malformed JSON,
  no terminal result, non-zero exit, timeout, cancellation, rate limit, auth failure,
  missing binary, secret redaction, cwd isolation, process-group cleanup). Then the
  `external` adapter, configured and never discovered (PRI-19).
- **PR-11 · `accept`.** Decide first whether the manual Git flow is already safer. If it
  ships: run terminal success + final verification PASS + DoD PASS + clean tree + explicit
  confirmation; never force-merge, force-push or hard-reset; a conflict aborts cleanly.
- **PR-02 · release engineering.** `tag → fresh checkout → npm ci → gates → build → npm pack
  → isolated install → CLI smoke → publish`, OIDC/Trusted Publishing, SBOM, checksums. Do
  **not** publish: check the package name and get explicit authorisation first. Target
  `v0.x.0-rc.1`, and dogfood that artifact rather than the checkout.

### Heavy

- **PR-08 · fault injection.** `test/fixtures/crash.ts` is a good `Proxy`-based injector
  used by exactly one suite. Enumerate the 14 fault points the program lists (after agent
  exit, after validation, before/after write-tree, during receipt write, before/after
  marker, before/during/after merge, wave transition, final verification, review,
  corrective round) and assert: resume safely, or refuse safely. Never a duplicated
  integration, never a re-run completed task, never a lost successful attempt.
  Also from the baseline: **`writeFileAtomic` does not `fsync`** — rename is atomic against
  readers, not durable against power loss.
- **PR-13 · chaos.** Kill the coordinator at each of those points, then `run` / `resume`.
  Acceptance: no duplicated integration, no lost attempt, no orphan worktree, no stale
  process, no corrupted state accepted silently.
- **PR-14 · soak.** 100 full runs with scripted agents — no quota, only wall-clock. Cover
  1 task, many, chains, fan-out, fan-in, parallel 2/4/8, retry, review rejection,
  corrective round, integration conflict, pause, resume, cancel, coordinator crash. Measure
  leaked worktrees, refs, processes, locks, temp files.
- **PR-15 · live dogfood.** Only after every deterministic gate is green. Installed here:
  `claude 2.1.251`, `codex 0.149.0`, `agy 1.1.22`. `gemini 0.57.0` and `opencode 1.18.18`
  are installed and **both fail on their own** — gemini with `IneligibleTierError` (vendor
  deprecation), opencode against an unreachable local endpoint. Verified by control run:
  neither failure is caused by the environment allowlist.
- **PR-16 · independent audit.** Must not be the agent that wrote the hardening. Codex or
  AGY, given the source, the invariants, the threat model and the test matrix, prompted to
  **break the production-readiness claim** — never to confirm it.
- **PR-19 · `FINAL_REPORT.md`.** The matrix, then the verdict. It cannot read
  `LOCAL_AUTONOMOUS_READY` while PR-13/14/15/16 are open.

---

## The decision that was left open

The last question asked how to treat the two expensive milestones — full soak plus full
dogfood matrix, a reduced dogfood, or deferring both. **It was not answered**; the reply
asked for this file instead. Pick it up there.

Consequence, stated plainly so it is not rediscovered later: **`LOCAL_AUTONOMOUS_READY`
requires PR-13, PR-14, PR-15 and PR-16.** Without them the honest verdict is
`LOCAL_SUPERVISED_READY`, and the gap must be named in the final report rather than
softened.

---

## Machine facts worth not rediscovering

- **The MoE.** `~/.agent-flow/config.yaml` now points `utilityModel` at
  `http://127.0.0.1:8151/v1`, model `moe`, key from
  `AGENT_FLOW_UTILITY_MODEL_API_KEY` (the server accepts `local`). The backup of the
  previous config is beside it as `config.yaml.bak-*`. The server lives on `lellis-dev`
  (`10.240.0.51`, RTX 3060 Ti) and is **not** exposed on the LAN — the SSH tunnel is what
  reaches it. Port 8151 rather than 8080 because the Mac's own MLX server holds 8080.
- **Node.** `scripts/env-allowlist-probe.ts` and `scripts/live-runner-probe.ts` import
  TypeScript directly and need a Node that strips types (24 here, by default). They are
  evidence scripts, not CI gates, so this does not bind the package's `engines` floor.
- **The dev-toolchain advisories are still open.** 2 critical, 1 high, 3 moderate, all in
  `vitest`/`vite`, all needing major upgrades. They gate nothing today because the audit is
  split — runtime blocks, toolchain reports — but `apps/web/dist` *is* built by `vite` and
  shipped, so this is P1 rather than noise. It belongs in its own reviewed pull request.
- **Three lint warnings** in `test/core/repository-retriever.test.ts` predate this branch
  (unused `eslint-disable` directives). 0 errors.
