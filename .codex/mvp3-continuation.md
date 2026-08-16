# MVP3 Continuation State

Updated: 2026-08-16
Published HEAD: 9df0029 (M3-08 advisory runtime)
origin/master: 25182ca
Local HEAD: 9df0029
Current milestone: M3-09 — dogfood and benchmark
Current status: M3-09 IN PROGRESS (wiring + A/B dogfood + blocked-recovery FIX COMPLETE; matrix + final audit NEXT)

## Completed milestones

- M3-00: PASS
- M3-01: PASS
- M3-02: PASS
- M3-03: PASS / PUBLISHED
- M3-04: PASS / PUBLISHED
- M3-05: PASS / PUBLISHED
- M3-06: PASS / PUBLISHED
- M3-07: PASS / PUBLISHED (69660ae, dc58dc6, 0b645d4, 974a504, 620b5fe)

## Historical findings

ID: M3-04-F01
severity: P2
milestone: M3-04
finding: Evidence trust gap
resolution: Closed before publication
commit: 65b1ef376a464aa45f5439dac80c7f3f6f72bfa8

ID: M3-04-F02
severity: P2
milestone: M3-04
finding: Candidate recall starvation
resolution: Closed before publication
commit: 65b1ef376a464aa45f5439dac80c7f3f6f72bfa8

ID: M3-04-F03
severity: P3
milestone: M3-04
finding: Git filename parsing was not machine-safe
resolution: Closed with `git ls-files -z`
commit: 65b1ef376a464aa45f5439dac80c7f3f6f72bfa8

ID: M3-05-F01
severity: P1
milestone: M3-05
finding: Intermediate-directory TOCTOU could redirect an opened candidate outside the repository after pre-open realpath validation.
resolution: Closed by secure content-read implementation and regression tests in 153cec3.
commit: 153cec3ecc032ba682f5f11f0cf821741da2e74b

ID: M3-05-F02
severity: P1
milestone: M3-05
finding: Trimming path normalization could map an exact candidate such as ` .env` to a different `.env` file.
resolution: Closed by secure content-read implementation and regression tests in 153cec3.
commit: 153cec3ecc032ba682f5f11f0cf821741da2e74b

ID: M3-05-F03
severity: P1
milestone: M3-05
finding: In-repository symlinks could alias undiscovered sensitive content.
resolution: Closed by secure content-read implementation and regression tests in 153cec3.
commit: 153cec3ecc032ba682f5f11f0cf821741da2e74b

ID: M3-05-F04
severity: P2
milestone: M3-05
finding: Opening a FIFO before file-kind validation could block indefinitely.
resolution: Closed by secure content-read implementation and regression tests in 153cec3.
commit: 153cec3ecc032ba682f5f11f0cf821741da2e74b

ID: M3-05-F05
severity: P2
milestone: M3-05
finding: POSIX path operations corrupted Windows UNC repository roots.
resolution: Closed by secure content-read implementation and regression tests in 153cec3.
commit: 153cec3ecc032ba682f5f11f0cf821741da2e74b

ID: M3-05-F06
severity: P3
milestone: M3-05
finding: Invalid failure paths could echo terminal control characters.
resolution: Closed by secure content-read implementation and regression tests in 153cec3.
commit: 153cec3ecc032ba682f5f11f0cf821741da2e74b

ID: M3-05-F07
severity: P3
milestone: M3-05
finding: Architecture guards used an incomplete denylist and missed barrel-import wiring.
resolution: Closed by secure content-read implementation and regression tests in 153cec3.
commit: 153cec3ecc032ba682f5f11f0cf821741da2e74b

ID: M3-05-F08
severity: P1
milestone: M3-05
finding: A double-swap race could align separate post-open path checks with an externally opened handle.
resolution: Closed by secure content-read implementation and regression tests in 153cec3.
commit: 153cec3ecc032ba682f5f11f0cf821741da2e74b

