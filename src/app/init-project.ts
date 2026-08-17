import { stringify as toYaml } from 'yaml';
import type { FileSystem } from '../ports/file-system.js';
import { detectStack, type DetectedStack } from '../config/stack-detection.js';
import { agentFlowPaths } from './paths.js';
import type { StateStore } from './state-store.js';
import type { RunState } from '../contracts/index.js';

/**
 * A run whose planningBase a commit could invalidate (AR-01, C-02).
 *
 * "Not completed or failed" is the spec's definition, and it is deliberately the
 * complement rather than a list: a status added later is active until somebody decides
 * otherwise, which is the safe direction for a gate to fail in.
 */
export function isRunActive(state: RunState): boolean {
  return state.status !== 'completed' && state.status !== 'failed';
}

/**
 * The files `init` touched, named relative to the project (§21.3).
 *
 * `InitResult` carries absolute paths because the CLI prints them to a person standing in
 * a terminal, and there the absolute form is the useful one. **Persisting it is a different
 * question**: an absolute path names this machine's home directory, and §21.3 is explicit
 * that persisted detail is path-free by construction. The paths are already known to be
 * inside the project, so relativising them loses nothing and leaks nothing.
 */
export function projectRelativePaths(
  projectDir: string,
  paths: readonly string[],
): string[] {
  const prefix = `${projectDir}/`;
  return paths.map((path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path));
}

export interface ActiveRunFinding {
  readonly runId: string;
  readonly status: RunState['status'];
  readonly planningBase?: string;
}

/**
 * The active run `init` would disturb, if there is one.
 *
 * The evidence run's second intervention, and the one that made the first expensive:
 * `agent-flow init` ran *after* planning had frozen a planningBase, and the commit its
 * files require moved HEAD out from under the run. Every worktree cut afterwards came from
 * a base the run had not planned against.
 *
 * Newest first, and the first active one wins — `listRunIds` already orders that way, and
 * the newest active run is the one whose base is still being used.
 */
export async function findActiveRun(store: StateStore): Promise<ActiveRunFinding | undefined> {
  for (const runId of await store.listRunIds()) {
    const state = await store.loadRun(runId);
    if (!isRunActive(state)) continue;

    return {
      runId: state.runId,
      status: state.status,
      ...(state.planningBase === undefined ? {} : { planningBase: state.planningBase }),
    };
  }

  return undefined;
}

/** Marks the block `init` owns inside an existing AGENTS.md. */
const AGENTS_BEGIN = '<!-- agent-flow:begin -->';
const AGENTS_END = '<!-- agent-flow:end -->';

const GITIGNORE_BEGIN = '# agent-flow';

export interface InitResult {
  readonly stack: DetectedStack;
  readonly created: string[];
  readonly updated: string[];
  /** Existing files left alone because `force` was not set. */
  readonly skipped: string[];
}

export interface InitOptions {
  readonly fs: FileSystem;
  readonly projectDir: string;
  /** Overwrites files that already exist. Off by default (§7.7). */
  readonly force?: boolean;
}

/**
 * Prepares a repository for agent-flow.
 *
 * Nothing existing is overwritten without `force`. `init` is the first command a
 * user runs in a repository they care about, and a tool that clobbers a hand
 * written AGENTS.md on first contact does not get a second chance.
 *
 * AGENTS.md is the exception that proves the rule: it is *appended* to inside a
 * marked block, so re-running updates that block and leaves everything a human
 * wrote untouched.
 */
export async function initProject(options: InitOptions): Promise<InitResult> {
  const { fs, projectDir, force = false } = options;
  const paths = agentFlowPaths(projectDir);

  const stack = await detectStack(fs, projectDir);
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  await fs.mkdirp(paths.root);

  // ---- .agent-flow/config.yaml
  if ((await fs.exists(paths.config)) && !force) {
    skipped.push(paths.config);
  } else {
    const existed = await fs.exists(paths.config);
    await fs.writeFileAtomic(paths.config, renderProjectConfig(stack));
    (existed ? updated : created).push(paths.config);
  }

  // ---- AGENTS.md
  const agentsPath = `${projectDir}/AGENTS.md`;
  const agentsResult = await writeAgentsMd(fs, agentsPath, stack);
  if (agentsResult === 'created') created.push(agentsPath);
  if (agentsResult === 'updated') updated.push(agentsPath);

  // ---- .gitignore
  const gitignorePath = `${projectDir}/.gitignore`;
  const gitignoreResult = await appendGitignore(fs, gitignorePath);
  if (gitignoreResult === 'created') created.push(gitignorePath);
  if (gitignoreResult === 'updated') updated.push(gitignorePath);

  return { stack, created, updated, skipped };
}

