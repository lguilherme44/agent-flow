/**
 * Shipped defaults.
 *
 * Two decisions worth naming:
 *
 *   - Only one runner is enabled out of the box. The alpha checkpoint has to
 *     work on a machine that has never installed a second CLI (C-4), and a
 *     default that references a missing runner would make `doctor` shout on a
 *     perfectly healthy setup.
 *   - No `model:` anywhere. Pinned model names rot (AD-13); leaving them out
 *     means each CLI applies whatever the user already configured for it.
 *
 * Cross-provider review is therefore *not* on by default — enabling the second
 * runner is what turns it on, and `doctor` reports the single-provider state as
 * DEGRADED so the loss is never silent (R-16).
 */
export const DEFAULT_GLOBAL_CONFIG_YAML = `# agent-flow global configuration
# Roles are logical. Runners, models and reasoning levels are resolved here, so
# swapping a provider never touches a prompt or the orchestrator itself.
version: 1

runners:
  claude:
    type: claude-code-cli
    enabled: true

  # Enable once the Codex CLI is installed and authenticated. With two healthy
  # runners, plan review and final review become genuinely cross-provider.
  codex:
    type: codex-cli
    enabled: false

  # An OpenAI-compatible inference endpoint — a local llama.cpp or vLLM server,
  # or any hosted one. **Not a coding agent**: it has no working directory and
  # cannot write, and it declares both, so \`agent-flow doctor\` will refuse it for
  # \`discovery\` and the executors and accept it everywhere else.
  #
  # That "everywhere else" is most of the workflow. Nine of the eleven shipped
  # prompts carry their whole input — sdd, planning, both reviews, verification,
  # final-review, architecture-impact — so pointing them at a local model costs
  # no quota and makes the two review stages genuinely independent of whichever
  # provider wrote the code.
  #
  # \`apiKeyEnv\` names an environment variable, never the key itself (§7.1).
  #
  #   local:
  #     type: openai-compatible
  #     enabled: true
  #     baseUrl: http://127.0.0.1:8080/v1
  #     apiKeyEnv: LOCAL_LLM_API_KEY
  #     model: moe
  #
  # …then point the stages that read nothing at it:
  #
  #   roles:
  #     planReviewer:
  #       runner: local
  #       effort: high

roles:
  # Discovery reads the repository; it does not need the deepest setting.
  architect:
    runner: claude
    effort: high

  sdd:
    runner: claude
    effort: high

  planner:
    runner: claude
    effort: high

  planReviewer:
    runner: claude
    effort: high

  executors:
    trivial:
      runner: claude
      effort: low
    normal:
      runner: claude
      effort: medium
    complex:
      runner: claude
      effort: high

  verification:
    runner: claude
    effort: medium

  finalReviewer:
    runner: claude
    effort: very_high

# Fallback is infrastructure, never a fix for poor output. The schema refuses
# any trigger beyond these three.
fallback:
  enabled: true
  on:
    - quota_exceeded
    - auth_required
    - runner_unavailable

parallelism:
  # How many tasks may run at once — a request, not a guarantee. What it is
  # worth depends entirely on \`git.useWorktrees\` below: with worktrees off,
  # tasks share one working tree, so this is capped at 1 at runtime and asking
  # for more only produces a degradation. With worktrees on, each task gets its
  # own checkout and this is honoured up to a ceiling of 8.
  # \`agent-flow run --dry-run\` prints the requested and the effective number.
  maxTasks: 1

retry:
  # Work attempts per task. An attempt is one agent invocation whose work was
  # observed and judged — a preflight or environment fault does not spend one.
  maxAttempts: 2

recovery:
  # Bounds on autonomous recovery. Every budget here ends its loop when exhausted,
  # and says which one ran out, what was tried, and the one action that clears it.
  #
  # On. A recoverable failure — a validation command that did not pass, a runner
  # that timed out — is requeued with a Failure Context Packet naming the failing
  # command, its exit code and its output, and the run carries on.
  #
  # What makes that safe is the bounds rather than the switch: a class the
  # taxonomy marks requires_human is never retried however much budget is left,
  # maxIdenticalFailures stops a loop that keeps producing one failure, and
  # every exhausted budget names one specific human action.
  #
  # Set it to false to get the previous behaviour exactly: the run stops on the
  # first failure and waits for you.
  enabled: true

  # Per task.
  maxEnvironmentRepairs: 2
  # An automatic loop that produces the same failure twice has learned nothing.
  maxIdenticalFailures: 2
  maxModelCallsPerTask: 4

  # Per run.
  maxCorrectiveRounds: 2
  maxCorrectivePlanRepairs: 2
  maxVerificationCycles: 3
  # The global stop: agent calls made with no human action in between.
  maxAutonomousModelCalls: 24

  # How much recovery context may be added to a prompt, in bytes. Recovery context
  # lands on a prompt that is already large, so a packet carries a diff *stat* and
  # never a patch, and anything cut is marked rather than dropped quietly.
  maxPacketBytes: 8192
  maxRawExcerptBytes: 2048
  maxDiffStatLines: 40

git:
  # Task isolation: each attempt runs in its own Git worktree on its own branch,
  # and its work reaches the run's integration branch only after validation
  # passes. That is what makes \`parallelism.maxTasks\` above mean anything.
  #
  # Off by default because it is not free: a worktree per task costs disk and one
  # dependency install each, and the repository has to satisfy preconditions the
  # sequential path never asks about — a clean working tree at the moment the
  # plan is approved, first among them. Run \`agent-flow doctor\` before turning
  # it on; it reports whether this repository qualifies.
  #
  # A run captures this value when it is created and never re-reads it, so
  # editing it changes the next run, never one already in flight.
  useWorktrees: false

approval:
  requiredBeforeImplementation: true

ui:
  # How far under a workspace root \`agent-flow ui ~/wk\` looks for projects.
  # Bounded on purpose: an unbounded scan of a home directory reads places
  # nobody asked it to, and takes minutes before the first page renders.
  workspaceDepth: 2

# Optional local model that *advisory* context comes from (§18). Disabled by
# default: the workflow behaves exactly as before MVP3. When enabled, repository
# retrieval feeds an advisory block into the primary runner's prompt — never
# workflow truth. \`apiKeyEnv\` names an environment variable (for example
# AGENT_FLOW_UTILITY_MODEL_API_KEY); the resolved value is never persisted.
utilityModel:
  enabled: false
  adapter: openai-compatible
  contextWindow: 64000
  targetInputTokens: 40000
  maxOutputTokens: 4000
  timeoutSeconds: 120
`;

export const DEFAULT_PROJECT_CONFIG_YAML = `# agent-flow project configuration
# Only what differs from the global setup belongs here.
project:
  name: CHANGE_ME
  type: unknown

# Run by agent-flow itself, never by an agent: a read-only sandbox cannot run a
# test suite, and a failing build should not cost an LLM call to discover.
commands:
  install: ""
  lint: ""
  typecheck: ""
  test: ""
  build: ""

paths:
  source: []
  tests: []

rules:
  architecture: []
`;