ID: M3-05-F09
severity: P1
milestone: M3-05
finding: Win32 trailing-dot/space, reserved-name and ADS aliases could map apparently safe paths to forbidden targets.
resolution: Closed by secure content-read implementation and regression tests in 153cec3.
commit: 153cec3ecc032ba682f5f11f0cf821741da2e74b

ID: M3-05-F10
severity: P2
milestone: M3-05
finding: C1 and selected Unicode terminal/direction controls could survive in diagnostic paths.
resolution: Closed by secure content-read implementation and regression tests in 153cec3.
commit: 153cec3ecc032ba682f5f11f0cf821741da2e74b

ID: M3-05-F11
severity: P1
milestone: M3-05
finding: Case-insensitive and Unicode-normalizing filesystems could resolve a differently spelled candidate to another directory entry.
resolution: Closed by secure content-read implementation and regression tests in 153cec3.
commit: 153cec3ecc032ba682f5f11f0cf821741da2e74b

ID: M3-05-F12
severity: P1
milestone: M3-05
finding: Remaining Win32-forbidden filename characters were accepted on POSIX, breaking portable exact authority.
resolution: Closed by secure content-read implementation and regression tests in 153cec3.
commit: 153cec3ecc032ba682f5f11f0cf821741da2e74b

ID: M3-05-F13
severity: P2
milestone: M3-05
finding: Additional Unicode format and separator controls could enter successful/diagnostic paths.
resolution: Closed by secure content-read implementation and regression tests in 153cec3.
commit: 153cec3ecc032ba682f5f11f0cf821741da2e74b

ID: M3-05-F14
severity: P1
milestone: M3-05
finding: Lone UTF-16 surrogates could encode to the same UTF-8 bytes as U+FFFD and alias another filename.
resolution: Closed by secure content-read implementation and regression tests in 153cec3.
commit: 153cec3ecc032ba682f5f11f0cf821741da2e74b

ID: M3-05-F15
severity: P1
milestone: M3-05
finding: Win32 reserved COM/LPT names using superscript 1, 2 or 3 were accepted.
resolution: Closed by secure content-read implementation and regression tests in 153cec3.
commit: 153cec3ecc032ba682f5f11f0cf821741da2e74b

ID: M3-05-F16
severity: P1
milestone: M3-05
finding: Candidate preprocessing and skipped-source artifact metadata remained unbounded before maxCandidates selection.
resolution: Closed by bounded trust-preserving compression and regression tests in cc76490.
commit: cc76490ae718d8b0fba4835d11041cb5c39f393a
ID: M3-05-F17
severity: P1
milestone: M3-05
finding: Raw model output could close advisory markup and forge framework-looking provenance in finalContext.
resolution: Closed by bounded trust-preserving compression and regression tests in cc76490.
commit: cc76490ae718d8b0fba4835d11041cb5c39f393a
ID: M3-05-F18
severity: P1
milestone: M3-05
finding: The default chars-per-token estimator was not a provider-neutral upper bound and could exceed an advertised context window.
resolution: Closed by bounded trust-preserving compression and regression tests in cc76490.
commit: cc76490ae718d8b0fba4835d11041cb5c39f393a
ID: M3-05-F19
severity: P1
milestone: M3-05
finding: A caller-overridden Array.slice could bypass the hard examined-request cap.
resolution: Closed by bounded trust-preserving compression and regression tests in cc76490.
commit: cc76490ae718d8b0fba4835d11041cb5c39f393a
ID: M3-05-F20
severity: P1
milestone: M3-05
finding: Oversized path strings were normalized before the length gate.
resolution: Closed by bounded trust-preserving compression and regression tests in cc76490.
commit: cc76490ae718d8b0fba4835d11041cb5c39f393a
ID: M3-05-F21
severity: P1
milestone: M3-05
finding: Re-read getters in content-source DTOs could change content after validation and exceed aggregate limits.
resolution: Closed by bounded trust-preserving compression and regression tests in cc76490.
commit: cc76490ae718d8b0fba4835d11041cb5c39f393a
ID: M3-05-F22
severity: P2
milestone: M3-05
finding: localeCompare made candidate selection locale-dependent.
resolution: Closed by bounded trust-preserving compression and regression tests in cc76490.
commit: cc76490ae718d8b0fba4835d11041cb5c39f393a
ID: M3-05-F23
severity: P1
milestone: M3-05
finding: Content strings were scanned for UTF-8 byte length before an O(1) aggregate-size precheck.
resolution: Closed by bounded trust-preserving compression and regression tests in cc76490.
commit: cc76490ae718d8b0fba4835d11041cb5c39f393a
ID: M3-05-F24
severity: P1
milestone: M3-05
finding: Model output was trimmed before the hard output-character cap.
resolution: Closed by bounded trust-preserving compression and regression tests in cc76490.
commit: cc76490ae718d8b0fba4835d11041cb5c39f393a

