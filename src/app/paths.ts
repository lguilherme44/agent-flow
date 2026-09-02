/**
 * Every path agent-flow writes inside a project, in one place.
 *
 * The layout differs from §5 of the spec on purpose (R-01). The spec puts
 * `sdd.md`, `plan.json` and `state.json` at the root of `.agent-flow/` while
 * also giving each run its own folder — start a second feature before finishing
 * the first and the second silently overwrites the first's artifacts.
 *
 * So: nothing with content lives at the root. The root holds configuration, a
 * pointer to the active run, and a cache whose whole purpose is being shared.
 */

import type { ArtifactName } from '../contracts/common.schema.js';

export interface AgentFlowPaths {
  readonly root: string;
  readonly config: string;
  readonly currentRun: string;
  readonly cacheDir: string;
  /** Discovery output is feature-agnostic, so it is reused across runs (R-07). */
  readonly architectureCache: string;
  readonly runsDir: string;
}

export function agentFlowPaths(projectDir: string): AgentFlowPaths {
  const root = `${projectDir}/.agent-flow`;
  return {
    root,
    config: `${root}/config.yaml`,
    currentRun: `${root}/current-run`,
    cacheDir: `${root}/cache`,
    architectureCache: `${root}/cache/architecture.md`,
    runsDir: `${root}/runs`,
  };
}

/**
 * Artifacts a stage can produce. Keys, not paths, so callers never build strings.
 *
 * The *list* moved to `contracts/common.schema.ts` and is re-exported here unchanged, so
 * every existing `import type { ArtifactName } from './paths.js'` still resolves. The
 * reason for the move is that the names are a closed vocabulary a message or a plan may
 * reference, and a validator in the contracts layer must not import the layer that knows
 * where files live. What stays here is the only thing that was ever specific to this
 * module: the mapping from a name to a path.
 */
export type { ArtifactName };

export interface RunPaths {
  readonly dir: string;
  readonly state: string;
  readonly events: string;
  readonly request: string;
  readonly architectureImpact: string;
  readonly sdd: string;
  readonly plan: string;
  readonly reviewsDir: string;
  readonly planReview: string;
  readonly verification: string;
  readonly finalReview: string;
  readonly tasksDir: string;
  readonly logsDir: string;
  /**
   * Where the run's collaboration logs live (M4).
   *
   * Inside the run's artifacts, and therefore outside every worktree, for exactly the
   * reason the attempt artifacts are: `.agent-flow/runs/` is in the project directory and
   * is gitignored, so it is not part of any checkout an agent receives. An agent can write
   * a message; it cannot rewrite the log of what it wrote.
   */
  readonly collaborationDir: string;
  /** Append-only, one `AgentMessage` per line. */
  readonly messages: string;
  /** Append-only, one `BlackboardEntry` per line. */
  readonly blackboard: string;
  taskResult(taskId: string): string;
  /**
   * `tasks/<taskId>/attempt-<n>.json` — one attempt's evidence (MVP 2 §10.1).
   *
   * A sibling of `result.json` rather than a replacement for it, because the two
   * say different things: this records what one local execution did and what its
   * validation found, and `result.json` records the task's outcome. Attempt-scoped
   * because an attempt is immutable once written (§11.3) — a second attempt is a
   * second file, never a rewrite of the first.
   *
   * **Inside the run's artifacts, and therefore outside every worktree** (§11.2).
   * `.agent-flow/runs/` lives in the project directory and is gitignored, so it is
   * not part of any checkout an agent receives.
   */
  taskAttempt(taskId: string, attempt: number): string;
  /**
   * `tasks/<taskId>/attempt-<n>.failed.json` — why one attempt failed (AD-34).
   *
   * **A distinct file name, and that is the point.** MVP 2 §17.3 reads "no
   * `attempt-<n>.json`" as *the attempt's work was never observed*, and the recovery
   * windows depend on that being literally true. Writing the failure under the same name
   * with a null report would break it; writing nothing at all is what left the evidence
   * run's two failed attempts as the only ones with no persisted record — precisely the
   * two somebody needed to diagnose.
   */
  failedAttempt(taskId: string, attempt: number): string;
  /**
   * `tasks/<taskId>/attempt-<n>.context.json` — what attempt *n* was told (AD-40, §8.5).
   *
   * Persisted beside the attempt it informs, so a run can always show what a retry was
   * given. Without it "why did the second attempt do that" is answerable only by
   * re-deriving a packet from artifacts that may since have changed.
   */
  attemptContext(taskId: string, attempt: number): string;
  log(name: string): string;
}

