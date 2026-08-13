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

/** Artifacts a stage can produce. Keys, not paths, so callers never build strings. */
export type ArtifactName =
  | 'request'
  | 'architectureImpact'
  | 'sdd'
  | 'plan'
  | 'planReview'
  | 'verification'
  | 'finalReview';

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
  log(name: string): string;
}

export function runPaths(projectDir: string, runId: string): RunPaths {
  const dir = `${agentFlowPaths(projectDir).runsDir}/${runId}`;
  const reviewsDir = `${dir}/reviews`;
  const tasksDir = `${dir}/tasks`;
  const logsDir = `${dir}/logs`;

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
    taskResult: (taskId) => `${tasksDir}/${taskId}/result.json`,
    taskAttempt: (taskId, attempt) => `${tasksDir}/${taskId}/attempt-${String(attempt)}.json`,
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
