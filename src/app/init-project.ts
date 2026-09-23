import { stringify as toYaml } from 'yaml';
import { AGENTS_BEGIN, AGENTS_END, AGENTS_MD_SCAFFOLD, readProjectInstructions } from './project-instructions.js';
import type { FileSystem } from '../ports/file-system.js';
import { detectStack, type DetectedStack } from '../config/stack-detection.js';
import { agentFlowPaths } from './paths.js';
import type { StateStore } from './state-store.js';
import type { RunState } from '../contracts/index.js';

/**
 * A run whose planningBase a commit could invalidate (AR-01, C-02).
 *
 * "Not completed or failed" was the spec's definition, and it was deliberately the
 * complement rather than a list: a status added later is active until somebody decides
 * otherwise, which is the safe direction for a gate to fail in.
 *
 * **`cancelled` is the status that argument was written before, and it breaks it.**
 * `state.schema.ts` defines it as "the one terminal outcome that is neither `completed`
 * nor `failed`… what is gone is the intent to continue" — so the complement reported an
 * ended run as ongoing, and two documented intentions in this codebase contradicted each
 * other. Measured, on a real repository: a warm-up whose process died left its run at
 * `running`, `agent-flow init` refused to write, and `cancel` — the one supported way to
 * close a run — did not lift the refusal. There was no path out but `--force`, which
 * bypasses the gate rather than satisfying it.
 *
 * Still the complement, not a list: the safe direction is unchanged, and a status added
 * after this one is active until somebody says otherwise. What changed is that the three
 * terminal statuses are now all named, because they are all terminal.
 */
