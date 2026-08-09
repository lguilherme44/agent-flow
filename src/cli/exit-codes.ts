/**
 * Exit codes, so scripts and CI can distinguish causes without parsing output.
 *
 * The split that matters is CONFIG versus EXECUTION: a broken configuration is
 * the user's to fix and is worth failing fast on, while an execution failure may
 * be transient. DEGRADED is deliberately not an error by default — a usable
 * environment should not fail a script — but `--strict` turns it into one for
 * pipelines that want to insist on a fully healthy setup.
 */
export const ExitCode = {
  OK: 0,
  EXECUTION_ERROR: 1,
  CONFIG_ERROR: 2,
  GATE_NOT_SATISFIED: 3,
  DEGRADED_STRICT: 4,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
