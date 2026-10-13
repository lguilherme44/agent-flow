import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { SystemClock } from '../adapters/clock/system-clock.js';
import { StateStore } from '../app/state-store.js';
import { loadRunTimeline } from '../app/run-timeline.js';
import { loadConfig } from '../config/loader.js';
import { en } from '../core/phrases/index.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import { renderTimeline } from './render/timeline.js';
import type { GlobalOptions } from './index.js';

/**
 * `agent-flow timeline [runId]` — where did this run's wall clock go?
 *
 * The current run when none is named, like `status`. The numbers are the same fold the
 * Deck draws, read through the same loader; `--json` prints that fold as it is, and a
 * refusal as an object with an `error` code, so a script never has to parse prose.
 */
export async function runTimelineCommand(
  runId: string | undefined,
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  const fs = new NodeFileSystem();
  const clock = new SystemClock();
  const store = new StateStore({ fs, clock, projectDir: globals.cwd });
  const json = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

  try {
    const target = runId ?? (await store.currentRunId());
    if (target === null) {
      if (globals.json) json({ error: 'no_active_run', message: en.timeline.noActiveRun });
      else process.stdout.write(`${en.timeline.noActiveRun}\n`);
      return ExitCode.OK;
    }

    // The configuration only decides whether a silent run is stale; one that will not load
    // means no verdict, never a failed command.
    const config = () =>
      loadConfig({ fs, globalConfigPath: globals.globalConfigPath, projectDir: globals.cwd }).catch(
        () => undefined,
      );

    const timeline = await loadRunTimeline(store, target, clock.now(), config);
    if (timeline === null) {
      if (globals.json) json({ error: 'no_such_run', message: en.actions.noSuchRun(target) });
      else process.stderr.write(`${en.actions.noSuchRun(target)}\n`);
      return ExitCode.EXECUTION_ERROR;
    }

    if (globals.json) json(timeline);
    else process.stdout.write(`${renderTimeline(timeline, target).join('\n')}\n`);
    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}