ID: M3-05-F25
severity: P2
milestone: M3-05
finding: EOF after post-stat truncation was accepted as successful partial raw truth; same-inode in-place rewrites were not checked after reading.
resolution: Closed by stable exact-length FileHandle snapshot proof and regressions in 4d6ea27.
commit: 4d6ea2760e5f353ae09ddf54cd87960497155bab
ID: M3-05-F26
severity: P3
milestone: M3-05
finding: Post-read file growth was rejected by implementation but lacked an isolated regression test.
resolution: Closed by stable exact-length FileHandle snapshot proof and regressions in 4d6ea27.
commit: 4d6ea2760e5f353ae09ddf54cd87960497155bab
ID: M3-06-F01
severity: P1
milestone: M3-06
finding: Secret redaction missed Basic Auth, quoted/underscored JSON keys and ANSI-split private-key markers.
resolution: Closed with canonicalization/redaction regressions and final 23/23 acceptance.
commit: db3d630

ID: M3-06-F02
severity: P2
milestone: M3-06
finding: Never-settling UtilityModel health/run promises could block mechanical log triage.
resolution: Closed with local model health/run deadlines and fail-open mechanical fallback.
commit: db3d630

ID: M3-06-F03
severity: P2
milestone: M3-06
finding: examinedChars/Bytes counted stream content not actually scanned after the global line cap.
resolution: Closed by counting only content actually scanned through the global line boundary.
commit: db3d630

ID: M3-06-F04
severity: P2
milestone: M3-06
finding: Structured advisories could exceed aggregate model output budgets despite tiny raw text.
resolution: Closed with aggregate structured advisory character/token budgets.
commit: db3d630

ID: M3-06-F05
severity: P2
milestone: M3-06
finding: Model advisory LF/CR controls could forge visual validation lines.
resolution: Closed by single-line control-safe advisory normalization.
commit: db3d630

ID: M3-06-F06
severity: P1
milestone: M3-06
finding: Git diff allowed configured textconv execution and misclassified converted binary content.
resolution: Closed by --no-textconv with a real configured-driver regression.
commit: 983477211035

ID: M3-06-F07
severity: P1
milestone: M3-06
finding: Git replace refs could change diff truth while snapshot provenance retained original OIDs.
resolution: Closed by canonical GIT_NO_REPLACE_OBJECTS=1 on every Git subcommand and a real replace-ref regression.
commit: 983477211035

ID: M3-06-F08
severity: P3
milestone: M3-06
finding: Positive fractional diff caps below one sanitized to zero.
resolution: Closed by flooring before enforcing the positive-integer fallback.
commit: 983477211035

ID: M3-06-F09
severity: P3
milestone: M3-06
finding: Diff status parser accepted bare rename/copy and impossible scores such as R999.
resolution: Closed with strict R/C score grammar limited to 0..100.
commit: 983477211035

