import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { SystemClock } from '../adapters/clock/system-clock.js';
import { NodeProcessRunner } from '../adapters/process/node-process-runner.js';
import { NodeHost } from '../adapters/host/node-host.js';
import { createGitCommand } from '../adapters/git/git-command.js';
import { createGitWorkspaces } from '../adapters/git/git-workspaces.js';
import { StateStore } from '../app/state-store.js';
import { RunExecutionLock } from '../app/run-execution-lock.js';
import { agentFlowPaths } from '../app/paths.js';
import { reclaimNamespace, type ReclaimOutcome } from '../app/namespace-reclaim.js';
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
 * The active run is never removed without `--force`. Runs hold the SDD, the
 * plan and the approval that go with in-flight work, and a cleanup command that
 * can silently delete the thing you are working on is a command nobody runs.
 *
 * **Git before state, and the ordering is a data-loss rule rather than tidiness**
 * (§20.1). Removing a run's state without removing its worktrees and refs would
 * leave registered worktrees and branches with nothing to attribute them to; doing
 * it the other way round means a run whose namespace could not be reclaimed keeps
 * the state that explains what is still on disk. So the state directory goes last,
 * and only when the Git half succeeded.
 *
 * This file is an **adapter**: it decides which runs are candidates, prints, and
 * chooses an exit code. What may be deleted is `app/namespace-reclaim.ts`'s, for
 * the reason M2-06 moved `review` out of the CLI — the rules that decide whether a
 * branch is the only copy of a feature are not rules a terminal should own.
 */
export async function runCleanCommand(
  options: CleanOptions,
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  const fs = new NodeFileSystem();
  const host = new NodeHost();
  const store = new StateStore({ fs, clock: new SystemClock(), projectDir: globals.cwd });

  try {
    const keep = Number.parseInt(options.keep ?? '5', 10);
    if (!Number.isFinite(keep) || keep < 0) {
      process.stderr.write('--keep expects a non-negative number.\n');
      return ExitCode.CONFIG_ERROR;
    }

    const runIds = await store.listRunIds();
    const current = await store.currentRunId();

    // listRunIds is newest first, so everything past `keep` is old.
    const candidates = runIds.slice(keep);
    const removable = candidates.filter((id) => id !== current || options.force === true);
    const protectedRun = candidates.find((id) => id === current && options.force !== true);

    const paths = agentFlowPaths(globals.cwd);
    const git = await createGitCommand({ processRunner: new NodeProcessRunner(), fs, homeDir: host.homeDir });
    const workspaces = await createGitWorkspaces({ git, fs, homeDir: host.homeDir });
    const lock = new RunExecutionLock({ fs, clock: new SystemClock(), host, projectDir: globals.cwd });

    let refused = false;

    for (const id of removable) {
      // §20.2: a run whose execution lock is held is refused. Inspected rather than
      // acquired — taking the lease to decide whether to delete a run would make
      // `clean` an operation that competes with the scheduler, and the honest answer
      // here is "somebody is working on this one".
      const held = await lock.describe(id);
      if (held !== undefined) {
        process.stdout.write(`  kept     ${id} — it is being executed right now\n`);
        refused = true;
        continue;
      }

      const outcome = await reclaimNamespace(
        { workspaces, fs, host, projectDir: globals.cwd, store },
        id,
        {
          ...(options.dryRun === true ? { dryRun: true } : {}),
          ...(options.worktrees === true ? { worktrees: true } : {}),
          ...(options.branches === true ? { branches: true } : {}),
        },
      );

      report(outcome, options.dryRun === true);

      if (!outcome.stateRemovable) {
        // §20.1: step 5 must not run. The state is what explains the worktrees and
        // refs still on disk, so it stays until they are gone.
        process.stdout.write(`  kept     ${id} — its namespace could not be reclaimed\n`);
        refused = true;
        continue;
      }

      if (options.dryRun !== true) await fs.remove(`${paths.runsDir}/${id}`);
      process.stdout.write(`  ${options.dryRun === true ? 'would remove' : 'removed '} ${id}\n`);
    }

    if (options.cache === true && (await fs.exists(paths.architectureCache))) {
      if (options.dryRun !== true) await fs.remove(paths.architectureCache);
      process.stdout.write('  removed  cached repository map\n');
    }

    if (removable.length === 0 && options.cache !== true) {
      process.stdout.write(`Nothing to remove — ${String(runIds.length)} run(s), keeping ${String(keep)}.\n`);
    }

    if (protectedRun !== undefined) {
      process.stdout.write(
        `\nKept ${protectedRun}: it is the active run. Use --force to remove it anyway.\n`,
      );
    }

    // A retained integration branch is **not** a partial failure and does not
    // affect the exit code (§20.4). Only a namespace that could not be reclaimed,
    // or a run somebody is executing, does.
    return refused ? ExitCode.GATE_NOT_SATISFIED : ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

/**
 * What was reclaimed, and what was kept and why.
 *
 * The kept-branch line is the one §20.4 exists for: the CLI told the user the
 * product of a run is a branch and printed `git merge` as the thing to do with it,
 * so a housekeeping command that removed it weeks later with no word would be the
 * tool taking back its own promise.
 */
function report(outcome: ReclaimOutcome, dryRun: boolean): void {
  const would = dryRun ? 'would reclaim' : 'reclaimed';

  if (outcome.worktrees.length > 0) {
    process.stdout.write(
      `  ${would} ${String(outcome.worktrees.length)} worktree(s) of ${outcome.runId}\n`,
    );
  }
  if (outcome.worktreesRetained.length > 0) {
    process.stdout.write(
      `  kept     ${String(outcome.worktreesRetained.length)} worktree(s) of ${outcome.runId} — ` +
        'they are the only copy of what their agent produced (--worktrees reclaims them)\n',
    );
  }
  if (outcome.attemptRefs.length > 0) {
    process.stdout.write(
      `  ${would} ${String(outcome.attemptRefs.length)} attempt ref(s) of ${outcome.runId}\n`,
    );
  }

  const branch = outcome.integrationBranch;
  switch (branch.kind) {
    case 'redundant':
      process.stdout.write(
        `  ${would} ${branch.ref} — already merged into ${branch.mergedInto}\n`,
      );
      break;
    case 'forced':
      process.stdout.write(`  ${would} ${branch.ref} — asked for with --branches\n`);
      break;
    case 'kept':
      process.stdout.write(
        `  kept     ${branch.ref} — not merged anywhere\n` +
          `           git log --oneline ${branch.head.slice(0, 7)}\n` +
          '           delete it with: agent-flow clean --branches   (or git branch -D)\n',
      );
      break;
    case 'absent':
      break;
  }

  for (const failure of outcome.failures) process.stdout.write(`  failed   ${failure}\n`);
}
