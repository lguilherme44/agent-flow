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
    process.stdout.write(`  → ${label}${interactive() ? '' : '\n'}`);
    return;
  }

  const mark = status === 'completed' ? '✓' : status === 'cached' ? '·' : status === 'failed' ? '✗' : '→';
  const suffix = status === 'cached' ? ' (cached)' : '';

  // `\r` returns to the start of the line and the pad covers the longest label
  // plus its marker, so a shorter line cannot leave the tail of a longer one
  // behind it.
  const prefix = interactive() && !verbose ? '\r' : '';
  process.stdout.write(`${prefix}  ${mark} ${label}${suffix}`.padEnd(34) + '\n');
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
  process.stdout.write(`${prefix}  ${mark} ${taskId} (${status})`.padEnd(40) + '\n');
}