ID: M3-06-F10
severity: P1
milestone: M3-06
finding: Invisible controls split credential/private-key markers and bypassed redaction.
resolution: Closed by removing ANSI/invisible controls before credential and armor detection.
commit: db3d630

ID: M3-06-F11
severity: P1
milestone: M3-06
finding: Standalone auth schemes, generic PEM/PGP blocks and escaped JSON credential values were incompletely redacted.
resolution: Closed with whole-tail Basic/Digest and generic armor/escaped JSON redaction.
commit: db3d630

ID: M3-06-F12
severity: P2
milestone: M3-06
finding: HTML escaping could expand a model summary beyond its individual output cap.
resolution: Closed by applying escaping before the final individual and aggregate bounds.
commit: db3d630

ID: M3-06-F13
severity: P1
milestone: M3-06
finding: Deleting TAB collapsed standalone Basic/Digest credential delimiters before redaction.
resolution: Closed by normalizing TAB/CR/LF to a semantic space while deleting other controls.
commit: db3d630

ID: M3-06-F14
severity: P1
milestone: M3-06
finding: C1 ANSI sequences left parameter text that split credential and armor markers.
resolution: Closed by stripping complete ESC and C1 CSI/OSC/ST sequences before matching.
commit: db3d630

ID: M3-06-F15
severity: P2
milestone: M3-06
finding: Standalone Basic redaction could expose credential suffixes after punctuation.
resolution: Closed by redacting the full standalone scheme tail; exact punctuation acceptance passed.
commit: db3d630

ID: M3-06-F16
severity: P1
milestone: M3-06
finding: Diff patch trust checked only block count/header and accepted contradictory metadata, binary claims, and malformed hunk lines.
resolution: Closed by complete patch grammar and semantic cross-checks against the Git snapshot.
commit: 43b6317

ID: M3-06-F17
severity: P1
milestone: M3-06
finding: Diff excerpts and prompts leaked secrets in prefixed environment identifiers such as AWS_SECRET_ACCESS_KEY and GITHUB_TOKEN.
resolution: Closed by secret-identifier redaction in excerpts, headers, paths and prompts.
commit: 43b6317

ID: M3-06-F18
severity: P1
milestone: M3-06
finding: Free-form UtilityModel summaries could assert merge, review, validation, evidence, test, or completion authority.
resolution: Closed by replacing free-form model summaries with closed risk/tag enums.
commit: 43b6317

ID: M3-06-F19
severity: P2
milestone: M3-06
finding: Structured enrichment enumerated arbitrary object property names before a bounded operation or deadline.
resolution: Closed by ignoring arbitrary structured objects and parsing only pre-bounded text.
commit: 43b6317

ID: M3-06-F20
severity: P2
milestone: M3-06
finding: Valid exact unquoted UTF-8 Git paths under core.quotePath=false were falsely rejected.
resolution: Closed by exact raw UTF-8 support only when Git may emit the path unquoted.
commit: 43b6317

ID: M3-06-F21
severity: P1
milestone: M3-06
finding: Patch grammar still trusted empty modified blocks, unknown metadata, overlapping/zero-range hunks, and mixed binary/text bodies.
resolution: Closed by a closed ordered grammar, known metadata, valid ranges, non-overlap and binary/text exclusion.
commit: 43b6317

ID: M3-06-F22
severity: P1
milestone: M3-06
finding: Lexical authority blacklist accepted simple paraphrases of merge/review/test/task/validation/evidence claims.
resolution: Closed by a conservative advisory contract containing only caller-owned file IDs and closed risk/tag enums.
commit: 43b6317

ID: M3-06-F23
severity: P2
milestone: M3-06
finding: UTF-8 raw-header fallback also accepted quotes/backslashes that Git must C-quote.
resolution: Closed by requiring C-quoted headers for quotes, backslashes and controls while allowing safe UTF-8 raw bytes.
commit: 43b6317

