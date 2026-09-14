import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { NodeProcessRunner } from '../adapters/process/node-process-runner.js';
import { NodeHost } from '../adapters/host/node-host.js';
import { createGitCommand } from '../adapters/git/git-command.js';
import { TreeSitterTagger } from '../adapters/tagger/tree-sitter-tagger.js';
import { buildRepoMap, writeRepoMap } from '../app/repo-map.js';
import { loadConfig } from '../config/loader.js';
import { formatElapsed } from './render/progress.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import type { GlobalOptions } from './index.js';

/**
 * How much of a stage prompt the map may occupy by default.
 *
 * Chosen against a measurement rather than a feeling: the discovery prompt that failed was
 * 18.620 bytes of instructions plus 15.572 of AGENTS.md — roughly 9.000 tokens before
 * anything about the repository. Eight thousand tokens of map is comparable to what the
 * stage already carries and a small fraction of any modern window, while being enough for
 * several hundred ranked files.
 */
const DEFAULT_BUDGET_TOKENS = 8000;

/**
 * `agent-flow map` — build the repository map and show what it cost.
 *
 * Exists so the map can be judged without spending a model call on a stage to see it. It
 * is the same use case `discovery` will call, so what is printed here is what the prompt
 * will carry, not an approximation of it.
 */
export async function runMapCommand(
  options: { readonly budget?: string; readonly write?: boolean },
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  try {
    const fs = new NodeFileSystem();
    const host = new NodeHost();
    const tagger = new TreeSitterTagger();
    const budgetTokens = Number.parseInt(options.budget ?? '', 10) || DEFAULT_BUDGET_TOKENS;

    // The same wiring `clean` uses. Git reaches the filesystem through a hooks-isolated
    // home (§26.1), and building one here by hand would be the second internal Git spawner
    // that rule exists to prevent.
    const git = await createGitCommand({
      processRunner: new NodeProcessRunner(),
      fs,
      homeDir: host.homeDir,
    });

    // Read for scope only. A configuration that will not parse costs the narrowing and
    // nothing else — the map of a whole tree is still a map.
    let sourcePaths: readonly string[] = [];
    try {
      const config = await loadConfig({ fs, globalConfigPath: globals.globalConfigPath, projectDir: globals.cwd });
      sourcePaths = config.project?.paths.source ?? [];
    } catch {
      sourcePaths = [];
    }

    const result = await buildRepoMap({
      fs,
      git,
      tagger,
      projectDir: globals.cwd,
      budgetTokens,
      sourcePaths,
    });

    if (result === undefined) {
      // The parser's own words when it has any. An empty map is what a machine that never
      // installed the optional grammars sees and what a broken installation sees, and
      // until this line those two produced the same sentence.
      const health = tagger.health();
      process.stderr.write(
        health.available
          ? 'No map could be built. This needs a Git repository with source files the\n' +
            'tagger recognises.\n'
          : 'The repository map needs its optional parser, which did not load:\n\n' +
            `  ${health.detail ?? 'no detail reported'}\n\n` +
            'Install it with: npm i web-tree-sitter tree-sitter-wasms\n',
      );
      return ExitCode.EXECUTION_ERROR;
    }

    if (options.write === true) await writeRepoMap(fs, globals.cwd, result.text);

    if (globals.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return ExitCode.OK;
    }

    process.stdout.write(`${result.text}\n`);
    // To stderr, so `agent-flow map > map.txt` gets the map and the operator still sees
    // what it cost. The numbers are the point of the command as much as the text is.
    process.stderr.write(
      [
        '',
        `${String(result.tagged)} of ${String(result.candidates)} candidate files produced symbols`,
        `${String(result.estimatedTokens)} tokens of ${String(budgetTokens)} budgeted` +
          (result.omitted > 0 ? `, ${String(result.omitted)} file(s) did not fit` : ''),
        `built in ${formatElapsed(result.elapsedMs)}`,
        '',
      ].join('\n'),
    );

    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}
