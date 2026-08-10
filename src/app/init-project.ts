import { stringify as toYaml } from 'yaml';
import type { FileSystem } from '../ports/file-system.js';
import { detectStack, type DetectedStack } from '../config/stack-detection.js';
import { agentFlowPaths } from './paths.js';

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