ID: M3-06-F24
severity: P2
milestone: M3-06
finding: Sensitive assignments embedded in valid Git paths were redacted in prompts but leaked through artifact paths.
resolution: Closed by suppressing sensitive path/previousPath values in the artifact and prompt while raw Git truth remains external.
commit: 43b6317

ID: M3-06-F25
severity: P1
milestone: M3-06
finding: DiffTriager redaction did not strip C1 ANSI sequences and truncated Digest redaction at the first comma, leaking secrets in artifacts and prompts.
resolution: Closed with shared-equivalent C1/OSC/auth-shaped redaction and artifact/prompt regressions.
commit: 18030fc

ID: M3-06-F26
severity: P1
milestone: M3-06
finding: Git diff snapshots accepted tree/blob/tag OIDs because lowercase 40-hex syntax was treated as proof of commit type.
resolution: Closed by bounded canonical `git cat-file -t` exact commit-type checks before both diff calls.
commit: 18030fc

ID: M3-06-F27
severity: P2
milestone: M3-06
finding: GitClient accepted real rename/copy scores such as R0/R50 while DiffTriager only accepted three-digit scores.
resolution: Closed by validating real padded porcelain scores and normalizing once to the unpadded internal contract.
commit: 18030fc

ID: M3-06-F28
severity: P2
milestone: M3-06
finding: Broad Basic/Digest redaction corrupted ordinary code prose that was not auth-shaped.
resolution: Closed by requiring deterministic auth-shaped context for standalone Basic/Digest redaction.
commit: 18030fc

ID: M3-06-F29
severity: P2
milestone: M3-06
finding: C1 OSC normalization did not recognize the valid 7-bit ST terminator ESC-backslash and consumed the visible suffix.
resolution: Closed by recognizing BEL, C1 ST and ESC-backslash terminators while preserving the visible suffix.
commit: 18030fc

ID: M3-06-F30
severity: P1
milestone: M3-06
finding: Git porcelain emits zero-padded similarity scores such as R090, but the producer incorrectly rejected them instead of normalizing the internal score.
resolution: Closed by accepting padded 000..100 at the Git boundary and normalizing to canonical internal R/C scores.
commit: 18030fc

ID: M3-06-F31
severity: P2
milestone: M3-06
finding: A benign line-final phrase such as `Use basic arithmetic` still matched standalone Basic credential redaction.
resolution: Closed by distinguishing lowercase benign prose from credential-shaped standalone Basic tokens.
commit: 18030fc

ID: M3-06-F32
severity: P2
milestone: M3-06
finding: Greedy 7-bit OSC normalization consumed visible suffix after ESC-backslash and fell through to the end-of-line alternative.
resolution: Closed by excluding ESC from OSC payloads and stopping at the first valid terminator.
commit: 18030fc

ID: M3-07-F01
severity: P1
milestone: M3-07
finding: Re-read input accessors could change content/token limits after validation and alter the actual wire request.
resolution: Closed by a single own-data snapshot used for validation, estimation and wire serialization.
commit: 69660ae

ID: M3-07-F02
severity: P1
milestone: M3-07
finding: Response model provenance used a denylist and accepted header-shaped, URI and free-form secret-bearing strings.
resolution: Closed by a conservative response-established identifier allowlist and closed provider vocabulary.
commit: 69660ae

ID: M3-07-F03
severity: P2
milestone: M3-07
finding: Schema serialization/getter/proxy failures could reject run() and expose hostile thrown text.
resolution: Closed by constant failure normalization without inspecting hostile thrown values.
commit: 69660ae

ID: M3-07-F04
severity: P2
milestone: M3-07
finding: Inherited/accessor response properties and hostile HTTP status values could forge provenance or leak text.
resolution: Closed by an exact native Response trust boundary, bounded status and deep own-data JSON snapshots.
commit: 69660ae

