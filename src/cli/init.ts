import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { SystemClock } from '../adapters/clock/system-clock.js';
import { registerProject } from '../app/init-project.js';
import { StateStore } from '../app/state-store.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import type { GlobalOptions } from './index.js';

/**
 * `agent-flow init` — prepare a repository. Never clobbers anything (§7.7).
 *
 * The judgements moved to `app/init-project.ts` when the Deck grew a way to register a
 * project (7.6): a warning that existed only as a line printed here would have been
 * missing from the browser, on the one surface where a person cannot see the command that
 * was chosen for them.
 */
export async function runInitCommand(
  options: { force?: boolean },
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  const fs = new NodeFileSystem();

  try {
    const store = new StateStore({ fs, clock: new SystemClock(), projectDir: globals.cwd });

    const outcome = await registerProject({
      store,
      fs,
      projectDir: globals.cwd,
      ...(options.force === undefined ? {} : { force: options.force }),
    });

    if (!outcome.ok) {
      const active = outcome.active;
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

    const { result, active } = outcome;

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

    // The findings `initProject` made, as sentences. The judgement is not repeated here:
    // the Deck renders the same warnings from the same field, and two copies of "this
    // install command will refuse every task" would eventually disagree about which
    // commands do that.
    for (const warning of result.warnings) {
      if (warning.kind === 'no_validation_commands') {
        lines.push(
          '',
          'No validation commands were detected. Add them to .agent-flow/config.yaml —',
          'agent-flow runs them itself, so an invented command fails for the wrong reason.',
        );
      }
      if (warning.kind === 'install_dirties_tree') {
        lines.push(
          '',
          `Warning: \`${warning.command}\` writes a lockfile this repository does not track yet.`,
          'Every task will be refused at the setup check until it is committed — the tree',
          'has to be identical before and after install, or an attempt cannot say what it',
          'changed. Run it once and commit the lockfile before the first feature.',
        );
      }
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
