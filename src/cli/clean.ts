import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { SystemClock } from '../adapters/clock/system-clock.js';
import { StateStore } from '../app/state-store.js';
import { agentFlowPaths } from '../app/paths.js';
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
}

/**
 * `agent-flow clean` — drop old run state.
 *
 * The active run is never removed without `--force`. Runs hold the SDD, the
 * plan and the approval that go with in-flight work, and a cleanup command that
 * can silently delete the thing you are working on is a command nobody runs.
 */
export async function runCleanCommand(
  options: CleanOptions,
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  const fs = new NodeFileSystem();
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

    for (const id of removable) {
      await fs.remove(`${paths.runsDir}/${id}`);
      process.stdout.write(`  removed  ${id}\n`);
    }

    if (options.cache === true && (await fs.exists(paths.architectureCache))) {
      await fs.remove(paths.architectureCache);
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

    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}
