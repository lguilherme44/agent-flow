/**
 * One line per unit of work, at the start and at the end of it.
 *
 * Shared by `feature` (stages) and `run` (tasks), because they had the same
 * defect and it was fixed twice in the same shape. Both announced only on
 * completion, and both hid the start line behind `--verbose`.
 *
 * The cost was measured, not supposed. `discovery` ran for 4m08s printing
 * nothing until it was over; a task later spent 45 minutes the same way before
 * timing out. In that window there is no way to tell slow work from a dead
 * process, and that is the state an operator is least able to wait out.
 *
 * On a TTY the finished line overwrites the started one, so the list grows by one
 * row per unit rather than two. Piped or redirected — a log file, CI, `nohup` —
 * `\r` means nothing, so both lines are written and the log reads as a timeline,
 * which is what a log is for.
 */

/** How a unit ended, in the vocabulary both callers already use. */
export type ProgressStatus = 'started' | 'completed' | 'cached' | 'stale' | 'failed' | string;

function interactive(): boolean {
  return process.stdout.isTTY === true;
}

/**
 * When each announced unit started, so its finish can say how long it took.
 *
 * Keyed by label because units overlap: with `parallelism.maxTasks` above one, several
 * tasks are open at once and a single timestamp would attribute one task's duration to
 * whichever finished first.
 *
 * Cleared on finish. A label that is never finished leaks one number, which is the right
 * trade against a module that would otherwise need a lifecycle.
 */
const startedAt = new Map<string, number>();

/**
 * A duration a person reads at a glance, not a number they convert.
 *
 * Seconds under a minute, `m` and `s` above it. Nothing shorter than a second is worth
 * printing here: the unit being timed is a model call.
 */
export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  if (total < 60) return `${String(total)}s`;
  const minutes = Math.floor(total / 60);
  return `${String(minutes)}m${String(total % 60).padStart(2, '0')}s`;
}

/** How long this label has been open, and forgets it. Absent when nothing announced it. */
function elapsedFor(label: string): string {
  const started = startedAt.get(label);
  if (started === undefined) return '';
  startedAt.delete(label);
  return `  ${formatElapsed(Date.now() - started)}`;
}

/**
 * Writes one progress line.
 *
 * `label` is the stage or task id. `verbose` only widens what is shown — it never
 * decides *whether* the start is announced, which was the defect.
 */
export function writeProgress(label: string, status: ProgressStatus, verbose = false): void {
  // `stale` is a note about the cache, not a second start. Discovery emits
  // `started` and then `stale` when the fingerprint no longer matches, and
  // rendering both printed `→ discovery` twice above a single `✓ discovery` —
  // measured on a real run. The unit is already announced; that it is running
  // because the cache expired is detail, and detail is what `--verbose` is for.
  if (status === 'stale') {
    if (verbose) process.stdout.write(`  · ${label} (cache stale, re-running)\n`);
    return;
  }

  if (status === 'started') {
    startedAt.set(label, Date.now());
    process.stdout.write(`  → ${label}${interactive() ? '' : '\n'}`);
    return;
  }

  // A second planner call is news a person must not mistake for the first. The checks
  // refused the plan and the pipeline is asking again with the problems attached; said
  // on its own line, so the terminal reads as what happened rather than as a stall.
  if (status === 'repairing') {
    const prefix = interactive() && !verbose ? '\r' : '';
    process.stdout.write(`${prefix}  ↻ ${label} (the checks refused the plan; asking the planner to fix it)\n`);
    return;
  }

  const mark = status === 'completed' ? '✓' : status === 'cached' ? '·' : status === 'failed' ? '✗' : '→';
  const suffix = status === 'cached' ? ' (cached)' : '';

  // `\r` returns to the start of the line and the pad covers the longest label
  // plus its marker, so a shorter line cannot leave the tail of a longer one
  // behind it.
  const prefix = interactive() && !verbose ? '\r' : '';
  // The duration lands after the pad, so a column of them lines up regardless of label
  // length. A stage that took two minutes and one that hung look identical without it —
  // measured on a live run where `discovery` printed `→` and then `✓`, 116 seconds apart,
  // with nothing in between and no number on either line.
  process.stdout.write(`${prefix}  ${mark} ${label}${suffix}`.padEnd(34) + elapsedFor(label) + '\n');
}

/**
 * The same line, with the outcome spelled out beside the mark.
 *
 * `run` has always printed `✓ TASK-001 (completed)`, and that parenthesis carries
 * information the mark alone does not — `blocked` and `review_required` are
 * neither success nor failure.
 */
export function writeTaskOutcome(taskId: string, status: string, verbose = false): void {
  const mark = status === 'completed' ? '✓' : '✗';
  const prefix = interactive() && !verbose ? '\r' : '';
  process.stdout.write(`${prefix}  ${mark} ${taskId} (${status})`.padEnd(40) + elapsedFor(taskId) + '\n');
}