export function isRunActive(state: RunState): boolean {
  return (
    state.status !== 'completed' && state.status !== 'failed' && state.status !== 'cancelled'
  );
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


const GITIGNORE_BEGIN = '# agent-flow';

/**
 * Install commands that rewrite a lockfile rather than respect one.
 *
 * Only the forms `stack-detection.ts` actually emits, and only the ones whose behaviour
 * has been observed. A pattern that guessed at other managers' flags would be the kind of
 * unprobed claim `installCommand`'s own comment refuses to make.
 */
const DIRTIES_THE_TREE = /^(npm|pnpm|yarn) install\b/;

/**
 * Instruction files other tools read, which agent-flow does not.
 *
 * §37 names AGENTS.md as *the* standing-rules file, and every stage prompt receives it —
 * `planning-pipeline.ts` and `review-service.ts` read that path and no other, and the
 * discovery cache fingerprints its digest. A repository that keeps its real rules
 * somewhere else is therefore planned against rules nobody wrote.
 *
 * **Measured, on a Vue/Express monorepo.** `AGENTS.md` described itself as a consolidation
 * of `CLAUDE.md` and had drifted 641 lines behind it; the drift included the section
 * naming the repository's own code index. Discovery went in without it, read the monorepo
 * file by file, and was killed at its timeout — an expensive failure whose cause was a
 * stale copy of a file nothing compared.
 *
 * Names, not paths: these sit at the repository root, and §21.3 keeps persisted detail
 * relative. The list is what has been *seen* rather than what could exist — a guess at
 * every assistant's filename would warn about files no one in this repository has.
 */
const UNREAD_INSTRUCTION_FILES = ['CLAUDE.md', 'GEMINI.md', '.cursorrules'] as const;

/**
 * The wall this project will walk into on its first run, said before it does.
 *
 * A finding rather than a sentence, because two surfaces have to say it: `agent-flow init`
 * in a terminal, and the Deck's registration dialog. It was a sentence in `cli/init.ts`,
 * which meant a project registered from the browser would be handed a command known to
 * break it with nothing on screen — the exact shape of the defect the CLI comment was
 * written about, one surface later.
 */
export type InitWarning =
  | {
      /**
       * PRI-25. `stack-detection.ts` prefers `npm ci` precisely because `npm install`
       * rewrites `package-lock.json`, which fails the post-setup cleanliness assertion and
       * makes worktree mode refuse every task. It falls back to `npm install` when there
       * is no lockfile to respect — correctly, since `npm ci` refuses without one.
       *
       * So a project with no committed lockfile is handed a command that is known to break
       * it. A live run found out the expensive way: planning completed, four tasks were
       * dispatched, and every one was refused at the setup check — after the planning had
       * been paid for.
       */
      readonly kind: 'install_dirties_tree';
      readonly command: string;
    }
  | {
      /** Nothing was detected to run, so verification would pass by having nothing to do. */
      readonly kind: 'no_validation_commands';
    }
  | {
      /**
       * Standing rules live in a file agent-flow never opens. See
       * {@link UNREAD_INSTRUCTION_FILES}.
       *
       * Reported only when the content actually *differs* from AGENTS.md. A repository
       * that keeps two identical copies — one per tool — is doing the right thing and
       * must not be nagged about it; the failure mode is drift, not duplication.
       */
      readonly kind: 'instructions_unread';
      /** Repository-relative names, in the order they are looked for. */
      readonly paths: readonly string[];
    }
  | {
      /**
       * AGENTS.md is still the scaffold, so stages receive this file in its place
       * (`project-instructions.ts`). Said so the operator knows which file is live — the
       * old message claimed the opposite, that it was never read.
       */
      readonly kind: 'instructions_fallback';
      readonly path: string;
    };

export interface InitResult {
  readonly stack: DetectedStack;
  readonly created: string[];
  readonly updated: string[];
  /** Existing files left alone because `force` was not set. */
  readonly skipped: string[];
  /** What the operator has to know before the first feature, decided here, said anywhere. */
  readonly warnings: readonly InitWarning[];
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

  return { stack, created, updated, skipped, warnings: await warningsFor(fs, projectDir, stack) };
}

export type RegisterOutcome =
  | {
      /** The AR-01 gate held. Nothing was written. */
      readonly ok: false;
      readonly reason: 'active_run';
      readonly active: ActiveRunFinding;
    }
  | {
      readonly ok: true;
      readonly result: InitResult;
      /** Present when `force` carried the write past an active run. Recorded on that run. */
      readonly active?: ActiveRunFinding;
    };

export interface RegisterProjectOptions {
  readonly store: StateStore;
  readonly fs: FileSystem;
  readonly projectDir: string;
  readonly force?: boolean;
}

/**
 * Prepare a repository, gate included — the use case both surfaces call.
 *
 * `initProject` above writes files and knows nothing about runs; this is the whole act,
 * and the difference matters because the gate is half the contract. Extracted when the
 * Deck grew a registration dialog (7.6): the same sequence written twice would be a second
 * enforcement of AR-01, and the copy that drifted would be the one nobody was watching.
 * The architecture test that forbids an HTTP handler from calling `appendEvent` is the
 * rule that made the shape explicit, and it was right to.
 */
export async function registerProject(options: RegisterProjectOptions): Promise<RegisterOutcome> {
  // AR-01, C-02. Before `initProject`, because "it writes nothing" is half the contract
  // and a gate that runs after the write is not a gate.
  const active = await findActiveRun(options.store);

  if (active !== undefined && options.force !== true) {
    return { ok: false, reason: 'active_run', active };
  }

  const result = await initProject({
    fs: options.fs,
    projectDir: options.projectDir,
    ...(options.force === undefined ? {} : { force: options.force }),
  });

  // After the write rather than before it: the event says what happened, and an event
  // recording an override that then failed would be a lie the audit trail keeps.
  if (active !== undefined) {
    await options.store.appendEvent(active.runId, 'init_during_active_run', {
      forced: true,
      status: active.status,
      ...(active.planningBase === undefined ? {} : { planningBase: active.planningBase }),
      // Project-relative, never absolute (§21.3). What matters afterwards is which files
      // moved under this run, not where this machine keeps its home directory.
      created: projectRelativePaths(options.projectDir, result.created),
      updated: projectRelativePaths(options.projectDir, result.updated),
    });
  }

  return { ok: true, result, ...(active === undefined ? {} : { active }) };
}

async function warningsFor(
  fs: FileSystem,
  projectDir: string,
  stack: DetectedStack,
): Promise<InitWarning[]> {
  const warnings: InitWarning[] = [];

  const install = stack.commands.install;
  if (install !== undefined && DIRTIES_THE_TREE.test(install)) {
    warnings.push({ kind: 'install_dirties_tree', command: install });
  }

  if (Object.values(stack.commands).filter(Boolean).length === 0) {
    warnings.push({ kind: 'no_validation_commands' });
  }

  const unread = await unreadInstructions(fs, projectDir);
  if (unread.length > 0) warnings.push({ kind: 'instructions_unread', paths: unread });

  const instructions = await readProjectInstructions(fs, projectDir);
  if (instructions.source === 'CLAUDE.md') warnings.push({ kind: 'instructions_fallback', path: 'CLAUDE.md' });

  return warnings;
}

/**
 * Instruction files that exist, say something AGENTS.md does not, and are never read.
 *
 * Compared by content rather than by existence, because the healthy arrangement is two
 * identical files — one per tool — and warning about that would train people to ignore
 * the warning that matters. Whitespace is normalised on both sides so a trailing newline
 * is not reported as divergence.
 *
 * Runs after `writeAgentsMd`, deliberately: on a first `init` the block agent-flow owns
 * has just been written, and the comparison should be against the file as it now stands.
 */
async function unreadInstructions(fs: FileSystem, projectDir: string): Promise<string[]> {
  const agentsPath = `${projectDir}/AGENTS.md`;
  const agents = (await fs.exists(agentsPath)) ? normalise(await fs.readFile(agentsPath)) : '';

  // A file the stages actually receive is not unread — CLAUDE.md stands in for a scaffold
  // AGENTS.md (project-instructions.ts), and warning about it would be the old, false claim.
  const source = (await readProjectInstructions(fs, projectDir)).source;

  const found: string[] = [];
  for (const name of UNREAD_INSTRUCTION_FILES) {
    const path = `${projectDir}/${name}`;
    if (name === source) continue;
    if (!(await fs.exists(path))) continue;
    if (normalise(await fs.readFile(path)) === agents) continue;
    found.push(name);
  }

  return found;
}

function normalise(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
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
    await fs.writeFileAtomic(path, [...AGENTS_MD_SCAFFOLD, block, ''].join('\n'));
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
