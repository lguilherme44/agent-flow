import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { SystemClock } from '../adapters/clock/system-clock.js';
import { NodeProcessRunner } from '../adapters/process/node-process-runner.js';
import { NodeHost } from '../adapters/host/node-host.js';
import { createGitCommand } from '../adapters/git/git-command.js';
import { createGitWorkspaces } from '../adapters/git/git-workspaces.js';
import { StateStore } from '../app/state-store.js';
import { RunExecutionLock } from '../app/run-execution-lock.js';
import {
  cleanWorkspace,
  DEFAULT_RUNS_KEPT,
  type CleanupReport,
  type RunCleanup,
} from '../app/workspace-cleanup.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import type { GlobalOptions } from './index.js';

export interface CleanOptions {
  /** Keep the newest N runs. Default 5. */
  readonly keep?: string;
  /** Remove the active run too. */
  readonly force?: boolean;
  /** Also drop the cached repository map. */
  readonly cache?: boolean;
  /** §20.3: also reclaim the worktrees retention keeps by default. */
  readonly worktrees?: boolean;
  /** §20.3, §20.4: also delete an integration branch that is merged nowhere. */
  readonly branches?: boolean;
  /** Report what would happen and change nothing. */
  readonly dryRun?: boolean;
}

/**
 * `agent-flow clean` — drop old run state, and the Git namespace that goes with it.
 *
 * The active run is never removed without `--force`. Runs hold the SDD, the plan and the
 * approval that go with in-flight work, and a cleanup command that can silently delete the
 * thing you are working on is a command nobody runs.
 *
 * **Git before state, and the ordering is a data-loss rule rather than tidiness** (§20.1).
 * That ordering, the lock check and the choice of which runs are candidates all live in
 * `app/workspace-cleanup.ts` now — 7.7 gave the Deck a screen that has to show what *would*
 * be removed before removing it, and a preview computed by a second implementation is a
 * preview of a different operation.
 *
 * What is left here is the terminal: an order, a sentence per finding, and an exit code.
 */
export async function runCleanCommand(
  options: CleanOptions,
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  const fs = new NodeFileSystem();
  const host = new NodeHost();
  const clock = new SystemClock();

  try {
    const keep = Number.parseInt(options.keep ?? String(DEFAULT_RUNS_KEPT), 10);
    if (!Number.isFinite(keep) || keep < 0) {
      process.stderr.write('--keep expects a non-negative number.\n');
      return ExitCode.CONFIG_ERROR;
    }

    const git = await createGitCommand({
      processRunner: new NodeProcessRunner(),
      fs,
      homeDir: host.homeDir,
    });

    const report = await cleanWorkspace(
      {
        fs,
        host,
        workspaces: await createGitWorkspaces({ git, fs, homeDir: host.homeDir }),
        store: new StateStore({ fs, clock, projectDir: globals.cwd }),
        lock: new RunExecutionLock({ fs, clock, host, projectDir: globals.cwd }),
        projectDir: globals.cwd,
      },
      {
        keep,
        ...(options.force === undefined ? {} : { force: options.force }),
        ...(options.cache === undefined ? {} : { cache: options.cache }),
        ...(options.worktrees === undefined ? {} : { worktrees: options.worktrees }),
        ...(options.branches === undefined ? {} : { branches: options.branches }),
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      },
    );

    process.stdout.write(renderCleanup(report).join('\n'));

    // A retained integration branch is **not** a partial failure and does not affect the
    // exit code (§20.4). Only a namespace that could not be reclaimed, or a run somebody
    // is executing, does.
    return report.refused ? ExitCode.GATE_NOT_SATISFIED : ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

/**
 * What was reclaimed, and what was kept and why.
 *
 * The kept-branch line is the one §20.4 exists for: the CLI told the user the product of a
 * run is a branch and printed `git merge` as the thing to do with it, so a housekeeping
 * command that removed it weeks later with no word would be the tool taking back its own
 * promise.
 */
export function renderCleanup(report: CleanupReport): string[] {
  const lines: string[] = [];
  const would = report.dryRun ? 'would reclaim' : 'reclaimed';

  for (const run of report.runs) {
    if (run.outcome === 'locked') {
      lines.push(`  kept     ${run.runId} — it is being executed right now`);
      continue;
    }

    for (const line of reclaimLines(run, would)) lines.push(line);

    if (run.outcome === 'namespace_failed') {
      lines.push(`  kept     ${run.runId} — its namespace could not be reclaimed`);
      continue;
    }

    lines.push(`  ${report.dryRun ? 'would remove' : 'removed '} ${run.runId}`);
  }

  if (report.cacheRemoved) {
    lines.push(`  ${report.dryRun ? 'would remove' : 'removed '} cached repository map`);
  }

  // Named individually rather than counted, because the answer to "why is my disk full"
  // is which directories, and six of these were found only by listing the root by hand.
  for (const stray of report.strays) {
    lines.push(
      stray.removed || report.dryRun
        ? `  ${report.dryRun ? 'would remove' : 'removed '} ${stray.segment}`
        : `  kept     ${stray.segment}${stray.detail === undefined ? '' : ` — ${stray.detail}`}`,
    );
  }

  if (report.runs.length === 0 && !report.cacheRemoved && report.strays.length === 0) {
    lines.push(
      `Nothing to remove — ${String(report.totalRuns)} run(s), keeping ${String(report.keep)}.`,
    );
  }

  if (report.protectedRun !== undefined) {
    lines.push(
      '',
      `Kept ${report.protectedRun}: it is the active run. Use --force to remove it anyway.`,
    );
  }

  return [...lines, ''];
}

function reclaimLines(run: RunCleanup, would: string): string[] {
  if (run.outcome === 'locked') return [];
  const { reclaim } = run;
  const lines: string[] = [];

  if (reclaim.worktrees.length > 0) {
    lines.push(`  ${would} ${String(reclaim.worktrees.length)} worktree(s) of ${run.runId}`);
  }
  if (reclaim.worktreesRetained.length > 0) {
    lines.push(
      `  kept     ${String(reclaim.worktreesRetained.length)} worktree(s) of ${run.runId} — ` +
        'they are the only copy of what their agent produced (--worktrees reclaims them)',
    );
  }
  if (reclaim.attemptRefs.length > 0) {
    lines.push(`  ${would} ${String(reclaim.attemptRefs.length)} attempt ref(s) of ${run.runId}`);
  }

  const branch = reclaim.integrationBranch;
  switch (branch.kind) {
    case 'redundant':
      lines.push(`  ${would} ${branch.ref} — already merged into ${branch.mergedInto}`);
      break;
    case 'forced':
      lines.push(`  ${would} ${branch.ref} — asked for with --branches`);
      break;
    case 'kept':
      lines.push(
        `  kept     ${branch.ref} — not merged anywhere`,
        `           git log --oneline ${branch.head.slice(0, 7)}`,
        '           delete it with: agent-flow clean --branches   (or git branch -D)',
      );
      break;
    case 'absent':
      break;
  }

  for (const failure of reclaim.failures) lines.push(`  failed   ${failure}`);

  return lines;
}