ID: M3-07-F05
severity: P1
milestone: M3-07
finding: snapshotNativeResponse rejected every genuine native Response because Node's undici Response stores its state in own symbol properties (Symbol(state)/Symbol(headers)) and the trust boundary treated any own property as hostile, so healthCheck and run always failed. Shipped broken in 69660ae with 48 red tests.
resolution: Closed by rejecting only own string-keyed properties (which is how hostile code shadows the prototype status getter or json method) while allowing native symbol internals; regression tests pin both acceptance and native shadow rejection.
commit: 974a504

ID: M3-07-F06
severity: P3
milestone: M3-07
finding: The Analytics page ignored the context telemetry aggregate the read model already served, so M3-07's UI/read-model exposure was missing.
resolution: Closed by a read-only "Context intelligence" panel rendering estimated/not-billing metrics, degradation counts and the closed effective identity, with unit tests for presence, degradation and absence semantics.
commit: 620b5fe

## Current architecture invariants

- UtilityModel is optional, advisory, provider-neutral, and non-authoritative.
- ContextPacket is not Evidence and cannot replace raw source truth.
- Repository paths originate from deterministic trusted discovery.
- Model output cannot invent trusted paths or evidence.
- Candidate discovery is deterministic, objective-sensitive, and bounded.
- Git file discovery uses `git ls-files -z` through the canonical Git boundary.
- Content reads refuse all file and directory symlinks and require a stable exact raw directory-entry snapshot.

## Last quality gates

targeted: PASS — M3-07 telemetry/adapter/server suites green
blocked-recovery (F03): PASS — scheduler + gate suites green, incl. single/multi-hop release, agent-blocked force-only, fail-closed legacy
architecture: PASS
check: PASS — 2469 core passed, 2 skipped; 243 web passed
E2E: PASS — 26/26
visual: PASS — 137 passed, 3 expected skips; no blind snapshot update
packaging: PASS
diff --check: clean

## Dogfood status

- Local OpenAI-compatible endpoint: `/models` HTTP 200 with `moe` and 64k context; `/chat/completions` returns HTTP 401 without the server API key.
- Authenticated local `moe` inference was proven HTTP 200 without exposing the secret. The server receives it through `--api-key`; Agent Flow references dedicated env var `AGENT_FLOW_UTILITY_MODEL_API_KEY` at composition time (value `local`, referenced via env ONLY, never persisted).
- AGY CLI 1.1.13: safe stdin smoke passed; Agent Flow deep doctor reports healthy.
- Codex CLI: EXCLUDED for dogfood — first discovery hit `quota_exceeded` instantly. Use AGY + claude-free fallback only.

## M3-09 findings so far

- ID: M3-09-F01 (P3, dogfood finding): Claude Code drops `.atl/` droppings and uv/ruff/pytest leave cache dirs that polluted deterministic candidate discovery. FIXED: added `.atl`, `__pycache__`, `.pytest_cache`, `.ruff_cache` to `DEFAULT_EXCLUDED_SEGMENTS` + 5 regression tests. All gates green.
- ID: M3-09-F02 (P3, M3-09-F01 variant): Only clearly tool-owned/generated dirs added; patterns like `.atl.tools.ts`, `atl/`, `__pycache` are NOT excluded (source-like content preserved). Locked by test.
- ID: M3-09-F03 (P2, dogfood finding): Dependency-derived `blocked` was unrecoverable. In RUN A, TASK-010 stayed blocked across three subsequent `agent-flow run` calls (15:22:40/52/58, no dispatch) after TASK-008 recovered and completed (15:22:32); only `retry TASK-010 --force` (15:24:15) reopened it. Root cause: `blockedByFailure` treats persisted `blocked` as a poison root, and nothing distinguishes "the task's own agent answered BLOCKED" from "an upstream failure held a task that never ran". FIXED RED-first: `blockReason: 'agent' | 'dependency'` persisted on `TaskProgress` (fail-closed: absent → `agent`); `dag.unblockedByRecovery` releases a `dependency` block only when every dependency is `completed`; scheduler runs the release at the top of every wave (multi-hop works in one invocation, C only after B truly completes) and emits `task_unblocked`; agent-BLOCKED tasks still require `retry --force` (§23); `retryTask` accepts a dependency-blocked task without force. Read model exposes `blockReason`. LOCAL, not committed: checkpoint for review before commit.
- ID: M3-09-F04 (P3, read-model clarity, record-only): the final-review artifact seen during A/B was written against `state.integrationHead` at judgeRun time and reflected intermediate diagnostic review, not the authoritative final review at the current integration HEAD; the artifact is replaced at final close and DoD is re-evaluated then. No control-plane impact. Future UI: distinguish intermediate diagnostic review from authoritative final review at integration HEAD.