export function runPaths(projectDir: string, runId: string): RunPaths {
  const dir = `${agentFlowPaths(projectDir).runsDir}/${runId}`;
  const reviewsDir = `${dir}/reviews`;
  const tasksDir = `${dir}/tasks`;
  const logsDir = `${dir}/logs`;
  const collaborationDir = `${dir}/collaboration`;

  return {
    dir,
    state: `${dir}/state.json`,
    events: `${dir}/events.jsonl`,
    request: `${dir}/request.md`,
    architectureImpact: `${dir}/architecture-impact.md`,
    sdd: `${dir}/sdd.md`,
    plan: `${dir}/plan.json`,
    reviewsDir,
    planReview: `${reviewsDir}/plan-review.json`,
    verification: `${reviewsDir}/verification.json`,
    finalReview: `${reviewsDir}/final-review.json`,
    tasksDir,
    logsDir,
    collaborationDir,
    messages: `${collaborationDir}/messages.jsonl`,
    blackboard: `${collaborationDir}/blackboard.jsonl`,
    taskResult: (taskId) => `${tasksDir}/${taskId}/result.json`,
    taskAttempt: (taskId, attempt) => `${tasksDir}/${taskId}/attempt-${String(attempt)}.json`,
    failedAttempt: (taskId, attempt) =>
      `${tasksDir}/${taskId}/attempt-${String(attempt)}.failed.json`,
    attemptContext: (taskId, attempt) =>
      `${tasksDir}/${taskId}/attempt-${String(attempt)}.context.json`,
    log: (name) => `${logsDir}/${name}.log`,
  };
}

/**
 * The log name for one implementation attempt (MVP 2, M2-05).
 *
 * `implementation-<taskId>` was already per task, which fixed the defect where a
 * run of nine tasks kept one log. Per *attempt* is the same defect one level
 * down: a retry runs the same task again, and without the suffix the second
 * attempt's log would overwrite the first — deleting the record of exactly the
 * attempt somebody is retrying because they want to read it.
 *
 * A name rather than a path, because `StageRunner` takes `logName` and resolves
 * it through {@link RunPaths.log}. Composed here so the shape has one home.
 */
export function attemptLogName(taskId: string, attempt: number): string {
  return `implementation-${taskId}-attempt-${String(attempt)}`;
}

export function artifactPath(
  projectDir: string,
  runId: string,
  artifact: ArtifactName,
): string {
  return runPaths(projectDir, runId)[artifact];
}

/**
 * The file an agent leaves in its workspace to say something (M4-02).
 *
 * A fixed name rather than a per-attempt one, and inside the workspace rather than beside
 * it, because the agent runs in a sandbox whose only writable root *is* the workspace —
 * there is nowhere else to put it that the agent could reach.
 *
 * What makes that safe is when it is read, not where it lives: the harvest runs after the
 * agent's process exits and **before** the validated tree is captured, and it removes the
 * file in that window (I-32). So an outbox never reaches `git add -A`, never enters a
 * tree, never appears in a marker, a diff or `filesChanged` — and in sequential mode it
 * never appears in the operator's own `git status` either.
 *
 * Leading dot so it sorts and reads as machinery. Composed here rather than at the call
 * site so there is one spelling of it; an architecture test pins that.
 */
export const AGENT_OUTBOX_FILENAME = '.agent-flow-outbox.json';

export function agentOutboxPath(workspaceDir: string): string {
  return `${workspaceDir}/${AGENT_OUTBOX_FILENAME}`;
}