function renderProjectConfig(stack: DetectedStack): string {
  const commands = Object.fromEntries(
    Object.entries(stack.commands).filter(([, value]) => value !== undefined),
  );

  const body = toYaml({
    project: { name: stack.name, type: stack.type },
    commands,
    // Extra ids a plan may reference beyond the standard steps above. A plan
    // names an id; agent-flow looks the command up here. Nothing a model writes
    // ever reaches a shell.
    validationCommands: {},
    paths: stack.paths,
    rules: { architecture: [] },
  });

  const preamble =
    stack.type === 'unknown'
      ? [
          '# agent-flow project configuration',
          '#',
          '# The stack was not recognised, so no commands were filled in. Add the',
          '# ones this project actually uses — they are run by agent-flow itself,',
          '# never by an agent, and an invented command fails for the wrong reason.',
          '',
        ]
      : [
          '# agent-flow project configuration',
          '#',
          `# Detected: ${stack.type}. Commands were read from the repository, not assumed.`,
          '# Only what differs from the global setup belongs here.',
          '',
        ];

  return `${preamble.join('\n')}${body}`;
}

/**
 * Writes the block agent-flow owns, leaving the rest of the file intact.
 *
 * AGENTS.md holds a project's standing rules (§37) and is usually written by
 * hand. Replacing it would destroy exactly the context the workflow depends on.
 */
async function writeAgentsMd(
  fs: FileSystem,
  path: string,
  stack: DetectedStack,
): Promise<'created' | 'updated' | 'unchanged'> {
  const block = [
    AGENTS_BEGIN,
    '',
    '## Validation',
    '',
    'These commands are run by agent-flow after implementation:',
    '',
    ...Object.entries(stack.commands)
      .filter(([, command]) => command !== undefined)
      .map(([name, command]) => `- \`${name}\`: \`${command as string}\``),
    '',
    AGENTS_END,
  ].join('\n');

  if (!(await fs.exists(path))) {
    await fs.writeFileAtomic(
      path,
      [
        '# Project Instructions',
        '',
        'Standing rules for anyone — human or agent — working in this repository.',
        'Everything outside the agent-flow block below is yours to write.',
        '',
        '## Architecture',
        '',
        '- Describe the boundaries that must not be crossed.',
        '',
        '## Tests',
        '',
        '- Say when a change requires a test.',
        '',
        block,
        '',
      ].join('\n'),
    );
    return 'created';
  }

  const current = await fs.readFile(path);

  if (current.includes(AGENTS_BEGIN) && current.includes(AGENTS_END)) {
    const start = current.indexOf(AGENTS_BEGIN);
    const end = current.indexOf(AGENTS_END) + AGENTS_END.length;
    const next = `${current.slice(0, start)}${block}${current.slice(end)}`;
    if (next === current) return 'unchanged';
    await fs.writeFileAtomic(path, next);
    return 'updated';
  }

  await fs.writeFileAtomic(path, `${current.trimEnd()}\n\n${block}\n`);
  return 'updated';
}

async function appendGitignore(
  fs: FileSystem,
  path: string,
): Promise<'created' | 'updated' | 'unchanged'> {
  // Config is versioned — it is a team convention. Run state is local noise.
  const block = [
    GITIGNORE_BEGIN,
    '.agent-flow/runs/',
    '.agent-flow/cache/',
    '.agent-flow/current-run',
  ].join('\n');

  if (!(await fs.exists(path))) {
    await fs.writeFileAtomic(path, `${block}\n`);
    return 'created';
  }

  const current = await fs.readFile(path);
  if (current.includes('.agent-flow/runs/')) return 'unchanged';

  await fs.writeFileAtomic(path, `${current.trimEnd()}\n\n${block}\n`);
  return 'updated';
}
