# Field report — 23/09/2026: daily use on Windows, two real incident fixes

Goal of the day: make agent-flow usable every day — any project, opened from anywhere, driven from
the CLI, the Deck or another chat — and prove it on real work. Machine: Windows 11, default
Node 20.10 (nvm-windows) with 22.23.2 beside it, Claude Code 2.1.280, agy 1.2.8, one provider.

Two runs, both a display-vs-billing pricing incident, every role on `claude-opus-5-5`:

- **A Python/FastAPI service** (tests in a throwaway Docker container). 74 min of model time, of
  which implementation was 9: discovery 23 (one extra call was a bug, fixed below), impact 7, SDD 11,
  plan + plan review 10, verification 2, final review 11. The final review caught a real defect
  (new tests missing the marker the team's unit suite selects on).
- **A Node/Vue monorepo** (the backend's native campaign pricing). Planning 14 min, three tasks,
  FEATURE COMPLETE. The impact stage corrected two premises of the request by reading code: the
  module named as the billing reference has no caller, and the same pricing feeds a search index
  the request never mentioned.

## Fixed — each with a test, a positive control where it applied, suite green

| # | Defect, as measured | Where |
|---|---|---|
| 1 | Claude model list was a fixed `opus/sonnet/haiku`: Opus 5.5 and Fable never appeared | `claude-code-runner.ts` reads `~/.claude/cache/model-catalog` |
| 2 | The dashboard needed a `cd` into a project; the hub was written only by `ui` | `app/project-hub.ts`, `cli/projects.ts`, postAction hook |
| 3 | `ui` refused on Node 20.10 from everywhere | `cli/node-runtime.ts` re-runs on nvm's newest ≥ 20.19 |
| 4 | Port taken by a running dashboard printed an error | `ui` opens the running one (`probeDashboard`) |
| 5 | No way to keep the dashboard up | `agent-flow autostart` (Startup folder / LaunchAgent) |
| 6 | The home directory was a project (`~/.agent-flow/config.yaml` is also the marker) | hub, registry walk, config loader |
| 7 | Disabled runner shown as "AUSENTE" (installed CLI) | `/runners/health` `unavailable`, Deck chip |
| 8 | Sticky save bar covered controls scrolled into view | `html:has(.crew-actions)` scroll padding |
| 9 | `init` on Windows wrote the whole path as `project.name` | `stack-detection.ts` splits on both separators |
| 10 | CLAUDE.md never read; hundreds of lines of rules invisible behind a 21-line scaffold | `app/project-instructions.ts` |
| 11 | Run title was the whole 5 KB request, in the CLI and every Deck list | `contracts/feature-title.ts` |
| 12 | Four parent-session variables leaked into spawned agents | `PARENT_SESSION_NAMES` |
| 13 | Diagnostics said "missing permission" while `--allowedTools` granted it; on Windows the grant must also name the `PowerShell` tool | claude `capabilities()` reads its args |
| 14 | `revise --from sdd` re-ran a 10-minute discovery | discovery honours `--from` |
| 15 | Metrics showed model ids humanised ("claude opus 5 5") | `Buckets verbatim` |
| 16 | `STATUS: BLOQUEADO` parsed as COMPLETED under `language: pt-BR` | `parseResultBlock`, language instruction |
| 17 | A second `feature` re-aimed `current-run` under a live execution | `createRunWithIdentity` refuses `run_busy` |
| 18 | e2e prompt: shared browser session, `$TMPDIR` empty on Git Bash, daemon pipe hang, Flutter web invisible, env failure turned into FIX work | `prompts/e2e.md` (all measured) |
| 19 | Prompts: interactive-session rituals from CLAUDE.md, BLOCKED on a refused command, no task whose work is running commands, SDD treats the request as a claim | `implementation.md`, `planning.md`, `sdd.md` |
| 20 | **Every configured command with a quoted argument was broken on Windows**: `cross-spawn` escaped the `cmd /c` line as argv (`\"`), and `docker run -v "%CD%\server:/src:ro"` died with "too many colons" — read as the project's tests failing | `shellInvocation` + `verbatimArguments` (Node's own `shell: true` shape) |
| 21 | **One provider is a choice, not a defect.** HIGH-RISK refused a single-provider setup; every same-provider review recorded `single_provider` and the Deck queued it as work that "needs you" | refusal removed; the degradation is no longer recorded, legacy ones dropped on read; no warning in approval or CLI |
| 22 | Degradations sat in "Precisa de você", while a run held at final acceptance appeared nowhere | the queue holds only what a person must do; new `final_review_required` (P1, action `review`) |
| 23 | Diagnostics called `architecture-impact` and `sdd` "text in, text out" and suggested a runner with no filesystem — the impact stage is the one that found, by reading code, what changed the plan | both prompts declare `workingDirectory: true`; the note states what an endpoint gives up |
| 24 | Diagnostics showed "Node 20.10, below 20.19" on a dashboard served by Node 22 | `dashboardNode` beside the PATH Node |
| 25 | Planning re-mapped the whole repository even when an orchestrating model had already investigated | `feature --grounded`: no fresh discovery (a valid cached map is still used), the impact confirms the request's claims in code; persisted on the run |
| 26 | Deck: an eleven-cell stepper with labels cut to fit and no implementation step; "this run reviewed nothing" on a run with three reviews; "2 in motion" with nothing running; CSS variables that do not exist | five phases (`lib/phases.ts`), run-level reviews in the review tab, moving = actually running, tokens fixed; plus a text pass over every screen |
| 27 | "Precisa de você" asked for the final review while `review` ran — through its install and commands, often the longest part — and the Deck phase read "waiting for you" | `review` records `run_review_started` before preparing anything; the projection carries `reviewInProgress`, which a failed review stage ends, and the queue and the Deck read it |
| 28 | Diagnostics counted a `Bash(...)` grant as command permission on Windows, where it is denied; the doctor note read the args a second way | `grantsCommands` names the tool per platform and reads `--allowedTools=`; the note asks the adapter |
| 29 | `feature` refused with `run_busy` exited 1, the code of a broken repository; the README promised 5 | `RUN_BUSY` for that refusal |
| 30 | The "only listed modules spawn a shell" rule scanned text with every string blanked, so `'cmd.exe'` and `'/bin/sh'` were invisible: three modules shelled out unlisted while it passed | scans with comments stripped and strings kept; each allowed module states why, and an unused permission fails |
| 31 | `autostart remove` on macOS deleted the plist before `launchctl unload`, which then failed silently | unload first |
| 32 | `ui` with a dashboard running dropped `--depth`/`--classic`/`--pair` silently; `projects add ~` said "already in" for a directory never added | both say what happened |
| 33 | Old logs' `single_provider` still read "Degraded" in the timeline; `status` printed "skipped" before discovery was reached | a neutral line for the legacy event; the skip is read from `stage_skipped` |
| 34 | Docs and code comments said nine prompts "carry their whole input"; `verification` and `final-review` tell the model to read the changed files, of which it gets only the paths | both declare `workingDirectory: true`: five of thirteen, everywhere it was said |

**`--grounded`, measured once:** the same request, from the same base commit, planned both ways.
Planning 14m05s → 9m05s, impact context 71 KB → 39 KB, every finding of the first run present in
the second, and the grounded plan review found more. One sample: it needs more runs, including one
where the orchestrator got the scope wrong.

## Open

- **Planning holds no execution lock**, so two `feature` in the same checkout at once are still
  possible; `run_busy` covers only a live execution.
- **The Deck does not know a run is being driven from a terminal** ("Iniciar execução" offered while
  the CLI plans). Needs the lock holder in the run projection.
- **Discovery fingerprint includes validation commands**: editing the `test` command invalidates the
  map. Commands do not change what discovery reports.
- **A validation command that could not run (exit 125/126/127) is classified `validation_unsatisfied`**
  and spends a model attempt. It needs its own class — requires a person, consumes no attempt.
- **`revalidate` does not exist for a run without task isolation**, so a fixed environment still
  costs a `retry` to re-run validation.
- **Worktrees are prepared by hand.** Each hand-made worktree registers as a separate project in the
  hub, and the orchestrator installs dependencies, excludes `.agent-flow/`, measures the base and
  narrows gates that already fail there. Decided for now: the orchestrating model owns this (skill
  `agent-flow`); a per-project recipe comes after agent-flow itself is settled.
- **`--grounded` on a `simple` workflow confirms nothing.** Grounded skips discovery and
  relies on the impact stage to check the request's claims in code; a `simple` workflow has
  no impact stage and no SDD, so the claims reach the plan unchecked (measured: a UI bug
  classified `simple`, planning 2m38s + plan review 1m36s, and the request's open questions
  went unanswered). Grounded should keep the impact stage, or refuse to combine with `simple`.
- **Windows `.cmd` shims re-parse `|`**: a CLI installed as `name.cmd` (`"node" "x.mjs" %*`)
  splits the `--json-schema` pattern `^(FR|NFR|SEC)-…` on the pipe. The native `claude.exe` is
  not affected, the browser e2e world's fake CLI is, so those specs only run on Linux CI.
- **The dashboard builds its runners without the environment, on purpose** (§93: the local
  server reads no environment and names no credential file). So the Deck's model list ignores
  `CLAUDE_CONFIG_DIR` and cannot see an endpoint's key; the CLI honours both. A review flagged
  it as a bug and the fix broke two tests written for exactly this rule, so it was reverted.
  If the Deck needs it, the answer is a value the CLI passes at start, not `process.env`.
- **An endpoint now serves only planning and the plan review.** `verification` and
  `final-review` read the changed files, so they need a repository. Passing the diff itself as
  a prompt variable would let an endpoint review again, at the cost of the context it takes.
- **The Deck's replay still files a legacy `single_provider` event under "degradation"**; only
  the sentence was made neutral.
- **Remaining degradation reasons are English-only** (`parallelism_clamped`, `reasoning_clamped`,
  `read_only_uncontained`, fallback).

## Environment facts found on the way (not agent-flow)

- agent-browser 0.38.1 on Windows: the first command's daemon holds a pipe forever; `snapshot -c`
  drops text nodes.
- In Git Bash, a single-quoted `node -e '…'` with an apostrophe in its text ends the string early
  and the shell tries to run the rest as commands — write scripts to a file instead.
