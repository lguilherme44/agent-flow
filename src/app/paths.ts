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
    log: (name) => `${logsDir}/${name}.log`,
  };
}

export function artifactPath(
  projectDir: string,
  runId: string,
  artifact: ArtifactName,
): string {
  return runPaths(projectDir, runId)[artifact];
}
