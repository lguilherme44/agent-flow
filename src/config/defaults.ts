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
  # MVP 1 runs one task at a time. The scheduler is already written for N;
  # raising this needs worktrees so parallel tasks cannot collide.
  maxTasks: 1

retry:
  maxAttempts: 2

git:
  useWorktrees: false

approval:
  requiredBeforeImplementation: true
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
