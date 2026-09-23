import { basename, join, resolve } from 'node:path';
import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import {
  forgetProject,
  isProjectDirectory,
  ownsGlobalConfig,
  projectHubPath,
  readProjectHub,
  rememberProject,
} from '../app/project-hub.js';
import type { FileSystem } from '../ports/index.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import type { GlobalOptions } from './index.js';

/**
 * `agent-flow projects [list|add|remove]` — the project hub from the terminal.
 *
 * Every command run in a project already adds it (see {@link rememberCurrentProject}); this
 * is for the rest: handing the dashboard a folder of repositories without `cd` into each
 * one, and taking back a directory it should no longer show.
 */

export type ProjectsAction = 'list' | 'add' | 'remove';

export async function runProjectsCommand(
  action: ProjectsAction,
  dirs: readonly string[],
  globals: GlobalOptions,
  fs: FileSystem = new NodeFileSystem(),
  write: (text: string) => void = (text) => process.stdout.write(text),
  // The platform's, unless a test names the flavour it asserts (the in-memory fake has no drives).
  resolvePath: (from: string, to: string) => string = resolve,
): Promise<ExitCodeValue> {
  const hubFile = projectHubPath(globals.globalConfigPath);

  if (action === 'list') {
    const hub = await readProjectHub(fs, globals.globalConfigPath);
    if (globals.json) {
      write(`${JSON.stringify(hub, null, 2)}\n`);
      return ExitCode.OK;
    }
    if (hub.length === 0) {
      write(`The project hub is empty (${hubFile}).\nRun any agent-flow command in a project, or: agent-flow projects add <dir>\n`);
      return ExitCode.OK;
    }
    const lines = [`${String(hub.length)} director${hub.length === 1 ? 'y' : 'ies'} in the project hub (${hubFile}):`];
    for (const dir of hub) {
      const kind = (await fs.exists(join(dir, '.agent-flow', 'config.yaml'))) ? 'project' : 'folder ';
      lines.push(`  ${kind}  ${dir}`);
    }
    lines.push('', '`folder` entries are scanned for projects and for repositories the dashboard can `init`.', '');
    write(lines.join('\n'));
    return ExitCode.OK;
  }

  if (dirs.length === 0) {
    process.stderr.write(`agent-flow projects ${action} needs at least one directory.\n`);
    return ExitCode.CONFIG_ERROR;
  }

  let failed = false;
  for (const raw of dirs) {
    const dir = resolvePath(globals.cwd, raw);

    if (action === 'add') {
      if (!(await fs.exists(dir))) {
        process.stderr.write(`No such directory: ${dir}\n`);
        failed = true;
        continue;
      }
      // The hub drops this directory without a word, so the answer used to be "already in"
      // for a directory that was never added and never will be.
      if (ownsGlobalConfig(dir, globals.globalConfigPath)) {
        process.stderr.write(
          `Not added: ${dir} holds the global configuration (${globals.globalConfigPath}), so it cannot be a project.\n` +
            'Add the folder your repositories live in instead.\n',
        );
        failed = true;
        continue;
      }
      const added = await rememberProject(fs, globals.globalConfigPath, dir);
      write(added ? `added      ${dir}\n` : `already in ${dir}\n`);
      continue;
    }

    // `remove`: by path, or by the directory's name when exactly one entry carries it —
    // the name is what the dashboard shows, and a person removing one should not need the
    // full path of a directory that may already be gone.
    if (await forgetProject(fs, globals.globalConfigPath, dir)) {
      write(`removed    ${dir}\n`);
      continue;
    }
    const named = (await readProjectHub(fs, globals.globalConfigPath)).filter((entry) => basename(entry) === raw);
    if (named.length === 1 && named[0] !== undefined && (await forgetProject(fs, globals.globalConfigPath, named[0]))) {
      write(`removed    ${named[0]}\n`);
      continue;
    }
    process.stderr.write(
      named.length > 1
        ? `"${raw}" names ${String(named.length)} entries; pass the full path:\n${named.map((entry) => `  ${entry}`).join('\n')}\n`
        : `Not in the project hub: ${dir}\n`,
    );
    failed = true;
  }

  return failed ? ExitCode.CONFIG_ERROR : ExitCode.OK;
}

/**
 * Adds the directory a command ran in to the hub, when it is a project.
 *
 * Called after every command, so the hub fills itself: the first `feature`, `status` or
 * `init` in a repository is what makes the dashboard list it from anywhere. Never throws —
 * bookkeeping must not turn a command that worked into one that failed.
 */
export async function rememberCurrentProject(
  globals: GlobalOptions,
  fs: FileSystem = new NodeFileSystem(),
): Promise<void> {
  try {
    if (await isProjectDirectory(fs, globals.cwd, globals.globalConfigPath)) {
      await rememberProject(fs, globals.globalConfigPath, globals.cwd);
    }
  } catch {
    // The hub is a convenience. A read-only home or a locked file loses nothing that matters.
  }
}
