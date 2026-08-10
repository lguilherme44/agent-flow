import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { initProject } from '../app/init-project.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import type { GlobalOptions } from './index.js';

/** `agent-flow init` — prepare a repository. Never clobbers anything (§7.7). */
export async function runInitCommand(
  options: { force?: boolean },
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  try {
    const result = await initProject({
      fs: new NodeFileSystem(),
      projectDir: globals.cwd,
      ...(options.force === undefined ? {} : { force: options.force }),
    });

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
