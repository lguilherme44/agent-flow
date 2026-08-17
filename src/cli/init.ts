import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { SystemClock } from '../adapters/clock/system-clock.js';
import { findActiveRun, initProject, projectRelativePaths } from '../app/init-project.js';
import { StateStore } from '../app/state-store.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import type { GlobalOptions } from './index.js';

/** `agent-flow init` — prepare a repository. Never clobbers anything (§7.7). */
export async function runInitCommand(
  options: { force?: boolean },
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  const fs = new NodeFileSystem();

  try {
    const store = new StateStore({ fs, clock: new SystemClock(), projectDir: globals.cwd });

    // AR-01, C-02. Before `initProject`, because "it writes nothing" is half the contract
    // and a gate that runs after the write is not a gate.
    const active = await findActiveRun(store);

    if (active !== undefined && options.force !== true) {
      process.stderr.write(
        [
          `Run ${active.runId} is still active (${active.status}).`,
          '',
          `  planningBase  ${active.planningBase ?? '(none recorded)'}`,
          '',
          'init writes files that have to be committed, and that commit moves HEAD.',
          "A run's planningBase is frozen when the run is created, so committing now",
          'would leave this run planning against one base and executing against another.',
          '',
          'Finish or abandon the run first, or re-run with --force to proceed anyway',
          '(recorded on the run).',
          '',
        ].join('\n'),
      );
      return ExitCode.GATE_NOT_SATISFIED;
    }

    const result = await initProject({
      fs,
      projectDir: globals.cwd,
      ...(options.force === undefined ? {} : { force: options.force }),
    });

    // After the write rather than before it: the event says what happened, and an event
    // recording an override that then failed would be a lie the audit trail keeps.
    if (active !== undefined) {
      await store.appendEvent(active.runId, 'init_during_active_run', {
        forced: true,
        status: active.status,
        ...(active.planningBase === undefined ? {} : { planningBase: active.planningBase }),
        // Project-relative, never absolute (§21.3). What matters afterwards is which files
        // moved under this run, not where this machine keeps its home directory.
        created: projectRelativePaths(globals.cwd, result.created),
        updated: projectRelativePaths(globals.cwd, result.updated),
      });
    }

    const lines: string[] = [
      `Detected: ${result.stack.type} (${result.stack.name})`,
      '',
    ];

    for (const path of result.created) lines.push(`  created  ${path}`);
    for (const path of result.updated) lines.push(`  updated  ${path}`);
    for (const path of result.skipped) lines.push(`  kept     ${path} (already exists)`);

    if (result.skipped.length > 0) {
      lines.push('', 'Nothing existing was overwritten. Use --force to replace it.');
    }

    const commands = Object.entries(result.stack.commands).filter(([, value]) => value);
    if (commands.length === 0) {
      lines.push(
        '',
        'No validation commands were detected. Add them to .agent-flow/config.yaml —',
        'agent-flow runs them itself, so an invented command fails for the wrong reason.',
      );
    }

    if (active !== undefined) {
      lines.push(
        '',
        `Warning: run ${active.runId} is active and its planningBase may no longer`,
        'match HEAD once you commit these files. This was recorded on the run.',
      );
    }

    // Said here because the alternative is discovering it at review time: these
    // files are in the working tree from now on, and an uncommitted AGENTS.md
    // turns up inside the first feature's diff looking like part of it.
    lines.push(
      '',
      'Commit what was just written before starting a feature — otherwise it',
      'lands in the first diff the reviewer sees, as though the feature did it.',
      '',
      'Next: agent-flow doctor',
      '',
    );
    process.stdout.write(lines.join('\n'));

    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}