## A/B dogfood result (retrykit scratch repo, /tmp)

- RUN A (Utility OFF, armA AF-2026-001): 10/10 tasks FEATURE COMPLETE, 25 integration commits, review PASS (1 low: pytest marker), 0 telemetry events, 4 requeues, 1 conflict, ~37 min wall (14:51:11Z → 15:28:07Z).
- RUN B (Utility ON, armB, env AGENT_FLOW_UTILITY_MODEL_API_KEY=local): 10/10 tasks COMPLETE, 25 commits, review PASS, 18 context_telemetry_observed events (7 advisories delivered 3-10 files), 11 validation_failed bypasses, 1 requeue, 0 conflicts, ~50 min wall (15:29:16Z → 16:19:49Z).
- Verdict: telemetry fires only with the key present (resolveUtilityModel wiring correct); advisory reduces detection/recovery churn (fewer requeues/conflicts) at the cost of latency; on a small repo both produce identical 10/10. Trust boundary (allowedEvidence:∅, requireTrustedPaths) fail-closes hallucinated/evidence-bearing output. Secret containment held under load (0 leaks in persisted state).
- EXECUTION POLICY (user-set, mandatory): NO Claude Code / Anthropic runners for any role. OpenCode is driver. AGY is the allowed AgentRunner (record same-provider degradation). Local OpenAI-compatible model = UtilityModel ONLY, never review/verification authority. If a workflow role genuinely cannot proceed without Claude, stop that specific test and report the blocker.

## Next action

M3-09 — finish the MVP3 minimal matrix (small/medium/large cross-module task, large failing test log, large diff review, utility model offline, malformed output, context > 64k candidates) comparing OFF vs ON. Metric collection already demonstrated in RUN A/B: correctness, telemetry (context_telemetry_observed with candidatesBefore/After, filesAfter, bypassReason), latency, retries, review findings. The P2 blocked-recovery defect (F03) is FIXED locally with full gates green — checkpoint/commit the fix, then continue with the matrix, product readiness, M3-09 self-audit, all gates, safe publication, cumulative self-audit M3-04..M3-09 + final report.

## Blockers

- NONE hard. Remaining risks: local `moe` endpoint could go offline (degrade ON arm to undefined-adapter → OFF-identical; record as such, never fabricate). Codex quota (routed around with AGY).

## M3-08 summary

- Advisory runtime wired: `StageAdvisor` seam (stage-runner), `renderAdvisoryContext` (fail-closed paths), `RepositoryContextAdvisor` (Retriever+UtilityModel), mechanical telemetry via `ContextTelemetryRecorder`, composition-root wiring behind optional `utilityModel` (offline = unchanged workflow). Commits `135f91c`, `9be49cb`, `901ec99`, `9df0029`.
- Implementation stage passes a task-derived objective so retrieval ranks against the real work.
- Self-audit findings fixed: (1) objective degraded to literal stage name without task pass-through; (2) repair loop would drop advisory context on re-prompts (base-prompt seed). Both locked by regression tests.
- Gates green: check 2414+243, E2E 26/26, visual 137/3, packaging PASS, diff --check clean.
