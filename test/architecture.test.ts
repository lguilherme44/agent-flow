import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Executable architecture rules (plan §7.2).
 *
 * The spec states these constraints in prose. Prose does not survive six months
 * of maintenance — these do. Every rule here maps to a decision that, once
 * broken, is expensive to unwind.
 */

const ROOT = join(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) out.push(full);
    }
  };
  walk(abs);
  return out;
}

function read(file: string): { path: string; text: string } {
  return { path: relative(ROOT, file), text: readFileSync(file, 'utf8') };
}

/** Import specifiers only — comments and prose must not trip these rules. */
function importSpecifiers(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s[^;]*?from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) out.push(match[1]);
    }
  }
  return out;
}

/**
 * Strips comments and keeps string literals — the opposite of {@link codeOnly}.
 *
 * Some rules are *about* the literals: an error code, a command-line flag, an
 * event name. `codeOnly` blanks exactly those, so a rule written against it
 * would pass by looking at nothing.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * Strips comments and string literals so identifier scans do not hit prose.
 *
 * **The three quote styles are blanked in one alternation, left to right, and
 * that is load-bearing.** Three sequential passes look equivalent and are not:
 * the single-quote pass ran first over the whole file, so an apostrophe inside a
 * double-quoted or backtick string — `"the coding agent's history"` — opened a
 * literal that closed at the *next* apostrophe anywhere below it, blanking every
 * line in between. Measured when M2-05 landed: it was hiding two thousand
 * characters of `run-git-identity.ts` and most of `attempt-receipt.ts` from every
 * rule in this file, and a rule that cannot see the thing it forbids passes
 * forever. One alternation consumes whichever delimiter opens first, which is
 * what a scanner would do.
 */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(
      /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g,
      (literal) => `${literal[0] ?? ''}${literal[0] ?? ''}`,
    );
}

describe('src/core stays pure (AD-03)', () => {
  it('imports no Node built-ins', () => {
    const offenders = sourceFiles('src/core')
      .map(read)
      .filter(({ text }) => importSpecifiers(text).some((s) => s.startsWith('node:')))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('imports no adapters', () => {
    const offenders = sourceFiles('src/core')
      .map(read)
      .filter(({ text }) => importSpecifiers(text).some((s) => s.includes('adapters/')))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});

describe('src/core knows no provider (§3, §58)', () => {
  // The single most important property of the design: swapping runners must
  // never require touching the core.
  const FORBIDDEN = ['claude', 'codex', 'anthropic', 'openai', 'gpt-', 'opus', 'sonnet'];

  it('mentions no provider, model or CLI name', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('src/core')) {
      const { path, text } = read(file);
      const haystack = codeOnly(text).toLowerCase();
      const hits = FORBIDDEN.filter((needle) => haystack.includes(needle));
      if (hits.length > 0) offenders.push(`${path}: ${hits.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('the dashboard depends on the core, never the reverse (§63)', () => {
  // The rule the monorepo layout of §63 exists to enforce. The directory split
  // is not done yet — it would mean rewriting every import in a validated CLI
  // for no functional gain — so the guarantee it was meant to provide is
  // enforced here instead, where it holds today rather than after a refactor.
  const CORE_SIDE = [
    'src/core',
    'src/ports',
    'src/contracts',
    'src/config',
    'src/adapters',
    'src/app',
  ];

  it('keeps the core side free of the server', () => {
    const offenders: string[] = [];

    for (const dir of CORE_SIDE) {
      for (const file of sourceFiles(dir)) {
        const { path, text } = read(file);
        if (importSpecifiers(text).some((specifier) => specifier.includes('server/'))) {
          offenders.push(path);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the server out of the CLI', () => {
    // `cli` may start the server; the server must not reach back into command
    // handlers, or the two grow a shared notion of "the current run" that only
    // one of them owns.
    const offenders = sourceFiles('src/server')
      .map(read)
      .filter(({ text }) => importSpecifiers(text).some((s) => s.includes('cli/')))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('keeps contracts free of every layer above them', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles('src/contracts')) {
      const { path, text } = read(file);
      const bad = importSpecifiers(text).filter((specifier) =>
        ['core/', 'app/', 'adapters/', 'cli/', 'server/', 'config/'].some((layer) =>
          specifier.includes(layer),
        ),
      );
      if (bad.length > 0) offenders.push(`${path}: ${bad.join(', ')}`);
    }

    expect(offenders).toEqual([]);
  });
});

describe('the local server exposes no credentials (§93)', () => {
  // The server reads a project's `.agent-flow/` directory and nothing else.
  // Runner authentication is reported as a status the adapters already compute
  // for `doctor`; no handler opens the file behind it.
  const SECRETS = ['auth.json', 'credentials', '.netrc', 'process.env', 'id_rsa'];

  it('never names an auth file or reads the environment', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles('src/server')) {
      const { path, text } = read(file);
      const haystack = codeOnly(text);
      const hits = SECRETS.filter((needle) => haystack.includes(needle));
      if (hits.length > 0) offenders.push(`${path}: ${hits.join(', ')}`);
    }

    expect(offenders).toEqual([]);
  });
});

describe('src/ports declares contracts only (AD-03)', () => {
  it('imports no adapters', () => {
    const offenders = sourceFiles('src/ports')
      .map(read)
      .filter(({ text }) => importSpecifiers(text).some((s) => s.includes('adapters/')))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});

describe('no stack-specific rules leak into the tool (§58)', () => {
  // agent-flow must not know that Flutter or NestJS exist outside of stack
  // detection, whose entire job is mapping marker files to labels.
  const FRAMEWORKS = ['flutter', 'nestjs', 'react', 'laravel', 'django', 'rails'];
  const ALLOWED = ['src/config/stack-detection.ts'];

  it('mentions no framework outside stack detection', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('src')) {
      const { path, text } = read(file);
      if (ALLOWED.includes(path)) continue;
      const haystack = codeOnly(text).toLowerCase();
      const hits = FRAMEWORKS.filter((needle) => haystack.includes(needle));
      if (hits.length > 0) offenders.push(`${path}: ${hits.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('nothing a model wrote reaches a shell (V-01)', () => {
  // The rule the specification's command guard (§36) was cut for not being able
  // to enforce. Agent Flow cannot intercept what a runner executes inside its
  // sandbox — but it absolutely can refuse to run model-authored text itself.
  //
  // Only two modules may name a shell, and both take strings that came from
  // configuration a human wrote.
  const ALLOWED_TO_SHELL = ['src/app/verification-commands.ts'];

  it('spawns a shell from one module only', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles('src')) {
      const { path, text } = read(file);
      if (ALLOWED_TO_SHELL.includes(path)) continue;
      if (/\/bin\/sh|\bsh\b\s*['"`]?\s*,\s*\[\s*['"`]-c|cmd\.exe|powershell/i.test(codeOnly(text))) {
        offenders.push(path);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('takes the setup command from project config and from nowhere else (S-11)', () => {
    // §8.1 reuses `project.commands.install` rather than adding a
    // `git.worktreeSetup` key (§30.1), which means workspace preparation now runs
    // a shell command before every task in worktree mode. That is only safe while
    // the string is one a human wrote in a config file.
    //
    // So: the preparation service reads it from the effective config, routes it
    // through the one module allowed to name a shell, and its request type — the
    // part a caller fills in per task — carries no command at all.
    // AR-04 split the sequence out of `task-workspaces.ts` so the integration worktree
    // could use the same one (AD-44), which moves *where* each half of this rule lives
    // without changing the rule: the config read stays with the caller that owns the
    // project config, and the shell stays in the module that owns the sequence.
    const code = codeOnly(read(join(ROOT, 'src/app/task-workspaces.ts')).text);
    const preparation = codeOnly(read(join(ROOT, 'src/app/workspace-preparation.ts')).text);

    expect(code).toContain('config.project?.commands?.install');
    expect(preparation).toContain('runCommands');

    // And nothing else may run the install. Every caller of the sequence has to take the
    // string from configuration, which is what makes "a human wrote it" checkable rather
    // than asserted.
    // Matched on the *import* rather than on a call by name. The scheduler has a private
    // method of the same name — it asks `TaskWorkspaces` for a workspace, which is a
    // different thing at a different layer — and a rule that cannot tell them apart is a
    // rule that fails on correct code.
    const PREPARES = ['src/app/task-workspaces.ts', 'src/app/run-actions.ts'];
    const offenders = sourceFiles('src')
      .map(read)
      .filter(
        ({ path, text }) =>
          !PREPARES.includes(path) &&
          path !== 'src/app/workspace-preparation.ts' &&
          importSpecifiers(text).some((specifier) => specifier.includes('workspace-preparation')),
      )
      .map(({ path }) => path);

    expect(offenders, 'a module outside the preparation callers runs the install').toEqual([]);

    // A per-attempt command would be a second, caller-supplied answer to "what
    // should run here" — and the caller is the scheduler, holding a plan. Read as
    // the interface body rather than by regex over the file: a pattern loose
    // enough to span from the declaration to the next brace also spans into
    // `runInstall(command: string)`, and would fail on correct code.
    const request = code.slice(code.indexOf('interface PrepareRequest'));
    const body = request.slice(request.indexOf('{'), request.indexOf('\n}') + 2);

    expect(body, 'PrepareRequest was not found').toContain('taskId');
    for (const field of ['command', 'install', 'setup', 'script']) {
      expect(body, `PrepareRequest carries a ${field}`).not.toContain(field);
    }
  });

  it('keeps file overlap out of the graph (AD-43, AR-06)', () => {
    // Overlap is planning and scheduling *policy*; topology is what the DAG is. Teaching
    // the graph about files would couple the two, and the rule that keeps ordering in one
    // module would have to loosen to allow it.
    //
    // AD-43 names this rule: "`core/dag.ts` stays file-agnostic and `DagNode` remains
    // `{ id, dependencies }`".
    const dag = codeOnly(read(join(ROOT, 'src/core/dag.ts')).text);

    expect(dag, 'the DAG learned about files').not.toMatch(/\bfiles\b|filesLikely|files\.likely/);

    const node = dag.slice(dag.indexOf('interface DagNode'));
    const body = node.slice(node.indexOf('{'), node.indexOf('\n}') + 2);
    expect(body, 'DagNode was not found').toContain('dependencies');
    expect(body, 'DagNode gained a file-shaped field').not.toMatch(/file|path|glob/i);

    // And the overlap policy has one home. Two implementations of "do these tasks
    // contend" would eventually disagree, and the one that drifted would be the one
    // deciding whether two agents write the same file at the same time.
    const OWNS_OVERLAP = ['src/core/file-overlap.ts'];
    const offenders = sourceFiles('src')
      .map(read)
      .filter(({ path, text }) => {
        if (OWNS_OVERLAP.includes(path)) return false;
        const code = codeOnly(text);
        // The shape of a hand-rolled intersection over declared files.
        return /files\.likely[\s\S]{0,200}?\.(?:includes|some|filter)\s*\(/.test(code) &&
          /overlap|contend|intersect/i.test(code);
      })
      .map(({ path }) => path);

    expect(offenders, 'a second overlap implementation exists').toEqual([]);
  });

  it('prepares a workspace from one sequence only (AD-44, AR-04)', () => {
    // The rule AD-44 asks for by name: "an architecture test forbids a second
    // implementation". The sequence existed, was correct, and had one caller — so the
    // integration worktree simply never got it, and `review` ran lint, typecheck, test and
    // build in a tree with no `node_modules`, producing four `exit 127`s that described
    // the environment and were read as a verdict on the code.
    //
    // A second copy would not be a duplicate so much as a divergence waiting to happen:
    // the two would drift, and the one that drifted would be the one nobody was looking at.
    // `doctor`'s §8.4 probe is the one exemption, and it is not a preparation: it creates a
    // *throwaway* checkout to find out whether the configured install leaves a fresh tree
    // clean, reports what it saw, and removes the worktree in a `finally`. It prepares
    // nothing anybody will run work in — the question it answers is about the command
    // itself, which is why it has to run it outside the sequence that trusts it.
    const OWNS_SEQUENCE = ['src/app/workspace-preparation.ts', 'src/cli/doctor.ts'];

    const offenders: string[] = [];
    for (const file of sourceFiles('src')) {
      const { path, text } = read(file);
      if (OWNS_SEQUENCE.includes(path)) continue;
      const code = codeOnly(text);

      // The shape of the sequence, not its words: a module that both asserts cleanliness
      // and runs an install is reimplementing it, whatever it calls the steps.
      const assertsClean = /status\s*\(\s*\{\s*cwd/.test(code) && /\.clean\b/.test(code);
      const runsInstall = /commands\?\.install|commands\.install/.test(code) && /runCommands\s*\(/.test(code);

      if (assertsClean && runsInstall) offenders.push(path);
    }

    expect(offenders, 'a second preparation sequence exists').toEqual([]);

    // And `install` is not a verification step. It has to run *before* the step whose
    // failure it would otherwise be blamed for, and a project that declares no install
    // command is not a project that failed to install.
    const verification = codeOnly(read(join(ROOT, 'src/app/verification-commands.ts')).text);
    const order = verification.slice(
      verification.indexOf('VERIFICATION_ORDER'),
      verification.indexOf(';', verification.indexOf('VERIFICATION_ORDER')),
    );
    expect(order, 'install became a verification step').not.toContain('install');
  });

  it('resolves validation ids through the registry, never straight from a task', () => {
    // The executor must not read `task.validation` into a command position. It
    // maps ids through buildValidationRegistry, which only knows what the
    // project config declared.
    const { text } = read(join(ROOT, 'src/app/task-executor.ts'));
    const code = codeOnly(text);

    expect(code).toContain('buildValidationRegistry');
    // The old defect, verbatim: joining plan entries into a command line.
    expect(code).not.toMatch(/task\.validation\.join/);
  });
});

describe('graph logic lives in exactly one module (C-3)', () => {
  // The rev.1 plan would have grown a partial cycle check inside planning and a
  // full DAG later. One module, one implementation.
  //
  // The rule is against *reimplementing*, not against using: a module that
  // imports from core/dag.ts is doing exactly the right thing. Only a module
  // that talks about topological ordering while sourcing it from somewhere else
  // is a violation.
  const HOME = 'src/core/dag.ts';

  it('implements topological ordering only in core/dag.ts', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles('src')) {
      const { path, text } = read(file);
      if (path === HOME) continue;

      const mentionsGraphLogic = /topolog|kahn/i.test(codeOnly(text));
      if (!mentionsGraphLogic) continue;

      const importsTheRealThing = importSpecifiers(text).some((specifier) =>
        specifier.includes('core/dag'),
      );
      if (!importsTheRealThing) offenders.push(path);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the implementation where it belongs', () => {
    // Guards the rule above from passing vacuously if dag.ts were ever emptied.
    const { text } = read(join(ROOT, HOME));
    expect(text).toMatch(/topological/i);
  });
});

describe('a configured task limit is resolved, never used raw (M2-00.3)', () => {
  // The defect this pins: `parallelism.maxTasks` went from the configuration file
  // straight into `Scheduler.maxConcurrency`, so `maxTasks: 4` really did run four
  // implementation agents against one working tree — no worktrees, one `git
  // status`, one set of validation commands. `git.useWorktrees` looks like the
  // safety catch and is read by nothing that executes anything.
  //
  // The behaviour is proved in test/app/effective-concurrency.test.ts. This is the
  // rule underneath it: the number reaching a scheduler must have gone through the
  // resolver, so re-wiring it back is a failing test rather than a silent
  // regression. Deliberately no `IsolationCapability` interface behind it — there
  // is no isolation to describe yet, and inventing a type for one would be a
  // seam that lies about what exists.
  const HOME = 'src/core/concurrency.ts';

  it('reads parallelism.maxTasks in one place outside the config layer', () => {
    const allowed = new Set([
      HOME,
      // Resolves it into what the scheduler is given.
      'src/app/execution-context.ts',
      // Reports the configured value, and says it is not the effective one.
      'src/server/config-reader.ts',
      // M2-10: §21.2 requires the read model to expose `requested` beside
      // `effective`, because "4" and "1" are different facts and a reader who saw
      // only one of them would plan around it. It resolves through the same
      // function the scheduler uses rather than reporting the raw number as though
      // it were the instruction.
      'src/server/run-reader.ts',
    ]);

    const offenders = sourceFiles('src')
      .map(read)
      .filter(({ path }) => !allowed.has(path) && !path.startsWith('src/config/'))
      .filter(({ text }) => /parallelism\s*\.\s*maxTasks/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('hands the scheduler a resolved number rather than the configured one', () => {
    const { text } = read(join(ROOT, 'src/app/execution-context.ts'));
    const code = codeOnly(text);

    expect(code).toMatch(/resolveTaskConcurrency\s*\(/);
    // M2-11: a *function of the run*, not a number fixed when this context was
    // built. The old assertion was `maxConcurrency: concurrency.effective`, which
    // was correct while the answer could not depend on the run — and became the
    // thing standing between an isolated run and the parallelism it was configured
    // for, because this context is assembled before any run is named.
    expect(code).toMatch(/concurrencyFor:\s*\(state\)\s*=>/);
    expect(code).not.toMatch(/maxConcurrency:/);
    // The shape of the bug, spelled out so it cannot come back by copy-paste.
    expect(code).not.toMatch(/maxConcurrency:\s*config\.global\.parallelism\.maxTasks/);
  });

  it('never lets the production scheduler take a fixed limit (M2-11)', () => {
    // `maxConcurrency` survives for the tests that are about the loop rather than
    // the policy. A production path that set it would be answering "how many tasks
    // at once" from the moment the context was assembled, which is before the run
    // is known — and that is precisely how a page saying `effective: 4` ends up
    // beside a run executing one task at a time.
    // `\??` so the option's own declaration counts: this rule is worthless if the
    // only file it can see is the one that no longer sets it.
    const offenders = sourceFiles('src')
      .map(read)
      .filter(({ text }) => /maxConcurrency\s*\??\s*:/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual(['src/app/scheduler.ts']);
  });

  it('teaches the scheduler and the read model about isolation together (M2-11)', () => {
    // The failure this forbids has two symmetric halves and both are silent. A
    // scheduler that knows the mode beside a read model that does not means the
    // page reports one task at a time while four agents are running; the reverse
    // means the page promises four while the run does one. Either way the number a
    // person debugs by is wrong, and nothing fails.
    //
    // So the rule is a *pair*: every production caller of the resolver passes a
    // mode, and the mode it passes comes from the run. Written over the call sites
    // rather than over line numbers, because the point is which modules ask, not
    // where in the file they ask it.
    const CALLERS = ['src/app/execution-context.ts', 'src/server/run-reader.ts'];

    for (const path of CALLERS) {
      const code = codeOnly(read(join(ROOT, path)).text);
      const call = /resolveTaskConcurrency\s*\(([^)]*)\)/.exec(code);

      expect(call, `${path} no longer resolves concurrency`).not.toBeNull();
      // Two arguments: the requested number and the mode.
      expect((call?.[1] ?? '').split(',').length, `${path} defaults the mode`).toBe(2);
      // And the mode is the run's, not the configuration's. `codeOnly` blanks
      // string literals, so a hard-coded `'worktree'` cannot satisfy this.
      expect(code, `${path} does not read the mode off the run`).toMatch(/isolationMode/);
      expect(code, `${path} reads the mode off the configuration`).not.toMatch(
        /useWorktrees/,
      );
    }

    // Nobody else resolves it in an execution or a read path, which is what keeps
    // the pair a pair rather than two of several.
    const resolvers = sourceFiles('src')
      .map(read)
      .filter(({ path }) => path !== HOME)
      .filter(({ text }) => /resolveTaskConcurrency\s*\(/.test(codeOnly(text)))
      .map(({ path }) => path)
      .sort();

    expect(resolvers).toEqual([...CALLERS, 'src/server/config-reader.ts'].sort());
  });

  it('keeps both ceilings in the resolver, so raising either is one edit', () => {
    // Guards the rule above from passing vacuously if the resolver were emptied.
    // Two ceilings from M2-01 on: one for tasks sharing a working tree, one for
    // tasks that each own a worktree (§4.4). The first never moves.
    const { text } = read(join(ROOT, HOME));
    expect(text).toMatch(/MAX_SUPPORTED_TASK_CONCURRENCY\s*=\s*1/);
    expect(text).toMatch(/MAX_ISOLATED_TASK_CONCURRENCY\s*=\s*8/);
  });

  it('reads git.useWorktrees in exactly one deciding module (M2-03, I-13)', () => {
    // Stronger than the M2-00 version of this rule, not weaker. Then the flag
    // could be declared and displayed and nothing else, because nothing could
    // act on it. Now one module acts on it — at `createRun`, once — and every
    // other consumer reads `state.isolationMode` instead.
    //
    // The distinction this protects is the whole of §6.1: a flag consulted at
    // each execution is a property of *the machine at that moment*, and a field
    // captured at creation is a property of *the run*. A run is the thing this
    // tool makes promises about.
    const allowed = new Set([
      // Declares it.
      'src/contracts/config.schema.ts',
      // The default value.
      'src/config/defaults.ts',
      // Shows what is configured, on a page about configuration.
      'src/server/config-reader.ts',
      // Decides the mode of a NEW run, and nothing else.
      'src/app/run-git-identity.ts',
    ]);

    const offenders = sourceFiles('src')
      .map(read)
      .filter(({ text }) => /useWorktrees/.test(codeOnly(text)))
      .filter(({ path }) => !allowed.has(path))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('cannot let a precondition read the configuration, by construction', () => {
    // The first version of this rule searched the file for `useWorktrees` inside
    // each function, and it was the wrong tool twice over: `codeOnly` does not
    // fully blank a multi-line template literal, so the search drifted, and a
    // text rule would have been satisfiable by renaming a variable.
    //
    // So the property is structural instead. `checkWorktreePreconditions` takes
    // `RepositoryDeps`, which has no `config` member — a precondition cannot
    // consult the live configuration because it is never handed it, and the
    // compiler says so rather than a regex. That matters because a precondition
    // asking the configuration a second time is precisely the §6.2 sequence that
    // capturing the mode at creation exists to remove.
    const { text } = read(join(ROOT, 'src/app/run-git-identity.ts'));
    const code = codeOnly(text);

    const repositoryDeps = code.slice(
      code.indexOf('export interface RepositoryDeps'),
      code.indexOf('export interface RunGitIdentityDeps'),
    );

    expect(repositoryDeps).toMatch(/workspaces/);
    expect(repositoryDeps, 'preconditions can see the configuration').not.toMatch(/config/);
    // And the check really does take the narrower type.
    expect(code).toMatch(/checkWorktreePreconditions\([\s\S]{0,120}RepositoryDeps/);
  });

  it('names a git worktree operation only inside the Git adapter (M2-02)', () => {
    // Until M2-02 this read "creates no git worktree anywhere in production
    // code", which was the right rule while no module was allowed to know what a
    // worktree was. M2-02 builds the one module that is, so the rule became a
    // *location* rule — which is stronger, not weaker: a prohibition is deleted
    // the day the feature lands, and a location rule is what keeps it in one
    // place afterwards.
    //
    // Read through `codeOnly` since M2-03, because prose outside the adapter is
    // now legitimate: `run-git-identity.ts` has to explain why a repository with
    // submodules is refused, and the explanation is that `git worktree add` does
    // not populate them. The rule about *calling* the lifecycle is the one below.
    const offenders = sourceFiles('src')
      .map(read)
      .filter(({ path }) => !path.startsWith('src/adapters/git/'))
      .filter(({ text }) => /worktree\s+(add|remove|prune|list|lock|unlock)/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('creates a worktree from one application service only (M2-04 scope)', () => {
    // M2-03's version of this forbade calling the lifecycle at all, because
    // nothing was allowed to create a workspace yet. M2-04 builds the service
    // that does, so the rule becomes a location rule — which is the shape that
    // survives: one module owns preparation, and the milestones above it get a
    // prepared workspace rather than a Git API.
    //
    // The rest of the lifecycle is still nobody's. Removing, unlocking and
    // pruning a worktree belong to cleanup (M2-09) and are deliberately absent:
    // a failed attempt's worktree is retained, and the first module to delete
    // one should have to come and edit this list.
    // Two owners, and the distinction between them is the rule. The preparation
    // service creates an attempt's workspace and never reclaims one — a failed
    // attempt's worktree is the only copy of what its agent produced (§7.4).
    // `doctor`'s §8.4 probe creates a *throwaway* checkout that holds nothing
    // and removes it in a `finally`; it is the one place a removal is correct,
    // and it must go through Git rather than `rm -rf` (§20.2).
    // M2-06 adds the second preparer: the Integrator checks the integration
    // branch out, and re-creates that checkout when it is gone. The distinction
    // from an attempt worktree is the one §14.1 draws — a branch is the work and
    // a worktree is a checkout of it — which is why only this one is recreatable.
    const PREPARES = [
      'src/app/task-workspaces.ts',
      'src/app/integrator.ts',
      'src/cli/doctor.ts',
    ];
    // `unlock` and `prune` join `doctor`'s list for the Integrator, and only for
    // the recreation path: a locked registration whose directory is gone is not
    // pruned by Git, so `worktree add` refuses with "missing but locked worktree"
    // until it is cleared. Neither call can discard anything — both act on a
    // worktree that no longer exists on disk. `removeWorktree` stays the probe's
    // alone: an attempt worktree is the only remaining copy of what an agent
    // produced (§7.4), and the next milestone that wants to delete one has to
    // come and edit this list.
    // M2-09 is the milestone that reclaims, and this is the list it had to come and
    // edit — which was the point of keeping it at one module until then. The rules
    // that make it safe are not in this list, they are in the module: every path is
    // *derived* from run state and then intersected with what Git registered under
    // Agent Flow's own root, so a foreign worktree cannot be named at all (§20.2).
    const RECLAIMS = [
      'src/cli/doctor.ts',
      'src/app/integrator.ts',
      'src/app/namespace-reclaim.ts',
    ];
    const REMOVES = ['src/cli/doctor.ts', 'src/app/namespace-reclaim.ts'];
    // M2-05: the operations of the §11.2 sequence, in the one module that owns
    // it. Splitting them would give two answers to "which tree was validated",
    // and only one of them would be the one bound to a receipt.
    const RECORDS_EVIDENCE = ['src/app/attempt-receipt.ts'];
    // M2-06: the merge, in the one module that owns integration.
    const INTEGRATES = ['src/app/integrator.ts'];

    const offenders: string[] = [];
    for (const file of sourceFiles('src')) {
      const { path, text } = read(file);
      if (path.startsWith('src/adapters/git/')) continue;
      const code = codeOnly(text);

      if (!PREPARES.includes(path) && /\.addWorktree\s*\(/.test(code)) {
        offenders.push(`${path}: addWorktree`);
      }
      if (!REMOVES.includes(path) && /\.removeWorktree\s*\(/.test(code)) {
        offenders.push(`${path}: removeWorktree`);
      }
      for (const method of ['unlockWorktree', 'pruneWorktrees']) {
        if (!RECLAIMS.includes(path) && new RegExp(`\\.${method}\\s*\\(`).test(code)) {
          offenders.push(`${path}: ${method}`);
        }
      }
      for (const method of ['commitTree', 'updateRef', 'writeTree', 'stageAll']) {
        if (!RECORDS_EVIDENCE.includes(path) && new RegExp(`\\.${method}\\s*\\(`).test(code)) {
          offenders.push(`${path}: ${method}`);
        }
      }
      if (!INTEGRATES.includes(path) && /\.abortMerge\s*\(|\.merge\s*\(/.test(code)) {
        offenders.push(`${path}: merge`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('decides acceptance from Git, never from the agent’s prose (AR-05a, AD-39)', () => {
    // The security model, as a location rule. `filesChanged` used to be taken from
    // `parseResultBlock` — the model's own summary of its work — while Git held the
    // mechanical answer and was never asked. A run cannot claim "mechanical evidence over
    // model claims" while its record of what changed is a model claim.
    //
    // So the two decisions that gate completion are made in a pure module handed hashes and
    // paths, and the only place the agent's list may still be read is the field that
    // records it *as a claim*.
    const core = read(join(ROOT, 'src/core/acceptance.ts'));
    expect(core.text, 'the acceptance module reads the agent report').not.toMatch(
      /parseResultBlock|agentReport|claimedFilesChanged/,
    );

    const executor = codeOnly(read(join(ROOT, 'src/app/task-executor.ts')).text);

    // `report.filesChanged` survives in exactly three roles, and each one is a use of the
    // claim *as a claim* rather than as evidence:
    //
    //   1. the sequential fallback, where no workspace was cut and there is no tree to
    //      measure — the reported list is all that exists, and its status is legible from
    //      the absence of a `treeComparison` on the artifact;
    //   2. the divergence comparison, which is *about* the claim by definition;
    //   3. `claimedFilesChanged`, the field that records it.
    //
    // Named so a fourth use has to come and argue for itself. The number is the point: it
    // was five before the early-exit paths started asking Git too.
    const claimUses = [...executor.matchAll(/report\.filesChanged/g)].length;
    expect(claimUses, 'the agent’s file list is read in more places than AD-39 allows')
      .toBeLessThanOrEqual(3);

    // And the assertions themselves are not reimplemented at the call site.
    expect(executor).toMatch(/assertObservableChange|assertAcceptance/);
  });

  it('writes a task result from the executor and the Integrator only (M2-04, M2-06)', () => {
    // `TaskResult` is the record of *what ran*: a runner id, a model, a reasoning
    // level, the validation it went through. Only the module that actually ran
    // something can fill those in honestly, so only that module may write one.
    //
    // The rule exists because of a specific near-miss: the scheduler's workspace
    // refusal wants a value to return, and a `TaskResult` is right there. Filling
    // it in for an attempt where no runner was invoked would put a fiction in the
    // artifact recovery, the read models and the CLI all read as evidence — so a
    // refusal returns its own shape instead (`DispatchOutcome`), and this test
    // keeps the shortcut closed.
    //
    // M2-06 adds the second writer, and the split is §10.1's: the executor writes
    // `result.json` for a *sequential* run, where the task's outcome is decided
    // where it ran. In worktree mode it writes none at all — the outcome is
    // decided at integration, and the Integrator writes the file once the merge
    // has happened. Two writers, two modes, and neither can write the other's.
    const WRITERS = ['src/app/task-executor.ts', 'src/app/integrator.ts'];

    const offenders = sourceFiles('src')
      .map((file) => read(file))
      .filter(({ path }) => !WRITERS.includes(path) && path !== 'src/app/paths.ts')
      // `state-store.ts` reads one back; reading is not writing. M2-10's read model
      // does the same, for the one question only that file answers: whether an
      // attempt is validated and *not yet merged* (§21.2). It writes nothing.
      .filter(({ path }) => !['src/app/state-store.ts', 'src/server/run-reader.ts'].includes(path))
      .filter(({ text }) => /taskResult\s*\(/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);

    // Positive control: both writers still write, so the rule is guarding real
    // calls rather than names nothing uses any more.
    for (const writer of WRITERS) {
      expect(codeOnly(read(join(ROOT, writer)).text), writer).toMatch(/taskResult\s*\(/);
    }

    // And the scheduler does not build one. `TaskResultSchema` is how the fiction
    // would be assembled — parsed, so it would even look careful.
    const scheduler = codeOnly(read(join(ROOT, 'src/app/scheduler.ts')).text);
    expect(scheduler).not.toContain('TaskResultSchema');
  });

  it('completes a task from the Integrator only, in worktree mode (M2-06, I-3)', () => {
    // §26.1 rule 6, and the invariant the whole milestone turns on:
    //
    //   in worktree mode, attempt validated ≠ task completed.
    //
    // A task is completed when its marker has been merged, and one careless
    // `status: 'completed'` elsewhere makes that false *silently* — the DAG would
    // release dependents against an integration branch that does not contain
    // their dependency's work, and nothing would notice for three more tasks.
    //
    // The rule is on the literal rather than on behaviour, because "who may write
    // this value" is observable and "did you check the mode first" is not. The
    // scheduler passes it: it copies a `TaskState` the Integrator returned, and
    // never names one.
    const ASSIGNS = [
      'src/app/integrator.ts',
      // Judges an attempt and persists nothing. `judgeValidation` is where the
      // RED/GREEN expectation is evaluated, exactly once (I-4); the value it
      // returns describes one local execution, and something else decides what
      // the run does with it.
      'src/core/validation-outcome.ts',
    ];

    // Read with literals kept and comments stripped — the opposite of `codeOnly`,
    // which blanks exactly the thing this rule is looking for. `state` and not
    // `status`: the invariant is about `TaskProgress.state`, the field the DAG
    // reads to release a dependent. `TelemetryEntry.status` and the stage timeline
    // share the word and decide nothing about a task.
    const completes = (source: string): boolean =>
      /\bstate\s*:\s*'completed'/.test(source) || /(?<![=!<>])=\s*'completed'/.test(source);

    // A rule that cannot see the thing it forbids passes forever.
    expect(completes("states[id] = 'completed';")).toBe(true);
    expect(completes("return { ...task, state: 'completed' };")).toBe(true);
    expect(completes("if (states[id] !== 'completed') return;")).toBe(false);
    expect(completes('states[id] = outcome.state;')).toBe(false);

    const offenders = sourceFiles('src')
      .map(read)
      .filter(({ path }) => !ASSIGNS.includes(path))
      .filter(({ text }) => completes(withoutComments(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);

    // The positive control, and the write itself: `completed` and
    // `integrationHead` move in one `StateStore` update (§14.3 step 7). Splitting
    // them would create a second version of §17.3 window 7 for every merge.
    const integrator = withoutComments(read(join(ROOT, 'src/app/integrator.ts')).text);
    expect(integrator).toMatch(/\bstate:\s*'completed'/);
    expect(integrator).toMatch(
      /updateRun\([\s\S]{0,400}integrationHead:[\s\S]{0,400}state:\s*'completed'/,
    );
  });

  it('takes the integration order from core/dag.ts (M2-06, I-2, I-9)', () => {
    // §26.1 rule 11. Integration order is the plan's stable topological order,
    // restricted to the wave — never completion time, never Promise resolution
    // order, never a second sort the Integrator kept for itself. Two runs of the
    // same plan with the same agent outputs must produce the same branch shape,
    // and a merge order that depended on how fast each CLI responded that
    // afternoon would lose exactly that.
    const { text } = read(join(ROOT, 'src/app/integrator.ts'));
    const code = codeOnly(text);

    expect(importSpecifiers(text).some((specifier) => specifier.includes('core/dag'))).toBe(true);
    expect(code).toMatch(/topologicalOrder\s*\(/);
    // No ordering of its own. `.sort(` is the shape a second implementation takes.
    expect(code, 'the Integrator sorts something itself').not.toMatch(/\.sort\s*\(/);
  });

  it('orders integration with a promise, never a second lock (M2-06, §18.2)', () => {
    // Integration is serial within one process, and the process already holds the
    // run execution lease. A file lock to order two callbacks in one event loop
    // would be a syscall standing in for a promise — and a second locking
    // mechanism to keep in step with AF-L01, which is how two locks become no
    // lock at all. The `createExclusive` rule below covers the primitive; this
    // covers the shapes that would reintroduce it by another name.
    const code = codeOnly(read(join(ROOT, 'src/app/integrator.ts')).text);

    for (const mechanism of ['createExclusive', 'lockfile', 'RunExecutionLock', '.lock']) {
      expect(code, `the Integrator builds its own ${mechanism}`).not.toContain(mechanism);
    }
  });

  it('runs no validation command during integration (M2-06, §13.2)', () => {
    // The rejected design, pinned: collect every validation id from the wave, run
    // them all against the integration tree, require all to pass. It contradicts
    // `validationExpectation: 'fail'` — a task that is *supposed* to have a
    // failing id at the moment it completes — and re-judges an expectation
    // `judgeValidation` already evaluated exactly once, in the task's own
    // worktree, against that task's own base (I-4).
    //
    // Integration verifies mechanical Git integrity and nothing else. Whether the
    // finished tree is green is decided by the final `runVerification`, over the
    // whole integration tree, and that was already the only authority.
    const code = codeOnly(read(join(ROOT, 'src/app/integrator.ts')).text);

    for (const forbidden of [
      'runVerification',
      'runCommands',
      'judgeValidation',
      'buildValidationRegistry',
      'processRunner',
    ]) {
      expect(code, `the Integrator runs ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('forces a worktree removal from the throwaway probe and nowhere else (§7.4)', () => {
    // `git worktree remove --force` discards the working tree's contents. That is
    // correct for exactly one worktree in this milestone: the checkout §8.4's
    // probe made dirty on purpose, which holds nothing anybody needs and which
    // Git would otherwise refuse to reclaim, leaking one per `doctor` run.
    //
    // It is wrong everywhere else, and most wrong on an attempt worktree — the
    // only remaining copy of what an agent produced (§7.4). So the caller list is
    // one module, and the next milestone that wants this has to come and edit
    // this test rather than inherit a footgun.
    //
    // **M2-09 came and edited it, and the reason is structural rather than
    // convenient.** §11.2 stages the validated tree with `add -A` before the marker
    // is built, so *every* attempt worktree has an index that differs from its base
    // for the rest of its life — and Git refuses to remove any of them. Without
    // `force`, §20.3's `--worktrees` flag would be a no-op on every worktree it
    // names, and an integrated attempt's checkout could never be reclaimed at all.
    //
    // What keeps it safe is not the flag but the three things in front of it: the
    // path is *derived* from trusted run state, Git *confirms* it is registered under
    // Agent Flow's own root, and the content is either a duplicate of what the
    // integration branch already holds or something the user asked for by name. The
    // thing that would be *work* is the branch, and that is cleaned by a different
    // rule behind a different flag (§20.4).
    const FORCES = ['src/cli/doctor.ts', 'src/app/namespace-reclaim.ts'];
    // Scoped to a worktree removal on purpose. `force: true` is ordinary and
    // correct on a filesystem call — `node-file-system.ts` and `node-host.ts`
    // both pass it to `fs.rm` — and a rule that flagged those would be noise
    // someone eventually deletes.
    const FORCED_REMOVAL = /removeWorktree\s*\(\s*\{[^}]*force\s*:\s*true/;

    const offenders = sourceFiles('src')
      .map((file) => read(file))
      .filter(({ path }) => !path.startsWith('src/adapters/git/') && !FORCES.includes(path))
      .filter(({ text }) => FORCED_REMOVAL.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);

    // And the positive control: the rule is worth nothing if the pattern it
    // searches for no longer matches the one call it is meant to allow.
    expect(FORCED_REMOVAL.test(codeOnly(read(join(ROOT, 'src/cli/doctor.ts')).text))).toBe(true);

    // One `--force`, never two. Git needs it twice to remove a *locked* worktree,
    // and the lock is what protects a workspace an agent may be writing into
    // (§7.3). The adapter sends one, so a caller reaching for `force` to tidy up
    // still cannot delete a locked workspace.
    //
    // Read raw rather than through `codeOnly`, which blanks string literals — and
    // the argv *is* string literals here. The patterns are quoted-and-comma'd so
    // they cannot match the prose in the doc-comment that explains the rule.
    const adapter = read(join(ROOT, 'src/adapters/git/git-workspaces.ts')).text;
    expect(adapter).not.toMatch(/'--force'\s*,\s*'--force'/);
    expect(adapter).toMatch(/'remove'\s*,\s*'--force'/);
  });

  it('retains a failed attempt workspace rather than reclaiming it (§7.4)', () => {
    // A worktree in any state other than integrated is the only remaining copy
    // of what an agent produced. The preparation service must not tidy one away
    // to save disk — that would delete the evidence explaining the refusal.
    const { text } = read(join(ROOT, 'src/app/task-workspaces.ts'));
    const code = codeOnly(text);

    for (const reclaim of ['removeWorktree', 'unlockWorktree', 'pruneWorktrees', 'remove(']) {
      expect(code, `task-workspaces reclaims with ${reclaim}`).not.toContain(reclaim);
    }
  });

  it('reaches Git from the identity module through the adapter only', () => {
    // The preconditions read the repository, so this module is allowed to know
    // Git exists — through `GitWorkspaces`, never by building a command.
    const { text } = read(join(ROOT, 'src/app/run-git-identity.ts'));

    expect(codeOnly(text)).not.toMatch(/command:\s*'git'/);
    expect(importSpecifiers(text).filter((s) => s.includes('adapters/git'))).not.toEqual([]);
  });
});

describe('one module spawns git, and it isolates hooks (M2-02, I-7, S-8, S-12)', () => {
  // §26.1 rule 1. Before M2-02 there were three spawners — `git-client.ts`,
  // `discovery-cache.ts` and `doctor.ts`'s tool probe — and each was a place an
  // internal Git command could run with the user's hooks attached. `--no-verify`
  // would not have covered them: probed on Git 2.52.0, a `reference-transaction`
  // hook fires for a plain `git update-ref`, the flag does not exist there, and
  // the same is true of the `post-checkout` hook `git worktree add` runs.
  const SPAWNER = 'src/adapters/git/git-command.ts';

  it('builds a git command line in exactly one module', () => {
    const offenders = sourceFiles('src')
      .map(read)
      .filter(({ path }) => path !== SPAWNER)
      // Both shapes: the object literal a `ProcessRunner` takes, and passing
      // `'git'` as the executable argument of a helper — which is how the
      // `doctor` probe got there and how the next one would.
      .filter(({ text }) => /command:\s*'git'|\(\s*[\w.]+\s*,\s*'git'\s*,/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('injects an owned empty core.hooksPath, before the subcommand', () => {
    // Guards the rule above from passing vacuously, and pins the *position*.
    // Probed: with two `-c core.hooksPath=` flags on one command line the last
    // one wins, so "the safe value is somewhere in the argv" is not the
    // property — "no caller-supplied argument can be in a configuration
    // position" is. Git only reads configuration before the subcommand.
    const code = codeOnly(read(join(ROOT, SPAWNER)).text);

    expect(withoutComments(read(join(ROOT, SPAWNER)).text)).toMatch(/core\.hooksPath=/);
    expect(code).toMatch(/\.\.\.this\.safetyConfig\(\)[\s\S]*invocation\.subcommand[\s\S]*\.\.\.args/);
  });

  it('refuses configuration smuggled in as an operation argument', () => {
    // The §45 attack, pinned as a rule rather than only as a behaviour test:
    // the validator has to exist and has to be reached before argv is built.
    const code = withoutComments(read(join(ROOT, SPAWNER)).text);

    expect(code).toMatch(/assertOperationArgs\s*\(/);
    expect(code).toMatch(/git_unsafe_argument/);
  });

  it('uses --no-verify nowhere', () => {
    // §26.1 rule 8. It is not a weaker form of hook isolation; it covers a
    // different and smaller set, and reaching for it would mean the wrapper had
    // been bypassed by something that needed a per-command escape hatch.
    const offenders = sourceFiles('src')
      .map(read)
      .filter(({ text }) => /--no-verify/.test(withoutComments(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('uses git commit nowhere — commit-tree is the only commit maker', () => {
    // §26.1 rule 9, §12.1. `git commit` reads a checked-out index and runs
    // hooks, which would make a marker a function of whatever the worktree held
    // at that instant rather than of the tree that was validated.
    const offenders = sourceFiles('src')
      .map(read)
      .filter(({ text }) => /\bgit commit\b(?!-tree)|subcommand:\s*'commit'/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('owns every worktree operation in one adapter', () => {
    // One spawner and one workspace adapter (§42 of the M2-02 brief). Splitting
    // the operations across two modules would give two answers to "where does a
    // worktree path come from", and only one of them would be the one being
    // audited for containment.
    const offenders = sourceFiles('src')
      .map(read)
      .filter(({ path }) => path !== 'src/adapters/git/git-workspaces.ts')
      .filter(({ text }) => /'worktree',?\s*$|args:\s*\[\s*'add'/m.test(codeOnly(text)))
      .filter(({ path }) => path !== 'src/adapters/git/git-command.ts')
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('sanitises the Git environment only at the Git boundary', () => {
    // `unsetEnv` exists for one reason — an inherited `GIT_DIR` relocates a
    // repository regardless of `cwd`, and there is no value that reads as unset
    // (probed: `GIT_DIR=` fails with `not a git repository: ''`). It is a sharp
    // tool: a module that started removing variables from a coding agent's
    // environment would be breaking the authentication those CLIs depend on,
    // which is the one thing §54 says must keep working.
    const users = sourceFiles('src')
      .map(read)
      .filter(({ text }) => /\bunsetEnv\b/.test(codeOnly(text)))
      .map(({ path }) => path)
      .sort();

    expect(users).toEqual([
      'src/adapters/git/git-command.ts',
      // Declares it, and implements the removal.
      'src/adapters/process/node-process-runner.ts',
      'src/ports/process-runner.ts',
    ]);
  });

  it('removes the inherited variables rather than blanking them', () => {
    const code = withoutComments(read(join(ROOT, SPAWNER)).text);

    expect(code).toMatch(/GIT_HOSTILE_ENVIRONMENT/);
    expect(code).toMatch(/GIT_DIR/);
    expect(code).toMatch(/GIT_INDEX_FILE/);
    // The workaround that does not work, pinned so it cannot come back.
    expect(code).not.toMatch(/GIT_DIR:\s*''/);
    expect(code).not.toMatch(/GIT_DIR=['"]{2}/);
  });

  it('derives every worktree path from a validated location, never from a caller', () => {
    // S-3 and D-F02. `startsWith` is the wrong primitive — `/foo/bar2` starts
    // with `/foo/bar` and is not inside it — and on Windows it matches nothing
    // at all, which is a boundary that silently permits everything.
    const { text } = read(join(ROOT, 'src/adapters/git/git-workspaces.ts'));
    const code = codeOnly(text);

    expect(importSpecifiers(text)).toContain('node:path');
    expect(code).toMatch(/resolveWithinRoot\s*\(/);
    expect(code).toMatch(/\.relative\(/);
    expect(code).not.toMatch(/startsWith\(\s*root/);
    // S-4: ownership is decided on resolved locations. A registered path is a
    // string Git recorded, and the directory it names today may be a symlink to
    // somewhere else — which matters because the answer authorises a removal.
    expect(code).toMatch(/realPath\s*\(/);
  });
});

describe('the isolation policy is decided in core, and switched on by nobody yet (M2-01)', () => {
  // M2-01 lands the *naming* half of MVP 2: what a worktree, a branch and a run
  // namespace are called. Nothing creates one, nothing asks Git anything, and no
  // execution path resolves more than one concurrent task. Every rule here exists
  // because the cheapest way to break that is to land the next milestone by
  // accident — a helper here, a second argument there.
  const POLICY = 'src/core/worktree-policy.ts';
  const RESOLVER = 'src/core/concurrency.ts';

  it('keeps the policy free of anything that could look at a machine', () => {
    const { text } = read(join(ROOT, POLICY));
    const code = codeOnly(text);

    // Not a paraphrase of "src/core imports no Node built-in" — that rule is
    // about imports, and this module could reach the filesystem through a port
    // handed to it. It takes no dependencies at all, and that is the property.
    for (const forbidden of [
      'readFile',
      'writeFile',
      'readdir',
      'realpath',
      'existsSync',
      'spawn',
      'execFile',
      'process.',
      'createHash',
      'Math.random',
      'Date.now',
    ]) {
      expect(code, `${POLICY} reaches for ${forbidden}`).not.toContain(forbidden);
    }

    // Contracts only. A port, an adapter or an app module would each be a way for
    // an answer to depend on something other than its arguments.
    for (const specifier of importSpecifiers(text)) {
      expect(specifier, `${POLICY} imports ${specifier}`).toMatch(/^\.\.\/contracts\//);
    }
  });

  it('spawns no Git command from the policy', () => {
    const code = codeOnly(read(join(ROOT, POLICY)).text);

    expect(code).not.toMatch(/\bgit\b/i);
    expect(code).not.toMatch(/command:\s*/);
  });

  it('resolves an absolute path nowhere in core', () => {
    // The worktree root is `~/.agent-flow/worktrees`, resolved by the `Host` port
    // in an adapter. A core module that named it would be deciding a machine fact
    // from the one layer that cannot observe one — and §7.2's guarantee that no
    // absolute path is ever persisted would rest on a habit instead of a shape.
    const offenders = sourceFiles('src/core')
      .map(read)
      .filter(({ text }) => /\.agent-flow\/worktrees|homedir|os\.homedir/.test(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('grants the isolated ceiling from the run, and from nowhere else (I-11, M2-11)', () => {
    // Until M2-11 this rule read the other way round: *no* production caller may
    // pass the mode, because the capability existed since M2-01 and the machinery
    // that makes it safe did not. M2-11 is the milestone that came and edited it,
    // and the replacement is not weaker — it names the exact source the mode may
    // come from.
    //
    // Three modules pass it, and the third is the one worth arguing about.
    // `execution-context` and `run-reader` pass `state.isolationMode`: the run's
    // own captured mode, which is what makes the number the same in the scheduler
    // and on the page. `config-reader` passes a literal, because it is answering a
    // *hypothetical* — "what would this configuration do to a run created now" —
    // on a page that has no run to read a mode from, and it decides nothing about
    // any existing one.
    const passesTheMode = (source: string): boolean =>
      /resolveTaskConcurrency\s*\([^)]*,/.test(codeOnly(source));

    // A rule that cannot see the thing it governs passes forever. The literal is
    // blanked by `codeOnly`, so the detection is on the argument, not its value.
    expect(passesTheMode("resolveTaskConcurrency(config.parallelism.maxTasks, 'worktree')")).toBe(
      true,
    );
    expect(passesTheMode('resolveTaskConcurrency(config.parallelism.maxTasks, mode)')).toBe(true);
    expect(passesTheMode('resolveTaskConcurrency(config.parallelism.maxTasks)')).toBe(false);

    const ALLOWED = new Set([
      'src/app/execution-context.ts',
      'src/server/run-reader.ts',
      'src/server/config-reader.ts',
    ]);

    const callers = sourceFiles('src')
      .map(read)
      // The resolver's own signature is where the second parameter is declared.
      .filter(({ path }) => path !== RESOLVER)
      .filter(({ text }) => passesTheMode(text))
      .map(({ path }) => path);

    expect(callers.filter((path) => !ALLOWED.has(path))).toEqual([]);

    // And the two that decide a real run's width take it from the run. A module
    // that named the mode itself would be assigning what §6.1 captured, which is
    // I-13 with the safety catch filed off.
    for (const path of ['src/app/execution-context.ts', 'src/server/run-reader.ts']) {
      const code = codeOnly(read(join(ROOT, path)).text);
      expect(code, `${path} does not take the mode from the run`).toMatch(/isolationMode/);
    }
  });

  it('decides a run\'s isolation in one module, and compares it everywhere else (M2-03)', () => {
    // Until M2-03 nothing could put a run into worktree mode, so the rule was
    // that the word may not appear outside the two modules defining it. M2-03 is
    // the milestone that changes that, and the replacement rule is the one that
    // will still be true in M2-11: exactly one module *assigns* the mode, and
    // everyone else *reads* `state.isolationMode`.
    const ASSIGNS = 'src/app/run-git-identity.ts';

    // Read raw with comments stripped: `codeOnly` blanks string literals, and a
    // string literal is exactly what this rule is looking for.
    const literals = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

    const declaresIsolated = (source: string): boolean => /'worktree'|"worktree"/.test(literals(source));

    expect(declaresIsolated("const mode = 'worktree';")).toBe(true);
    expect(declaresIsolated("// one day this will be 'worktree'\nconst mode = 'none';")).toBe(false);

    const allowed = new Set([
      'src/contracts/common.schema.ts',
      // M2-10: the read model's `IsolationView` names the three values a *reader*
      // sees, where the stored field has two — `legacy` is the absent case,
      // projected (§21.2, §25.2). A type declaration decides nothing.
      'src/contracts/api.schema.ts',
      RESOLVER,
      POLICY,
      ASSIGNS,
      // The Git adapter, where `'worktree'` is the name of a Git subcommand.
      'src/adapters/git/git-command.ts',
      'src/adapters/git/git-workspaces.ts',
      // Comparisons against the run's recorded mode — never an assignment.
      'src/app/run-actions.ts',
      'src/app/execution-context.ts',
      'src/app/task-workspaces.ts',
      // M2-06: `prepare` and `openForReview` both answer `sequential` for a run
      // whose recorded mode is not `worktree`, so the mode is decided by the run
      // rather than by whether an Integrator happens to be wired.
      'src/app/integrator.ts',
      // M2-10: `status` asks whether a run is isolated so it can print §21.4's
      // ISOLATION block, and prints nothing at all when it is not — a sequential run
      // is not shown machinery its user never turned on.
      'src/cli/status.ts',
      // M2-10: the read model asks whether a run is isolated so it can *render* the
      // facts §21.2 lists — a live workspace, an attempt awaiting integration. It
      // never decides the mode, and it never asks the configuration for it.
      'src/server/run-reader.ts',
      // M2-09: reclamation asks the run whether it *has* a namespace at all. A
      // sequential or legacy run has none, so there is nothing Git to reclaim and
      // its state is removable — which is how `clean` keeps behaving exactly as it
      // always has for every run that predates isolation (§25).
      'src/app/namespace-reclaim.ts',
      // M2-11: the configuration page names the mode because it is answering a
      // hypothetical — what a run created *now* would get — on the one page that
      // has no run to read `isolationMode` from. It assigns nothing and changes no
      // existing run, which is the distinction this rule is drawn on.
      'src/server/config-reader.ts',
    ]);

    const offenders = sourceFiles('src')
      .map(read)
      .filter(({ path }) => !allowed.has(path))
      .filter(({ text }) => declaresIsolated(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('compares rather than assigns, everywhere but the deciding module', () => {
    // What keeps the exemption above honest. A module that reads
    // `state.isolationMode !== 'worktree'` is doing the right thing; one that
    // writes `isolationMode:` is claiming an authority only `createRun` has.
    const offenders: string[] = [];

    for (const file of sourceFiles('src')) {
      const { path, text } = read(file);
      if (path === 'src/app/run-git-identity.ts') continue;
      // The store persists what it is handed, and the contract declares it.
      if (path === 'src/app/state-store.ts' || path === 'src/contracts/state.schema.ts') continue;

      if (/isolationMode\s*:/.test(codeOnly(text))) offenders.push(path);
    }

    expect(offenders).toEqual([]);
  });

  it('lets no production path create a run without its Git identity (M2-03)', () => {
    // `createRun`'s identity argument is optional so that the ~90 fixtures that
    // do not care about Git keep working — they get the legacy shape, which is
    // exactly what a run created before MVP 2 looks like. That convenience must
    // not extend to production: a *new* run without an `isolationMode` would be
    // indistinguishable from a run that predates the question, and §25.2 says
    // nothing may ever promote one of those.
    //
    // So the rule is not "the parameter is required" — it is "every production
    // caller passes it", which is checkable and does not cost the fixtures.
    const callers = sourceFiles('src')
      .map(read)
      .filter(({ path }) => path !== 'src/app/state-store.ts')
      .filter(({ text }) => /\.createRun\s*\(/.test(codeOnly(text)));

    // There is one, and if a second appears it has to come and satisfy this too.
    expect(callers.map(({ path }) => path)).toEqual(['src/cli/feature.ts']);

    for (const { path, text } of callers) {
      const code = codeOnly(text);
      // The call passes a second argument, and that argument composes an
      // identity rather than inventing one.
      expect(code, `${path} creates a run with no identity`).toMatch(
        /\.createRun\s*\([^)]*,\s*\(runId\)/,
      );
      expect(code, `${path} does not compose the identity`).toMatch(/composeRunIdentity/);
      expect(code, `${path} does not resolve the identity first`).toMatch(/resolveRunGitIdentity/);
    }
  });

  it('composes a run identity only where the identity is decided', () => {
    // Guards the rule above from being satisfied by a caller that assembles the
    // three fields itself — which would be a second answer to "what mode is this
    // run in", and the one nobody audits.
    const users = sourceFiles('src')
      .map(read)
      .filter(({ text }) => /composeRunIdentity|resolveRunGitIdentity/.test(codeOnly(text)))
      .map(({ path }) => path)
      .sort();

    expect(users).toEqual(['src/app/run-git-identity.ts', 'src/cli/feature.ts']);
  });

  it('keeps the run identity out of every request contract (I-8)', () => {
    // The browser sends ids. A request that carried a `gitRunKey` or a
    // `planningBase` would let a caller name the namespace a run writes into,
    // or the commit it claims to have been planned against.
    const contracts = read(join(ROOT, 'src/contracts/api.schema.ts')).text;
    const requests = contracts.slice(0, contracts.indexOf('// Responses'));

    for (const field of ['gitRunKey', 'planningBase', 'isolationMode', 'integrationHead']) {
      expect(requests, `a request accepts ${field}`).not.toMatch(new RegExp(`${field}\\s*:`));
    }
  });

  it('keeps Git out of the StateStore (I-1)', () => {
    // The store persists an opaque, schema-validated string and knows nothing
    // about refs. The day it runs a Git command, `state.json` has become a second
    // index and the repository a second source of truth.
    const { text } = read(join(ROOT, 'src/app/state-store.ts'));

    expect(codeOnly(text)).not.toMatch(/\bgit\b/i);
    expect(importSpecifiers(text).filter((s) => s.includes('adapters/git'))).toEqual([]);
  });

  it('writes the attempt artifact from one module only (M2-05)', () => {
    // Until M2-05 this read "writes no attempt artifact yet", because a writer
    // appearing before the receipt machinery would have put a file on disk
    // claiming evidence nothing produced. M2-05 builds that machinery, so the
    // rule becomes a location rule — the shape that survives the milestone.
    //
    // One module composes the artifact, and one path on disk holds it. The
    // executor supplies the facts and is not on this list: it hands a draft to
    // `recordAttempt` and never assembles a `TaskAttemptResult` itself, which is
    // what keeps the receipt out of reach of everything that merely knows what a
    // task did.
    const allowed = new Set([
      'src/contracts/attempt.schema.ts',
      'src/contracts/index.ts',
      'src/app/attempt-receipt.ts',
    ]);

    const offenders = sourceFiles('src')
      .map(read)
      .filter(({ path }) => !allowed.has(path))
      .filter(
        ({ text }) =>
          /AttemptReceipt\b/.test(codeOnly(text)) ||
          importSpecifiers(text).some((specifier) => specifier.includes('attempt.schema')),
      )
      .map(({ path }) => path);

    expect(offenders).toEqual([]);

    // Parsing an attempt artifact back is a different act from composing one, and AR-08's
    // per-task history needs it: every fact about what an earlier attempt did lives in
    // these files and nowhere else. So the schema may be *read* by one named read model —
    // which is held, right here, to writing nothing.
    const readers = sourceFiles('src')
      .map(read)
      .filter(({ path }) => !allowed.has(path))
      .filter(({ text }) => /TaskAttemptResultSchema|FailedAttemptSchema/.test(codeOnly(text)))
      .map(({ path }) => path);

    // Two, with different jobs. `task-executor.ts` authors the *failed* attempt — the
    // receipt module owns success and only success — and `run-reader.ts` reads both back.
    expect(readers.sort()).toEqual(['src/app/task-executor.ts', 'src/server/run-reader.ts']);

    // The reader is held to reading. `safeParse` and nothing else: one that could `parse`
    // would take the whole task view down on a single half-written artifact, and one that
    // could write would be a second author of the evidence this milestone treats as
    // authoritative.
    const reader = codeOnly(read(join(ROOT, 'src/server/run-reader.ts')).text);
    expect(reader, 'the read model writes an attempt artifact').not.toMatch(
      /writeFile|recordAttempt|AttemptReceipt/,
    );
    expect(reader, 'the read model parses an attempt strictly').not.toMatch(
      /(?:TaskAttemptResultSchema|FailedAttemptSchema)\.parse\b/,
    );

    // And the path is composed in `paths.ts`, like every other artifact — so
    // "the artifact lives outside every worktree" is a property of one function
    // rather than of a string somebody wrote next to a `writeFileAtomic`.
    const writer = codeOnly(read(join(ROOT, 'src/app/attempt-receipt.ts')).text);
    expect(writer).toMatch(/taskAttempt\s*\(/);
    expect(writer, 'the artifact writer builds a path itself').not.toMatch(/attempt-\$\{/);
  });

  it('mints the receipt nonce from the machine, after the tree exists (M2-05, §11.2)', () => {
    // Two properties of the sequence, both checkable in the file that owns it.
    //
    // The source: 128 bits that decide whether an agent could have known the
    // nonce. `Math.random` behind the same signature would look unpredictable and
    // would not be, and the failure would be invisible.
    //
    // The order: `stageAll` → `writeTree` → `randomHex`. A nonce generated one
    // line earlier is a nonce that existed while the agent's process could still
    // be running, which is the entire threat §11.1 describes.
    const { text } = read(join(ROOT, 'src/app/attempt-receipt.ts'));
    const code = codeOnly(text);

    expect(code).toMatch(/host\.randomHex\s*\(/);
    expect(code, 'the nonce comes from a non-cryptographic source').not.toMatch(/Math\.random/);
    expect(code).toMatch(/stageAll[\s\S]*writeTree[\s\S]*randomHex/);
  });

  it('dates the marker from the artifact, never from the clock (M2-05, §12.2)', () => {
    // The determinism the whole recovery design rests on: every input to
    // `commit-tree` is read out of the persisted artifact, so re-running it after
    // a crash yields the same commit id and `update-ref` is idempotent for free.
    // A `clock.now()` anywhere in the marker's construction breaks that, and
    // breaks it in the direction where nothing fails and two commits exist.
    const { text } = read(join(ROOT, 'src/app/attempt-receipt.ts'));
    const code = codeOnly(text);

    const marker = code.slice(code.indexOf('export async function publishMarker'));

    expect(marker).toMatch(/receipt\.issuedAt/);
    expect(marker, 'the marker is dated from the clock').not.toMatch(/clock\.now/);
    expect(marker, 'the marker is dated from the system clock').not.toMatch(/new Date|Date\.now/);
    // Fixed identity, and not the user's. A marker attributed to a person is a
    // statement that is not true, and `user.name` would also make the commit id
    // a function of the machine it was produced on.
    expect(code).toMatch(/MARKER_IDENTITY/);
    // Read with literals kept, because the identity *is* a literal.
    expect(withoutComments(text)).toMatch(/agent-flow@local/);
  });

  it('keeps the evidence module out of scheduling, integration and recovery (M2-05)', () => {
    // The module decides what is true about one attempt. It does not decide what
    // the run does next — and the cheapest way to lose that boundary is a single
    // import that looks convenient on the day.
    const { text } = read(join(ROOT, 'src/app/attempt-receipt.ts'));

    const forbidden = importSpecifiers(text).filter((specifier) =>
      ['scheduler', 'integrator', 'state-store', 'task-workspaces', 'run-actions'].some((module) =>
        specifier.includes(module),
      ),
    );

    expect(forbidden).toEqual([]);
  });
});

describe('crash recovery orchestrates, and owns nothing else (M2-07, §17)', () => {
  const RECOVERY = 'src/app/worktree-recovery.ts';

  it('reads the attempt artifact before it reads any ref (§26.1 rule 5, I-5)', () => {
    // The rule the whole milestone turns on, and the one shape a review has to be
    // able to recognise: *the ref exists and looks like a marker, so trust it*. That
    // trusts text an agent with a shell in a worktree can write.
    //
    // Checked as an ordering within the file, because "receipt-first" is an order
    // rather than a set of calls. `readAttempt` must appear before the first ref
    // read, and the tree binding must be named at all.
    // **Call forms, not bare names.** `readAttempt` also appears in the import
    // block at the top of the file, so a rule written against the name would be
    // satisfied by the import and would pass however the body was ordered — which
    // is the "green test proving nothing" shape §28 warns about.
    const code = codeOnly(read(join(ROOT, RECOVERY)).text);

    const artifact = code.indexOf('readAttempt(');
    expect(artifact, 'recovery never calls readAttempt').toBeGreaterThan(-1);

    for (const refRead of [
      '.revParse(',
      '.isAncestor(',
      '.refsUnder(',
      '.readCommit(',
      '.objectExistsAs(',
      '.mergeHead(',
      'publishMarker(',
    ]) {
      const at = code.indexOf(refRead);
      if (at === -1) continue;
      expect(at, `recovery calls ${refRead} before it reads the artifact`).toBeGreaterThan(artifact);
    }

    // The rule can see what it forbids: both call forms are really in the file.
    expect(code).toContain('.revParse(');
    expect(code).toContain('.objectExistsAs(');

    // And it binds to the tree rather than to a name.
    expect(code).toMatch(/validatedTree/);
  });

  it('runs no validation command and invokes no coding agent', () => {
    // §13.2 for the Integrator, and the same rule here for the same reason: the
    // expectation was judged exactly once, inside the task's own worktree, against
    // that task's own base (I-4). Recovery trusts durable validated evidence — a
    // recovery that re-ran `lint · test · build` would be re-judging an expectation
    // and would make a `validationExpectation: 'fail'` task fail its own recovery.
    const code = codeOnly(read(join(ROOT, RECOVERY)).text);

    for (const forbidden of [
      'runVerification',
      'runCommands',
      'judgeValidation',
      'buildValidationRegistry',
      'processRunner',
      'stageRunner',
      'StageRunner',
      'TaskExecutor',
      'getRunner',
    ]) {
      expect(code, `recovery reaches ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('merges nothing, creates no worktree and publishes through the evidence module', () => {
    // Recovery is orchestration. `git merge` and `git merge --abort` stay in the one
    // module §26.1 allows them in, the worktree lifecycle stays with its two owners,
    // and the marker is rebuilt through `publishMarker` — the function whose
    // determinism is the guarantee (§12.2) — rather than by a second `commit-tree`
    // that could drift from it.
    const code = codeOnly(read(join(ROOT, RECOVERY)).text);

    for (const forbidden of [
      '.merge(',
      '.abortMerge(',
      '.addWorktree(',
      '.removeWorktree(',
      '.unlockWorktree(',
      '.pruneWorktrees(',
      '.commitTree(',
      '.updateRef(',
      '.writeTree(',
      '.stageAll(',
    ]) {
      expect(code, `recovery calls ${forbidden} itself`).not.toContain(forbidden);
    }

    // The positive control: it does rebuild markers, through the allowed door.
    expect(code).toMatch(/publishMarker\s*\(/);
  });

  it('never writes completed, and never composes a TaskResult', () => {
    // I-3, and §26.1 rule 6: in worktree mode a task is completed by the Integrator
    // and by nothing else. Recovery copies the state it is handed back — one
    // careless literal here and the DAG would release dependents against a branch
    // that does not contain their dependency's work.
    const source = withoutComments(read(join(ROOT, RECOVERY)).text);

    expect(source, 'recovery assigns completed').not.toMatch(/\bstate:\s*'completed'/);
    expect(source, 'recovery assigns completed').not.toMatch(/(?<![=!<>])=\s*'completed'/);
    expect(source, 'recovery composes a task result').not.toContain('TaskResultSchema');
    expect(codeOnly(read(join(ROOT, RECOVERY)).text)).not.toMatch(/taskResult\s*\(/);
  });

  it('takes no lock of its own', () => {
    // It runs inside the process that holds the run execution lease (§17.2, §18.2).
    // A second mechanism would be one more thing to keep in step with AF-L01, which
    // is how two locks become no lock at all.
    const code = codeOnly(read(join(ROOT, RECOVERY)).text);

    for (const mechanism of ['createExclusive', 'lockfile', 'RunExecutionLock', '.lock']) {
      expect(code, `recovery builds its own ${mechanism}`).not.toContain(mechanism);
    }
  });

  it('decides nothing from a commit subject or a trailer it parsed itself', () => {
    // M2-06 made the parent count the structural discriminator, and §17.1 forbids
    // trusting a message. Recovery must not grow its own trailer parser or match on
    // a subject: the binding is the Integrator's, and duplicating half of it here is
    // how two readings of one commit start to disagree.
    const source = withoutComments(read(join(ROOT, RECOVERY)).text);

    expect(source, 'recovery matches on a commit subject').not.toContain('agent-flow:');
    expect(source, 'recovery parses trailers').not.toContain('parseTrailers');
    expect(source, 'recovery reads a trailer').not.toContain('Agent-Flow-');
  });

  it('is reached from the scheduler and the wiring, and from nowhere else', () => {
    // One recovery path, entered once, before the first wave (§17.2, I-2). A second
    // entry point would be a second answer to "has this run been reconciled", and
    // the two could disagree about whether a merge had already been recorded.
    const ALLOWED = ['src/app/scheduler.ts', 'src/app/execution-context.ts'];

    const importers = sourceFiles('src')
      .map(read)
      .filter(({ path }) => path !== RECOVERY)
      .filter(({ text }) =>
        importSpecifiers(text).some((specifier) => specifier.includes('worktree-recovery')),
      )
      .map(({ path }) => path);

    expect(importers.filter((path) => !ALLOWED.includes(path))).toEqual([]);
    // Positive control: both allowed importers really do import it, so the rule is
    // guarding real edges rather than a name nothing uses.
    expect([...importers].sort()).toEqual([...ALLOWED].sort());
  });

  it('keeps the scheduler free of the Git adapter, still (§26.1 rule 2)', () => {
    // The scheduler gained a collaborator, and the collaborator talks to Git. The
    // rule that matters is that the scheduler does not: it holds `RunRecovery` as a
    // type, exactly as it holds `WaveIntegrator`.
    const { text } = read(join(ROOT, 'src/app/scheduler.ts'));

    expect(importSpecifiers(text).filter((specifier) => specifier.includes('adapters/git'))).toEqual(
      [],
    );
    expect(codeOnly(text)).not.toMatch(/command:\s*'git'/);
  });
});

describe('state writes are serialised where they happen (M2-00.1)', () => {
  // `updateRun` is a read-modify-write, and two of them interleaving lose an
  // update that the §22 machine cannot catch — each transition, seen alone, is
  // legal. Concurrency is one today, so the store's correctness rests on a fact
  // about one caller. These rules keep the fix where callers inherit it.

  it('serialises inside the StateStore rather than at its callers', () => {
    const { text } = read(join(ROOT, 'src/app/state-store.ts'));
    expect(codeOnly(text)).toMatch(/serializeStateWrite\s*\(/);
  });

  it('keeps the §22 machine in the store, next to the serialisation', () => {
    // The two are complementary. Moving the transition guard back out to callers
    // to make room for the queue would trade one unenforceable policy for another.
    const { text } = read(join(ROOT, 'src/app/state-store.ts'));
    expect(codeOnly(text)).toMatch(/assertLegalTransitions\s*\(/);
  });

  it('keys the queue on the state file, not on the run id', () => {
    // Run ids are per project and reset each year, so `AF-2026-001` exists in as
    // many repositories as you like — and one server process serves all of them.
    // A queue keyed on the id would make two unrelated projects wait on each
    // other, which is a global lock wearing a local name.
    const { text } = read(join(ROOT, 'src/app/state-store.ts'));
    expect(codeOnly(text)).toMatch(/serializeStateWrite\(\s*runPaths\([^)]*\)\.state/);
  });

  it('adds no filesystem lock to do it', () => {
    // Every writer is already under one execution lease. A file lock to order two
    // callbacks in one event loop would be a syscall standing in for a promise —
    // and a second locking mechanism to keep in step with AF-L01.
    const { text } = read(join(ROOT, 'src/app/state-write-queue.ts'));
    const code = codeOnly(text);
    expect(code).not.toMatch(/createExclusive|\.lock/);
  });
});

describe('the write API is an adapter, not a second workflow (UI-27, §60)', () => {
  // The rules the final architectural review of UI-B checks for by hand, written
  // down so they hold in six months instead of on the day somebody looked. Every
  // one of them maps to a way the browser and the CLI could start enforcing the
  // workflow separately, which is the failure that would be silent.

  const serverText = (): string => codeOnly(read(join(ROOT, 'src/server/server.ts')).text);

  it('has no HTTP handler that writes state directly', () => {
    // A handler that called `updateRun`, `appendEvent` or `writeArtifact` would be
    // the parallel state machine §60 forbids. Every write goes through a use case.
    const code = serverText();

    for (const writer of ['updateRun', 'appendEvent', 'writeArtifact', 'setCurrentRun']) {
      expect(code, `server.ts calls ${writer} directly`).not.toContain(`${writer}(`);
    }
  });

  it('decides no approval of its own', () => {
    // `checkApproval`, `planHash`, `approveRun` and `FORCIBLE_REFUSALS` live in
    // `app/approval.ts` and are reached only through `app/run-actions.ts`. A server
    // that imported them would be a second implementation of the gate.
    const offenders = sourceFiles('src/server')
      .map(read)
      .filter(({ text }) => importSpecifiers(text).some((s) => s.includes('app/approval')))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('reimplements neither the scheduler nor the dependency graph', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles('src/server')) {
      const { path, text } = read(file);
      const bad = importSpecifiers(text).filter(
        (specifier) =>
          specifier.includes('app/scheduler') ||
          specifier.includes('core/dag') ||
          specifier.includes('app/task-executor'),
      );
      if (bad.length > 0) offenders.push(`${path}: ${bad.join(', ')}`);
    }

    expect(offenders).toEqual([]);
  });

  it('never accepts a plan hash from a client', () => {
    // The property §90 turns on. `ApproveRequestSchema` is the only shape the
    // approve endpoint will act on, and a hash is not in it — so there is no request
    // that could get a caller-chosen hash credited with an approval.
    const contracts = read(join(ROOT, 'src/contracts/api.schema.ts')).text;
    const requestSection = contracts.slice(
      contracts.indexOf('// Write requests'),
      contracts.indexOf('// Responses'),
    );

    expect(requestSection).toContain('ApproveRequestSchema');
    for (const forbidden of ['planHash', 'path', 'command', 'cwd']) {
      expect(requestSection, `a write request accepts ${forbidden}`).not.toMatch(
        new RegExp(`${forbidden}\\s*:`, 'i'),
      );
    }
  });

  it('accepts no filesystem path anywhere in the request contracts', () => {
    // Ids, never locations — for projects, runs, tasks, prompts and jobs alike.
    const contracts = read(join(ROOT, 'src/contracts/api.schema.ts')).text;
    const schemas = contracts.slice(0, contracts.indexOf('// Responses'));

    // Every request schema validates against one of these, and none of them is a
    // path. `z.string()` on its own would be, which is why the assertion is on the
    // absence of an unconstrained string rather than on the presence of a regex.
    expect(schemas).not.toMatch(/z\.string\(\)\s*[,)}]/);
  });

  it('exposes no worktree path in any response contract (§21.3, §26.1 rule 4)', () => {
    // The other half of an **asymmetric** rule, and the asymmetry is the point.
    // Ref names and object ids MAY appear in a response: they are provenance a
    // person needs — §19.3 prints the integration branch and tells them to merge
    // it — and the server never accepts one back. A *worktree* path is different
    // in kind: the attempt artifact deliberately stores a workspace-relative path
    // (§7.2) precisely so that no layer above it has an absolute one to leak, and
    // M2-10's stated trap is the temptation to resolve it "just for debugging".
    //
    // Written as an allowlist over field *names* rather than a search for the
    // word "worktree", because the field that would leak this is far more likely
    // to be called `workspacePath` than to name the mechanism. A new path-shaped
    // field therefore fails here and has to be argued for, which is the only kind
    // of rule that survives a milestone.
    const contracts = read(join(ROOT, 'src/contracts/api.schema.ts')).text;
    const responses = contracts.slice(contracts.indexOf('// Responses'));

    const ALLOWED = new Set([
      // The project directory the operator pointed the server at, read-only. Not
      // a worktree, and not something an endpoint accepts back.
      'path',
      // Repository-relative, as `git diff --name-only` reports them (§15, §21.2).
      'paths',
      'files',
      'filesChanged',
      // Which configuration files were read, on the page about configuration.
      'globalPath',
      'projectPath',
    ]);

    const PATH_SHAPED = /^(.*(?:path|dir|cwd|location|root)s?|files?(?:Changed)?)$/i;

    const declared = [...responses.matchAll(/readonly\s+([A-Za-z][A-Za-z0-9]*)/g)].map(
      (match) => match[1] as string,
    );

    const offenders = [
      ...new Set(declared.filter((name) => PATH_SHAPED.test(name) && !ALLOWED.has(name))),
    ];

    // A rule that cannot see what it forbids passes forever.
    expect(PATH_SHAPED.test('workspacePath')).toBe(true);
    expect(PATH_SHAPED.test('worktreeDir')).toBe(true);
    expect(PATH_SHAPED.test('integrationBranch')).toBe(false);
    expect(PATH_SHAPED.test('marker')).toBe(false);

    expect(offenders).toEqual([]);
  });

  it('names no runner, model or provider in the server', () => {
    // The core knows no provider (§3, §58) and neither does the layer above it. A
    // server that branched on "codex" would have to be edited to add a runner.
    const forbidden = ['claude', 'codex', 'anthropic', 'openai', 'gpt-', 'opus', 'sonnet'];
    const offenders: string[] = [];

    for (const file of sourceFiles('src/server')) {
      const { path, text } = read(file);
      const haystack = codeOnly(text).toLowerCase();
      const hits = forbidden.filter((needle) => haystack.includes(needle));
      if (hits.length > 0) offenders.push(`${path}: ${hits.join(', ')}`);
    }

    expect(offenders).toEqual([]);
  });

  it('exposes no pause, resume or cancel while the core has no semantics for them', () => {
    // §86 lists all three. `RUN_STATUSES` has no paused or cancelled and the
    // scheduler cannot be interrupted, so an endpoint would have to fake it. This
    // test is the thing that will fail when somebody adds one without the semantics.
    const code = serverText();

    for (const action of ['pause', 'resume', 'cancel']) {
      expect(code, `the server routes /${action}`).not.toContain(`/${action}'`);
    }
  });

  it('keeps every use case reachable from both adapters', () => {
    // The CLI must not have grown its own copy of a use case. Each of these is
    // imported from `app/run-actions.ts` by both the CLI and the server, and the
    // test fails if either side stops going through it.
    const cli = sourceFiles('src/cli')
      .map(read)
      .filter(({ text }) => importSpecifiers(text).some((s) => s.includes('app/run-actions')))
      .map(({ path }) => path);

    expect(cli.length, 'no CLI command uses the shared use cases').toBeGreaterThan(0);

    // Read from the raw text: `codeOnly` blanks string literals, so an import
    // specifier is exactly the thing it removes.
    const server = read(join(ROOT, 'src/server/server.ts')).text;
    expect(
      importSpecifiers(server).some((specifier) => specifier.includes('app/run-actions')),
    ).toBe(true);
  });
});

describe('a workspace has one registry (UI-29, §93)', () => {
  // The registry *is* the filesystem security boundary: every endpoint names a
  // project by id, and the only ids that exist are the ones one module produced
  // by walking directories the operator pointed the server at. A second place
  // that decided what counts as a project would be a second answer to "what may
  // this server serve", and only one of them would be the one being audited.

  it('discovers projects in one module', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles('src')) {
      const { path, text } = read(file);
      if (path === 'src/server/project-registry.ts') continue;
      // The marker of an initialised project. Anything else looking for it is
      // deciding what a project is, somewhere else.
      if (/\.agent-flow\/config\.yaml/.test(text) && /readDir|walk/.test(codeOnly(text))) {
        offenders.push(path);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('builds every registry through the same constructor', () => {
    // `registryOf` is the only way to make one, so an id can only exist if this
    // module issued it.
    const users = sourceFiles('src')
      .map(read)
      .filter(({ text }) => /\bregistryOf\s*\(/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(users.sort()).toEqual(['src/cli/ui.ts', 'src/server/project-registry.ts']);
  });

  it('resolves symlinks before deciding a directory is inside the workspace', () => {
    // `stat` follows a link and reports an ordinary directory, so containment
    // has to be judged on resolved paths. Without this the walk would publish a
    // repository the operator never pointed it at.
    const registry = codeOnly(read(join(ROOT, 'src/server/project-registry.ts')).text);

    expect(registry).toContain('realPath');
    expect(registry).toContain('within(');
  });

  it('decides containment with path primitives, not with string surgery (D-F02)', () => {
    // The boundary was enforced with `startsWith(`${root}/`)` and
    // `lastIndexOf('/')`. Both are correct on POSIX and meaningless on Windows:
    // `C:\wk` does not contain `C:\wk\api` by that rule, so a Windows workspace
    // discovered nothing — and a security boundary that silently matches nothing is
    // indistinguishable from one that silently matches everything until you read it.
    //
    // **The rule moved to `core/path-containment.ts` in M4** and the registry keeps only
    // the default flavour, so this asserts against both files: the registry still supplies
    // `node:path`, and the primitive still lives where the answer is computed.
    const { text } = read(join(ROOT, 'src/server/project-registry.ts'));
    const registry = codeOnly(text);
    const rule = codeOnly(read(join(ROOT, 'src/core/path-containment.ts')).text);

    expect(importSpecifiers(text)).toContain('node:path');
    expect(rule).toMatch(/\.relative\(/);
    // No separator arithmetic left, in either file. The slug's own `[^a-z0-9]` class is
    // not path logic and lives in `slug`, which `codeOnly` blanks as a literal.
    for (const source of [registry, rule]) {
      expect(source).not.toMatch(/lastIndexOf\(/);
      expect(source).not.toMatch(/startsWith\(\s*root/);
    }
  });

  it('answers containment from two named modules and no third (M4)', () => {
    // Two, not one, and the difference is the boundary case rather than an oversight:
    //
    //   `core/path-containment.ts`   — root counts as inside. A project may *be* the
    //                                  workspace root the operator pointed the server at.
    //   `adapters/git/git-workspaces` — root does not. A worktree must sit strictly under
    //                                  the Agent Flow root and may never be the root.
    //
    // Collapsing them into one function with a flag would put a security answer behind a
    // boolean parameter, which is worse than two functions whose names say which case
    // they include. What must not happen is a *third*, written inline by whoever needed
    // the question next — `/wk` versus `/wknight` decided differently in two places is
    // the defect D-F02 already cost this product once.
    const OWNERS = ['src/core/path-containment.ts', 'src/adapters/git/git-workspaces.ts'];

    const offenders = sourceFiles('src')
      .map(read)
      .filter(({ path }) => !OWNERS.includes(path))
      .filter(({ text }) => /\.relative\(\s*(?:root|resolve\(root)/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(offenders, 'a third containment rule').toEqual([]);
  });
});

describe('there is exactly one run execution lock (AF-L01)', () => {
  // The brief's requirement, made checkable: CLI and server must go through the same
  // service. Two locks would be no lock at all — each process would be excluding a
  // set of peers that did not include the other one.

  it('is implemented in one module', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles('src')) {
      const { path, text } = read(file);
      if (path === 'src/app/run-execution-lock.ts') continue;

      // The atomic primitive a lock is built from. `src/ports` declares it and
      // `src/adapters` implements it; anywhere else it would be a second locking
      // mechanism, and two locks are no lock at all.
      if (path.startsWith('src/adapters/') || path.startsWith('src/ports/')) continue;
      if (/createExclusive\s*\(/.test(codeOnly(text))) offenders.push(path);
    }

    expect(offenders).toEqual([]);
  });

  it('is reached by both adapters through the same use cases', () => {
    // Neither entry point may acquire on its own: acquisition belongs to
    // `withExecutionLock` inside `run-actions.ts`, so the CLI and the HTTP API cannot
    // hold different locks or forget to hold one.
    const lockUsers = sourceFiles('src')
      .map(read)
      .filter(({ text }) =>
        importSpecifiers(text).some((specifier) => specifier.includes('run-execution-lock')),
      )
      .map(({ path }) => path);

    expect(lockUsers.sort()).toEqual([
      'src/app/run-actions.ts',
      // M2-09: `clean` reads the lock to refuse a run somebody is executing (§20.2).
      // Reading rather than acquiring is the whole distinction — taking the lease to
      // decide whether a run may be deleted would make housekeeping compete with the
      // scheduler, and the honest answer there is "somebody is working on this one".
      'src/cli/clean.ts',
      // The server reads the lock for a pre-flight conflict answer; it never takes it.
      'src/server/server.ts',
    ]);

    // Neither reader acquires. `withExecutionLock` remains the only acquisition, so
    // the CLI and the HTTP API cannot hold different locks or forget to hold one.
    for (const reader of ['src/server/server.ts', 'src/cli/clean.ts']) {
      const code = codeOnly(read(join(ROOT, reader)).text);
      expect(code, reader).toContain('.describe(');
      expect(code, `${reader} acquires the lock itself`).not.toContain('.acquire(');
    }
  });

  it('holds the lock across every action that moves a run', () => {
    // `start`, `revise` and `retryTask` touch a run while a scheduler might be running;
    // `approve` and `reject` move the gate that decides whether it may (AF-L01.2).
    // Every one goes through the helper rather than doing its own acquire/release, so
    // none of them can forget the `finally` — and there is one lease, not two mutexes
    // that would each exclude a set of peers the other was not in.
    //
    // `review` joined them in M2-06 (§18.2). It used to be outside the lease and
    // that used to be correct: it only read the user's working tree. §19.1 moves
    // its verification commands and its `GitClient` into the integration worktree
    // — the checkout the Integrator merges into — so a review running under a
    // scheduler would report a result for a tree that never existed at any single
    // instant.
    const actions = read(join(ROOT, 'src/app/run-actions.ts')).text;
    const locked = [...actions.matchAll(/withExecutionLock\(deps, store, runId, '(\w+)'/g)].map(
      (match) => match[1],
    );

    expect(locked.sort()).toEqual(['approve', 'reject', 'retry', 'review', 'revise', 'run']);
  });

  it('takes that lease only where review touches the integration tree (§18.2)', () => {
    // The lease is taken for what the command touches, not for what it is called.
    // A sequential review still only reads the project directory, and refusing it
    // because a run is busy would be a refusal with nothing behind it — so the
    // decision is keyed on the run's recorded mode, which is the same field every
    // other consumer reads (I-13).
    const actions = codeOnly(read(join(ROOT, 'src/app/run-actions.ts')).text);
    const review = actions.slice(
      actions.indexOf('export async function review'),
      actions.indexOf('async function judgeRun'),
    );

    expect(review, 'the review use case was not found').toContain('withExecutionLock');
    expect(review).toMatch(/isolationMode\s*===\s*''/);
  });

  it('owns the review workflow in the application layer, not in the CLI (M2-06)', () => {
    // §26.1 rule 12. `review` writes `verification.json`, `final-review.json` and
    // the run's stage and status — it *moves* a run — and under MVP 2 it also
    // decides which tree everything downstream reads. A command handler that did
    // any of that would be a second implementation the browser could never reach,
    // and the first time the two disagreed the disagreement would be silent.
    //
    // The test is an import rule, because "did you remember to take the lock" is
    // not observable and "who may call this" is.
    const OWNER = 'src/app/run-actions.ts';

    for (const capability of ['runVerification', 'GitClient']) {
      const users = sourceFiles('src')
        .map(read)
        .filter(({ path }) => path !== OWNER)
        .filter(({ path }) => !path.startsWith('src/adapters/git/'))
        .filter(({ path }) => path !== 'src/app/verification-commands.ts')
        // `execution-context.ts` assembles the one `GitCommand` every consumer
        // shares; it builds no client and runs no verification of its own.
        .filter(({ text }) => new RegExp(`\\b${capability}\\s*\\(`).test(codeOnly(text)))
        .map(({ path }) => path);

      expect(users, `${capability} is reached outside ${OWNER}`).toEqual([]);
    }

    // And the CLI is an adapter over it: it calls the use case and renders.
    const cli = read(join(ROOT, 'src/cli/review.ts'));
    expect(importSpecifiers(cli.text).some((s) => s.includes('app/run-actions'))).toBe(true);
    for (const workflow of ['stageRunner', 'store.updateRun', 'writeArtifact', 'checkDefinitionOfDone(']) {
      expect(codeOnly(cli.text), `the CLI still runs ${workflow}`).not.toContain(workflow);
    }
  });

  it('leaves the read-only gate description unlocked (AF-L01.2)', () => {
    // `describeApprovalGate` is a read. Refusing to *show* somebody the gate because a
    // run is busy would help nobody, and a lock taken for a read is a lock two readers
    // can queue behind.
    const actions = read(join(ROOT, 'src/app/run-actions.ts')).text;
    const describe = actions.slice(
      actions.indexOf('export async function describeApprovalGate'),
      actions.indexOf('export interface ApproveResult'),
    );

    expect(describe).not.toContain('withExecutionLock');
  });

  it('keeps the lock out of the workflow state (AF-L01)', () => {
    // The lock is coordination infrastructure. A `locked` field on `RunState` would
    // make it workflow state, and the StateStore would then have two jobs.
    const state = read(join(ROOT, 'src/contracts/state.schema.ts')).text;

    expect(codeOnly(state)).not.toMatch(/\block(ed)?\s*:/i);
  });

  it('keeps the superseded rename mechanism out of the ports (AF-L01.1)', () => {
    // The lock's first design reclaimed a stale claim by moving it aside, lost a race
    // doing it, and was replaced by generations. `FileSystem.rename` existed only for
    // that mechanism and had no consumer left. A port kept for a design nothing uses is
    // how the design comes back — the next person to need "move a file" finds it
    // declared, assumes it is load-bearing, and builds on the thing that failed.
    const port = codeOnly(read(join(ROOT, 'src/ports/file-system.ts')).text);

    expect(port).not.toMatch(/\brename\s*\(/);
    // The one primitive acquisition is allowed to rest on is still declared.
    expect(port).toMatch(/\bcreateExclusive\s*\(/);
  });

  it('never tells an operator to remove a file the lock does not use (AF-L01.1)', () => {
    // Recovery copy has to name the real mechanism. There is no `execution.lock`; there
    // are numbered generations, and only the highest one is the holder. An instruction
    // to delete a path that does not exist teaches the operator that the message is
    // wrong, which is worse than no message.
    //
    // Comments stripped and string literals kept — the opposite of `codeOnly`, because
    // operator copy *is* the string literals.
    const copy = read(join(ROOT, 'src/app/run-actions.ts'))
      .text.replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

    for (const match of copy.matchAll(/execution\.lock[.\w*${}]*/g)) {
      expect(match[0], 'lock copy names a generation').toMatch(/^execution\.lock\.\*$/);
    }
  });

  it('emits no heartbeat or polling event', () => {
    // There is no heartbeat, so there is nothing to poll and no event to emit for it.
    // Three lock events exist and all three describe a transition.
    // Read raw: `codeOnly` blanks string literals, which is exactly what an event
    // name is.
    const actions = read(join(ROOT, 'src/app/run-actions.ts')).text;
    const emitted = [...actions.matchAll(/appendEvent\(runId, '([\w_]+)'/g)].map(
      (match) => match[1],
    );

    expect(emitted).toContain('execution_lock_acquired');
    expect(emitted).toContain('execution_lock_released');
    expect(emitted).toContain('stale_execution_lock_recovered');
    expect(emitted.filter((event) => /heartbeat|poll|ping/i.test(event ?? ''))).toEqual([]);
  });
});

describe('the E2E suite crosses the real server (UI-31)', () => {
  // The failure mode this exists to prevent is not a broken test — it is a *green*
  // one. An E2E that intercepts `/api/**` proves the React app can render a fixture,
  // which the unit suite already proves more cheaply and in a hundredth of the time.
  // What only an E2E can prove is that Fastify, the application services, the
  // StateStore and the filesystem still agree with each other, and one `page.route`
  // deletes exactly that.
  const specs = sourceFiles('apps/web/e2e').filter((file) => file.endsWith('.spec.ts'));

  it('exists at all', () => {
    expect(specs.length).toBeGreaterThan(0);
  });

  it('intercepts no request', () => {
    const offenders = specs
      .map(read)
      .filter(({ text }) => /\bpage\.route\s*\(|\bcontext\.route\s*\(/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('starts the server through the CLI, in one place', () => {
    // One harness, so "the server under test is the one a user gets" is a property
    // of a single file rather than a habit spread across seven specs.
    const spawners = sourceFiles('apps/web/e2e')
      .map(read)
      .filter(({ text }) => /\bspawn(Sync)?\s*\(/.test(codeOnly(text)))
      .map(({ path }) => path)
      .sort();

    expect(spawners).toEqual([
      'apps/web/e2e/global-setup.ts',
      'apps/web/e2e/support/world.ts',
    ]);

    // And it boots the built CLI, not `buildServer` imported directly — a server
    // assembled by the test is a server whose wiring the test is asserting about
    // itself.
    const world = read(join(ROOT, 'apps/web/e2e/support/world.ts')).text;
    expect(world).toContain('dist/bin/agent-flow.js');
    expect(importSpecifiers(world).filter((specifier) => specifier.includes('src/server'))).toEqual(
      [],
    );
  });

  it('spends no quota', () => {
    // The runner is replaced at the executable boundary — `runners.<id>.command` —
    // and nowhere else. A spec that named a real CLI would be a spec that only
    // passes on a machine that is logged in, and costs money when it does.
    const support = sourceFiles('apps/web/e2e/support').map(read);
    const commands = support.filter(({ text }) => /command:/.test(text));

    expect(commands.map(({ path }) => path)).toEqual(['apps/web/e2e/support/world.ts']);

    for (const { path, text } of support) {
      expect(codeOnly(text), `${path} names a real coding CLI`).not.toMatch(
        /command:\s*'(claude|codex)'/,
      );
    }
  });
});

describe('UtilityModel port boundary (M3-01)', () => {
  // The UtilityModel is an optional auxiliary model for advisory tasks.
  // These rules keep it from silently accumulating runner authority or becoming
  // coupled to the primary workflow.

  it('utility-model port does not import AgentRunner or AgentRunInput', () => {
    const { text } = read(join(ROOT, 'src/ports/utility-model.ts'));
    const specifiers = importSpecifiers(text);
    const code = codeOnly(text);

    // Must not import the agent-runner port
    expect(specifiers.some((s) => s.includes('agent-runner'))).toBe(false);
    // Must not reference AgentRunInput or AgentRunner as identifiers
    expect(code).not.toMatch(/\bAgentRunInput\b/);
    expect(code).not.toMatch(/\bAgentRunner\b/);
  });

  it('utility-model port does not import git or process modules', () => {
    const { text } = read(join(ROOT, 'src/ports/utility-model.ts'));
    const specifiers = importSpecifiers(text);

    const forbidden = ['git', 'process-runner', 'node-process', 'worktree', 'node:child_process'];
    for (const f of forbidden) {
      expect(
        specifiers.some((s) => s.includes(f)),
        `utility-model.ts imports ${f}`,
      ).toBe(false);
    }
  });

  it('utility-model port does not import file-system for operational authority', () => {
    const { text } = read(join(ROOT, 'src/ports/utility-model.ts'));
    const specifiers = importSpecifiers(text);
    // file-system port grants write access — a utility model must not import it
    expect(specifiers.some((s) => s.includes('file-system'))).toBe(false);
  });

  it('core/adaptive-workflow does not import the utility-model port', () => {
    const { text } = read(join(ROOT, 'src/core/adaptive-workflow.ts'));
    const specifiers = importSpecifiers(text);
    expect(specifiers.some((s) => s.includes('utility-model'))).toBe(false);
  });

  it('core adaptive-workflow classifies workflows without UtilityModel (decisions remain deterministic)', () => {
    // TRIVIAL / SIMPLE / STANDARD / HIGH-RISK classification is deterministic
    // and must never depend on an optional model.
    const { text } = read(join(ROOT, 'src/core/adaptive-workflow.ts'));
    const code = codeOnly(text);
    expect(code).not.toMatch(/\bUtilityModel\b/);
    expect(code).not.toMatch(/\butilityModel\b/);
  });

  it('utility-model port contains no provider-specific vocabulary', () => {
    const { text } = read(join(ROOT, 'src/ports/utility-model.ts'));
    const code = codeOnly(text).toLowerCase();
    const forbidden = [
      'qwen',
      'no_think',
      'ollama',
      'lmstudio',
      'openai',
      'anthropic',
      'llamacpp',
    ];
    for (const term of forbidden) {
      expect(code.includes(term), `utility-model.ts contains provider term: ${term}`).toBe(false);
    }
  });

  it('utility-model port does not hardcode 40000 as a token budget', () => {
    // M3-00 finding: 40000 is an operational budget for one specific endpoint.
    // The port must not bake it in as a universal constant.
    const { text } = read(join(ROOT, 'src/ports/utility-model.ts'));
    expect(codeOnly(text)).not.toMatch(/\b40000\b/);
  });

  it('FakeUtilityModel does not import git or process modules', () => {
    const { text } = read(join(ROOT, 'test/fakes/fake-utility-model.ts'));
    const specifiers = importSpecifiers(text);
    const forbidden = ['git', 'process-runner', 'node-process', 'worktree', 'node:child_process'];
    for (const f of forbidden) {
      expect(
        specifiers.some((s) => s.includes(f)),
        `fake-utility-model.ts imports ${f}`,
      ).toBe(false);
    }
  });

  it('FakeUtilityModel imports only from the ports barrel (structural alignment with port)', () => {
    const { text } = read(join(ROOT, 'test/fakes/fake-utility-model.ts'));
    expect(importSpecifiers(text).some((s) => s.includes('ports'))).toBe(true);
  });
});

describe('UtilityModel adapter boundary (M3-02)', () => {
  it('OpenAiCompatibleUtilityModel does not implement or extend AgentRunner', () => {
    const { text } = read(join(ROOT, 'src/adapters/utility-model/openai-utility-model.ts'));
    const code = codeOnly(text);
    const specifiers = importSpecifiers(text);

    expect(specifiers.some((s) => s.includes('agent-runner'))).toBe(false);
    expect(code).not.toMatch(/\bAgentRunner\b/);
    expect(code).not.toMatch(/\bAgentRunInput\b/);
    expect(code).not.toMatch(/\bAgentRunResult\b/);
  });

  it('OpenAiCompatibleUtilityModel does not import git, process, or worktree modules', () => {
    const { text } = read(join(ROOT, 'src/adapters/utility-model/openai-utility-model.ts'));
    const specifiers = importSpecifiers(text);
    const forbidden = ['git', 'process-runner', 'node-process', 'worktree', 'node:child_process', 'file-system'];
    for (const f of forbidden) {
      expect(
        specifiers.some((s) => s.includes(f)),
        `openai-utility-model.ts imports ${f}`,
      ).toBe(false);
    }
  });

  it('coding agent runner registry does not import or register OpenAiCompatibleUtilityModel', () => {
    const { text } = read(join(ROOT, 'src/adapters/runners/registry.ts'));
    const specifiers = importSpecifiers(text);
    const code = codeOnly(text);

    expect(specifiers.some((s) => s.includes('utility-model'))).toBe(false);
    expect(code).not.toMatch(/\bOpenAiCompatibleUtilityModel\b/);
    expect(code).not.toMatch(/\bUtilityModel\b/);
  });

  it('core and production workflows in src/core, src/app, src/server do not import utility-model adapters', () => {
    // Engine code stays provider-neutral: an adapter is chosen exactly once,
    // at the composition boundary. `resolve-utility-model` is that boundary —
    // the single file allowed to construct a concrete OpenAiCompatibleUtilityModel
    // from config (Gap 1). Everything else under src/app that wants a model must
    // receive it already-built through BuildContextOptions.utilityModel.
    const workflowDirs = ['src/core', 'src/app', 'src/server', 'src/contracts', 'src/adapters/runners'];
    const allowed = ['src/app/resolve-utility-model.ts'];
    const offenders: string[] = [];

    for (const dir of workflowDirs) {
      for (const file of sourceFiles(dir)) {
        const { path, text } = read(file);
        if (
          allowed.some((suffix) => path.endsWith(suffix)) ||
          !importSpecifiers(text).some((s) => s.includes('adapters/utility-model'))
        ) {
          continue;
        }
        offenders.push(path);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('barrel in src/adapters/utility-model exports OpenAiCompatibleUtilityModel and token estimator', () => {
    const { text } = read(join(ROOT, 'src/adapters/utility-model/index.ts'));
    const code = codeOnly(text);
    expect(code).toContain('OpenAiCompatibleUtilityModel');
    expect(code).toContain('estimateInputTokens');
  });
});

describe('ContextPacket contract boundary (M3-03)', () => {
  // ContextPacket is provider-neutral, authority-free advisory data.
  // It must not acquire execution authority, depend on adapters, or be wired
  // into production workflows ahead of M3-08.

  it('context-packet schema does not import git, process, or worktree modules', () => {
    const { text } = read(join(ROOT, 'src/contracts/context-packet.schema.ts'));
    const specifiers = importSpecifiers(text);
    const forbidden = ['git', 'process-runner', 'node-process', 'worktree', 'node:child_process', 'file-system'];
    for (const f of forbidden) {
      expect(
        specifiers.some((s) => s.includes(f)),
        `context-packet.schema.ts imports ${f}`,
      ).toBe(false);
    }
  });

  it('context-packet schema does not import AgentRunner or AgentRunInput', () => {
    const { text } = read(join(ROOT, 'src/contracts/context-packet.schema.ts'));
    const specifiers = importSpecifiers(text);
    const code = codeOnly(text);

    expect(specifiers.some((s) => s.includes('agent-runner'))).toBe(false);
    expect(code).not.toMatch(/\bAgentRunner\b/);
    expect(code).not.toMatch(/\bAgentRunInput\b/);
  });

  it('context-packet schema contains no provider-specific vocabulary', () => {
    const { text } = read(join(ROOT, 'src/contracts/context-packet.schema.ts'));
    const code = codeOnly(text).toLowerCase();
    const forbidden = [
      'qwen',
      'no_think',
      'ollama',
      'lmstudio',
      'openai',
      'anthropic',
      'llamacpp',
    ];
    for (const term of forbidden) {
      expect(code.includes(term), `context-packet.schema.ts contains provider term: ${term}`).toBe(false);
    }
  });

  it('OpenAI-compatible utility model adapter does not depend on ContextPacket', () => {
    const { text } = read(join(ROOT, 'src/adapters/utility-model/openai-utility-model.ts'));
    const specifiers = importSpecifiers(text);
    const code = codeOnly(text);

    expect(specifiers.some((s) => s.includes('context-packet'))).toBe(false);
    expect(code).not.toMatch(/\bContextPacket\b/);
  });

  it('production workflow engines in src/app, src/server do not import ContextPacket (M3-08 boundary)', () => {
    const workflowDirs = ['src/app', 'src/server'];
    const offenders: string[] = [];

    for (const dir of workflowDirs) {
      for (const file of sourceFiles(dir)) {
        const { path, text } = read(file);
        if (importSpecifiers(text).some((s) => s.includes('context-packet'))) {
          offenders.push(path);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('contracts barrel exports ContextPacket contract and validator', () => {
    const { text } = read(join(ROOT, 'src/contracts/index.ts'));
    expect(text).toContain('context-packet.schema');
  });
});

describe('Repository retrieval boundary (M3-04)', () => {
  // RepositoryRetriever is provider-neutral, bounded candidate discovery and ranking orchestration.
  // It must not acquire execution authority, depend on specific model vendors, or be wired
  // into production workflow execution ahead of M3-08.

  it('repository-retriever does not import child_process or raw network modules', () => {
    const { text } = read(join(ROOT, 'src/core/repository-retriever.ts'));
    const specifiers = importSpecifiers(text);
    const forbidden = ['node:child_process', 'child_process', 'node:net', 'node:http', 'node:https'];
    for (const f of forbidden) {
      expect(
        specifiers.some((s) => s.includes(f)),
        `repository-retriever.ts imports ${f}`,
      ).toBe(false);
    }
  });

  it('repository-retriever does not import AgentRunner or AgentRunInput', () => {
    const { text } = read(join(ROOT, 'src/core/repository-retriever.ts'));
    const specifiers = importSpecifiers(text);
    const code = codeOnly(text);

    expect(specifiers.some((s) => s.includes('agent-runner'))).toBe(false);
    expect(code).not.toMatch(/\bAgentRunner\b/);
    expect(code).not.toMatch(/\bAgentRunInput\b/);
  });

  it('repository-retriever contains no provider-specific vocabulary', () => {
    const { text } = read(join(ROOT, 'src/core/repository-retriever.ts'));
    const code = codeOnly(text).toLowerCase();
    const forbidden = [
      'qwen',
      'no_think',
      'ollama',
      'lmstudio',
      'openai',
      'anthropic',
      'llamacpp',
    ];
    for (const term of forbidden) {
      expect(code.includes(term), `repository-retriever.ts contains provider term: ${term}`).toBe(false);
    }
  });

  it('composes RepositoryRetriever only at the advisor and composition root, never in engines (M3-08 boundary)', () => {
    // M3-08 wires advisory retrieval into the workflow, but deliberately at the
    // composition root: the stage engine must stay retriever-free so a stage
    // keeps working verbatim when advisory context is absent or bypassed.
    const allowed = [
      'src/app/repository-context-advisor.ts',
      'src/app/execution-context.ts',
      'src/adapters/git/git-candidate-discovery.ts',
    ];
    const workflowDirs = ['src/app', 'src/server', 'src/cli', 'src/adapters'];
    const offenders: string[] = [];

    for (const dir of workflowDirs) {
      for (const file of sourceFiles(dir)) {
        const { path, text } = read(file);
        if (
          !allowed.some((suffix) => path.endsWith(suffix)) &&
          importSpecifiers(text).some((s) => s.includes('repository-retriever'))
        ) {
          offenders.push(path);
        }
      }
    }

    // The production advisor must exist and be wired, or this test trivially
    // passes with M3-08 missing entirely.
    expect(
      allowed.every((suffix) =>
        read(join(ROOT, suffix)).text.includes('repository-retriever'),
      ),
    ).toBe(true);

    const adaptive = read(join(ROOT, 'src/core/adaptive-workflow.ts'));
    if (importSpecifiers(adaptive.text).some((s) => s.includes('repository-retriever'))) {
      offenders.push(adaptive.path);
    }

    expect(offenders).toEqual([]);
  });
});

describe('Repository content source seam (M3-05)', () => {
  it('provider-neutral port imports no Node, adapter, runner, or model modules', () => {
    const { text } = read(join(ROOT, 'src/ports/repository-content-source.ts'));
    const specifiers = importSpecifiers(text);
    const code = codeOnly(text);

    expect(
      specifiers.filter((specifier) =>
        ['node:', 'adapters/', 'agent-runner', 'utility-model'].some((term) =>
          specifier.includes(term),
        ),
      ),
    ).toEqual([]);
    expect(code).not.toMatch(/\b(?:AgentRunner|AgentRunInput|UtilityModel)\b/);
  });

  it('Node content Adapter has filesystem authority only', () => {
    const { text } = read(join(ROOT, 'src/adapters/fs/node-repository-content-source.ts'));
    const specifiers = importSpecifiers(text);
    const allowed = [
      'node:fs',
      'node:path',
      'node:util',
      '../../contracts/context-packet.schema.js',
      '../../ports/repository-content-source.js',
    ];

    expect(specifiers.filter((specifier) => !allowed.includes(specifier))).toEqual([]);
    expect(codeOnly(text)).not.toMatch(/\b(?:AgentRunner|AgentRunInput|UtilityModel|GitClient|ProcessRunner)\b/);
  });

  it('uses the host-native path implementation so Windows UNC roots keep their semantics', () => {
    const { text } = read(join(ROOT, 'src/adapters/fs/node-repository-content-source.ts'));

    expect(codeOnly(text)).not.toMatch(/\bposix\b/);
  });

  it('never derives post-open authority from path-based stat', () => {
    const { text } = read(join(ROOT, 'src/adapters/fs/node-repository-content-source.ts'));
    const code = codeOnly(text);

    expect(code).not.toMatch(/\bfs\.stat\s*\(/);
    expect(code.match(/\bhandle\.stat\s*\(\s*\{\s*bigint\s*:\s*true\s*\}\s*\)/g)).toHaveLength(2);
  });

  it('proves every candidate component against raw directory-entry bytes', () => {
    const { text } = read(join(ROOT, 'src/adapters/fs/node-repository-content-source.ts'));
    const code = withoutComments(text);

    expect(code).toMatch(/fs\.readdir\s*\(/);
    expect(code).toMatch(/encoding\s*:\s*['"]buffer['"]/);
  });

  it('does not wire candidate content into production workflows before M3-08, including through the ports barrel', () => {
    const offenders: string[] = [];
    for (const dir of ['src/app', 'src/server']) {
      for (const file of sourceFiles(dir)) {
        const { path, text } = read(file);
        if (/\b(?:RepositoryContentSource|RepositoryContentResult)\b/.test(codeOnly(text))) {
          offenders.push(path);
        }
      }
    }

    const adaptive = read(join(ROOT, 'src/core/adaptive-workflow.ts'));
    if (/\b(?:RepositoryContentSource|RepositoryContentResult)\b/.test(codeOnly(adaptive.text))) {
      offenders.push(adaptive.path);
    }

    expect(offenders).toEqual([]);
  });
});

describe('Hierarchical context compression boundary (M3-05)', () => {
  it('keeps the compressor provider-neutral and without execution authority', () => {
    const { text } = read(join(ROOT, 'src/core/hierarchical-context-compressor.ts'));
    const specifiers = importSpecifiers(text);
    const code = codeOnly(text);

    expect(
      specifiers.filter((specifier) =>
        [
          'adapters/',
          'agent-runner',
          'process-runner',
          'git-',
          'node:',
          'http',
        ].some((term) => specifier.includes(term)),
      ),
    ).toEqual([]);
    expect(code).not.toMatch(/\b(?:AgentRunner|AgentRunInput|ProcessRunner|GitClient|Evidence)\b/);
  });

  it('keeps token estimation behind a provider-neutral port seam', () => {
    const { text } = read(join(ROOT, 'src/ports/context-token-estimator.ts'));
    expect(importSpecifiers(text)).toEqual([]);
    expect(codeOnly(text)).not.toMatch(/\b(?:AgentRunner|UtilityModel|OpenAI|fetch|process)\b/);
  });

  it('does not wire compression into production workflows before M3-08', () => {
    const offenders: string[] = [];
    for (const dir of ['src/app', 'src/server', 'src/cli']) {
      for (const file of sourceFiles(dir)) {
        const { path, text } = read(file);
        if (/\b(?:HierarchicalContextCompressor|HierarchicalCompressionResult)\b/.test(codeOnly(text))) {
          offenders.push(path);
        }
      }
    }

    const adaptive = read(join(ROOT, 'src/core/adaptive-workflow.ts'));
    if (/\b(?:HierarchicalContextCompressor|HierarchicalCompressionResult)\b/.test(codeOnly(adaptive.text))) {
      offenders.push(adaptive.path);
    }

    expect(offenders).toEqual([]);
  });
});

describe('Mechanical log triage boundary (M3-06)', () => {
  it('keeps log triage provider-neutral and without execution or workflow authority', () => {
    const { text } = read(join(ROOT, 'src/core/log-triager.ts'));
    const specifiers = importSpecifiers(text);
    const code = codeOnly(text);

    expect(
      specifiers.filter((specifier) =>
        [
          'adapters/',
          'agent-runner',
          'process-runner',
          'git-',
          'node:',
          'http',
          'task-state',
          'validation-',
        ].some((term) => specifier.includes(term)),
      ),
    ).toEqual([]);
    expect(code).not.toMatch(
      /\b(?:AgentRunner|AgentRunInput|ProcessRunner|GitClient|TaskState|ValidationJudgement)\b/,
    );
  });

  it('does not wire log triage into production workflows before a later milestone', () => {
    const offenders: string[] = [];
    for (const dir of ['src/app', 'src/server', 'src/cli', 'src/adapters', 'src/config']) {
      for (const file of sourceFiles(dir)) {
        const { path, text } = read(file);
        if (importSpecifiers(text).some((specifier) => specifier.includes('log-triager'))) {
          offenders.push(path);
        }
      }
    }

    const adaptive = read(join(ROOT, 'src/core/adaptive-workflow.ts'));
    if (importSpecifiers(adaptive.text).some((specifier) => specifier.includes('log-triager'))) {
      offenders.push(adaptive.path);
    }

    expect(offenders).toEqual([]);
  });
});

describe('Mechanical diff triage boundary (M3-06)', () => {
  it('keeps diff triage provider-neutral and without Git, execution, or workflow authority', () => {
    const { text } = read(join(ROOT, 'src/core/diff-triager.ts'));
    const specifiers = importSpecifiers(text);
    const code = codeOnly(text);

    expect(
      specifiers.filter((specifier) =>
        [
          'adapters/',
          'git-client',
          'git-command',
          'agent-runner',
          'process-runner',
          'adaptive-workflow',
          'node:',
          'http',
          'task-state',
          'validation-',
        ].some((term) => specifier.includes(term)),
      ),
    ).toEqual([]);
    expect(code).not.toMatch(
      /\b(?:GitClient|GitCommand|ProcessRunner|AgentRunner|AgentRunInput|AdaptiveWorkflow|TaskState|ValidationJudgement)\b/,
    );
  });

  it('does not wire diff triage into production workflows before a later milestone', () => {
    const offenders: string[] = [];
    for (const dir of ['src/app', 'src/server', 'src/cli', 'src/adapters', 'src/config']) {
      for (const file of sourceFiles(dir)) {
        const { path, text } = read(file);
        if (importSpecifiers(text).some((specifier) => specifier.includes('diff-triager'))) {
          offenders.push(path);
        }
      }
    }

    const adaptive = read(join(ROOT, 'src/core/adaptive-workflow.ts'));
    if (importSpecifiers(adaptive.text).some((specifier) => specifier.includes('diff-triager'))) {
      offenders.push(adaptive.path);
    }

    expect(offenders).toEqual([]);
  });
});

describe('Context telemetry contract and projection boundary (M3-07)', () => {
  it('keeps the projection provider-neutral and without execution or workflow authority', () => {
    const { text } = read(join(ROOT, 'src/core/context-telemetry.ts'));
    const specifiers = importSpecifiers(text);
    const code = codeOnly(text);

    expect(
      specifiers.filter((specifier) =>
        [
          'adapters/',
          'agent-runner',
          'process-runner',
          'git-',
          'adaptive-workflow',
          'task-state',
          'validation-',
          'node:',
          'http',
        ].some((term) => specifier.includes(term)),
      ),
    ).toEqual([]);
    expect(code).not.toMatch(
      /\b(?:AgentRunner|AgentRunInput|ProcessRunner|GitClient|GitCommand|AdaptiveWorkflow|TaskState|ValidationJudgement|fetch|billing|price|cost)\b/i,
    );
  });

  it('keeps the closed schema dependency-free except for Zod', () => {
    const { text } = read(join(ROOT, 'src/contracts/context-telemetry.schema.ts'));
    expect(importSpecifiers(text)).toEqual(['zod']);
    expect(codeOnly(text)).not.toMatch(
      /\b(?:AgentRunner|UtilityModel|RepositoryRetriever|ProcessRunner|GitClient|fetch|billing|price|cost)\b/i,
    );
  });

  it('wires M3-07 telemetry only through the recorder and read-only server projections, plus the M3-08 advisory singleton', () => {
    const offenders: string[] = [];
    for (const dir of ['src/app', 'src/server', 'src/cli', 'src/adapters', 'src/config']) {
      for (const file of sourceFiles(dir)) {
        const { path, text } = read(file);
        const allowed = [
          'src/app/context-telemetry-recorder.ts',
          // M3-08: the advisory singleton projects retrieval outcomes and the
          // composition root wires the recorder — the schedule of calls that
          // makes M3-07 projections effective.
          'src/app/repository-context-advisor.ts',
          'src/app/execution-context.ts',
          'src/server/context-telemetry-reader.ts',
          'src/server/analytics-reader.ts',
          'src/server/server.ts',
        ].some((suffix) => path.endsWith(suffix));
        if (
          !allowed &&
          importSpecifiers(text).some((specifier) => specifier.includes('context-telemetry'))
        ) {
          offenders.push(path);
        }
      }
    }

    const adaptive = read(join(ROOT, 'src/core/adaptive-workflow.ts'));
    if (importSpecifiers(adaptive.text).some((specifier) => specifier.includes('context-telemetry'))) {
      offenders.push(adaptive.path);
    }

    expect(offenders).toEqual([]);
  });

  it('allows only the dedicated recorder to emit context telemetry events', () => {
    const emitters: string[] = [];
    for (const file of sourceFiles('src')) {
      const { path, text } = read(file);
      if (
        /appendEvent\s*\([^)]*(?:CONTEXT_TELEMETRY_EVENT_TYPE|['"]context_telemetry_observed['"])/s.test(
          codeOnly(text),
        )
      ) {
        emitters.push(path);
      }
    }

    expect(emitters.map((path) => path.replace(`${ROOT}/`, ''))).toEqual([
      'src/app/context-telemetry-recorder.ts',
    ]);
  });

  it('keeps context read models out of workflow, scheduling, core, and adapters', () => {
    const offenders: string[] = [];
    for (const dir of ['src/core', 'src/app', 'src/adapters', 'src/cli', 'src/config']) {
      for (const file of sourceFiles(dir)) {
        const { path, text } = read(file);
        if (
          importSpecifiers(text).some((specifier) =>
            specifier.includes('context-telemetry-reader'),
          )
        ) {
          offenders.push(path);
        }
      }
    }
    const reader = read(join(ROOT, 'src/server/context-telemetry-reader.ts'));

    expect(offenders).toEqual([]);
    expect(codeOnly(reader.text)).not.toMatch(
      /\b(?:appendEvent|writeFile|updateRun|Scheduler|AdaptiveWorkflow|TaskState|ValidationJudgement)\b/,
    );
  });

  it('reserves tolerant audit reads for read models', () => {
    // The tolerant read exists so one malformed legacy audit line creates a visible data
    // gap rather than the loss of every otherwise valid projection. That reasoning belongs
    // to anything that *renders* the log, and to nothing that decides on it.
    //
    // The list is exact rather than a pattern, and that is the point: `scheduler.ts`,
    // `run-actions.ts` and `task-executor.ts` are absent, and adding one would mean a
    // dropped line could change what the system does instead of what it shows.
    const users: string[] = [];
    for (const file of sourceFiles('src')) {
      const { path, text } = read(file);
      if (path.endsWith('src/app/state-store.ts')) continue;
      if (/\.readEventsBestEffort\s*\(/.test(codeOnly(text))) users.push(path);
    }

    expect(users.map((path) => path.replace(`${ROOT}/`, '')).sort()).toEqual([
      // The AR-07 projection, and the two surfaces that ship it.
      'src/app/telemetry.ts',
      'src/cli/status.ts',
      'src/server/run-reader.ts',
    ]);
  });

  it('keeps the projection off every decision path', () => {
    // The companion to the rule above, stated positively. `projectRun` reads the event log
    // tolerantly, so nothing that takes a lock, spends an attempt or writes state may
    // consult it. `isResumable` is the exception by construction — it takes state and DAG
    // nodes and never opens the log, which is why C-19 is allowed to refuse on it.
    const DECIDERS = ['src/app/scheduler.ts', 'src/app/run-actions.ts', 'src/app/task-executor.ts'];

    for (const path of DECIDERS) {
      const code = codeOnly(read(join(ROOT, path)).text);
      expect(code, `${path} decides on the projection`).not.toMatch(/\bprojectRun\s*\(/);
    }
  });
});

describe('the recovery taxonomy is one vocabulary, refined (AR-00, AD-36)', () => {
  // The single most dangerous shape this milestone could have produced: a second enum
  // beside `RUNNER_ERROR_CODES` that answers the same question differently. Every rule
  // here is about keeping the refinement *above* the transport vocabulary rather than
  // beside it.
  const CLASSIFIER = 'src/core/failure-classification.ts';

  it('declares the runner error codes in exactly one place', () => {
    // A classifier that re-listed them would be a second copy able to disagree with the
    // adapters' translation contract — and `FALLBACK_TRIGGERS` is defined as a subset of
    // that list at the schema level, so a divergence would change fallback reasoning.
    const owners = sourceFiles('src')
      .map(read)
      .filter(({ text }) => /RUNNER_ERROR_CODES\s*=/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(owners).toEqual(['src/contracts/common.schema.ts']);
  });

  it('declares the failure classes in exactly one place', () => {
    const owners = sourceFiles('src')
      .map(read)
      .filter(({ text }) => /FAILURE_CLASSES\s*=/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(owners).toEqual(['src/contracts/common.schema.ts']);
  });

  it('maps class to runner code in the classifier and nowhere else', () => {
    // The mapping is the refinement. A second module holding its own copy is how one
    // question acquires two answers.
    const owners = sourceFiles('src')
      .map(read)
      .filter(({ text }) => /refinedRunnerErrorCode|classesRefining/.test(codeOnly(text)))
      .map(({ path }) => path)
      .sort();

    expect(owners).toEqual([CLASSIFIER]);
  });

  it('never branches on a failure class and a runner code in one condition', () => {
    // AD-36's rule, read as code: "nothing branches on both". A module decides on the
    // class or on the code — mixing them in one predicate is where the two vocabularies
    // start to drift apart.
    const offenders: string[] = [];

    for (const file of sourceFiles('src')) {
      const { path, text } = read(file);
      if (path === CLASSIFIER || path.startsWith('src/contracts/')) continue;

      const code = codeOnly(text);
      // A conditional naming both concepts. `failureClass` and `errorCode` may legitimately
      // sit in one *object literal* — an artifact carries both — so the pattern is anchored
      // on `if (`/`&&`/`||` rather than on co-occurrence in a file.
      const mixed =
        /\bif\s*\([^)]*\bfailureClass\b[^)]*\berrorCode\b/.test(code) ||
        /\bif\s*\([^)]*\berrorCode\b[^)]*\bfailureClass\b/.test(code);
      if (mixed) offenders.push(path);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the classifier and the policy free of the UtilityModel', () => {
    // §11, verbatim: "an architecture test must assert that `core/recovery-policy.ts` and
    // `core/failure-classification.ts` have no dependency on `ports/utility-model.ts`".
    // The UtilityModel's role in this milestone is none, and a module that *could* ask it
    // is a module where somebody eventually does.
    for (const path of [CLASSIFIER, 'src/core/recovery-policy.ts']) {
      const { text } = read(join(ROOT, path));
      const code = codeOnly(text);

      expect(
        importSpecifiers(text).some((specifier) => specifier.includes('utility-model')),
        `${path} imports the utility model port`,
      ).toBe(false);
      expect(code, `${path} names a UtilityModel`).not.toMatch(/\bUtilityModel\b/);
    }
  });

  it('never routes a recovery decision through a model', () => {
    // AR §5's `mechanical` column is 20 of 22 rows, and those rows are asserted to spend
    // zero model calls. A policy module that could invoke anything would make that a
    // promise rather than a property.
    for (const path of [CLASSIFIER, 'src/core/recovery-policy.ts', 'src/core/run-projection.ts']) {
      const code = codeOnly(read(join(ROOT, path)).text);

      for (const forbidden of ['AgentRunner', 'AgentRunInput', 'ProcessRunner', 'StageRunner']) {
        expect(code, `${path} reaches for ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe('the AR-00 pure modules stay pure', () => {
  // §7 of the milestone brief: a pure module accesses no filesystem, calls no
  // AgentRunner, executes no Git and runs no shell. `src/core stays pure` above covers
  // imports; these cover the ways a *port handed in* could smuggle the same thing.
  const PURE = [
    'src/core/evidence-redaction.ts',
    'src/core/failure-classification.ts',
    'src/core/recovery-policy.ts',
    'src/core/run-projection.ts',
  ];

  it('takes no dependency that could observe a machine', () => {
    for (const path of PURE) {
      const code = codeOnly(read(join(ROOT, path)).text);

      for (const forbidden of [
        'readFile',
        'writeFile',
        'readdir',
        'realpath',
        'existsSync',
        'spawn',
        'execFile',
        'process.',
        'Math.random',
        'Date.now',
        'fetch(',
      ]) {
        expect(code, `${path} reaches for ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('imports only contracts and other pure core modules', () => {
    // A port, an adapter or an app module would each be a way for an answer to depend on
    // something other than its arguments.
    for (const path of PURE) {
      for (const specifier of importSpecifiers(read(join(ROOT, path)).text)) {
        expect(specifier, `${path} imports ${specifier}`).toMatch(/^\.\.\/contracts\/|^\.\//);
      }
    }
  });

  it('spawns no Git command', () => {
    for (const path of PURE) {
      const code = codeOnly(read(join(ROOT, path)).text);
      expect(code, `${path} names a git command`).not.toMatch(/command:\s*/);
      expect(code, `${path} builds a subcommand`).not.toMatch(/subcommand:\s*/);
    }
  });

  it('resolves no absolute path of its own', () => {
    // `evidence-redaction` is *about* absolute paths and must still not know one: the
    // worktree root and the home directory are passed in, because they are observations
    // about a machine and this layer cannot make one.
    for (const path of PURE) {
      const { text } = read(join(ROOT, path));
      expect(text, `${path} names a home directory`).not.toMatch(/homedir|os\.homedir/);
      expect(text, `${path} names the worktree root`).not.toMatch(/\.agent-flow\/worktrees/);
    }
  });
});

describe('I-21 — redaction is applied once, at the boundary that persists (AD-35)', () => {
  const HOME = 'src/core/evidence-redaction.ts';

  it('stays visible to this file’s lexer, so every rule below can see it', () => {
    // Measured, not hypothetical. `codeOnly` blanks string literals and has no notion of a
    // regex literal, so a `"` or `'` inside a character class opens a string that closes at
    // the next one anywhere below — it was swallowing 1894 characters of this module, and
    // every rule written against it was passing by looking at nothing.
    //
    // The module now writes those two characters as `\x22` and `\x27`. This assertion is
    // what stops somebody from typing them back and quietly blinding the rules.
    const { text } = read(join(ROOT, HOME));
    const code = codeOnly(text);

    // The last declaration in the file. If the lexer drifts, the tail is what disappears.
    expect(code, `${HOME} is being partly blanked by codeOnly`).toMatch(
      /function stripTrailingSeparator/,
    );
    // And a rough size check, because a drift can eat the middle without touching the end.
    expect(code.length).toBeGreaterThan(text.length / 4);
  });

  it('implements redaction in exactly one module', () => {
    // Redacting at each writer independently guarantees drift, and the drift is silent:
    // the writer that forgot is the one that leaks.
    const owners = sourceFiles('src')
      .map(read)
      .filter(({ text }) => /function redactEvidence|redactEvidence\s*=/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(owners).toEqual([HOME]);
  });

  it('keeps the credential patterns where they can be reviewed as a set', () => {
    // Guards the rule above from passing vacuously if the module were emptied, and pins
    // that the shapes AD-35 lists are actually present.
    const text = withoutComments(read(join(ROOT, HOME)).text);

    expect(text).toMatch(/authorization/i);
    expect(text).toMatch(/bearer/i);
    expect(text).toMatch(/api\[_-\]\?key/i);
    expect(text).toMatch(/PRIVATE KEY/);
  });

  it('offers no way to recover the original text', () => {
    // "Irreversible and lossy by design." A module exporting an inverse — or keeping a
    // copy — would make every persisted artifact a container for the secret again.
    const code = codeOnly(read(join(ROOT, HOME)).text);

    for (const forbidden of ['unredact', 'reveal', 'original', 'decrypt', 'cache']) {
      expect(code, `${HOME} offers ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('I-26 — runtime status is projected, never persisted (AD-48)', () => {
  it('persists lifecycle outcomes and nothing a projection computes', () => {
    // Frozen so growth is deliberate. Mixing lifecycle with presentation means a crash
    // mid-write persists an *opinion*, and the projection then has two sources of truth.
    //
    // `cancelled` was added by PR-03 and is the one member this list has ever gained. It
    // belongs here because it is a terminal outcome that is neither `completed` nor
    // `failed`: a run an operator stopped, reported as failed, would describe a person's
    // decision as a defect on every surface that reads this — the dashboard, the
    // Definition of Done and `status --json`. It is not a projection of anything; nothing
    // computes it, `cancel` writes it.
    const { text } = read(join(ROOT, 'src/contracts/state.schema.ts'));
    const declaration = /RUN_STATUSES = \[([\s\S]*?)\]/.exec(withoutComments(text))?.[1] ?? '';

    const statuses = [...declaration.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    expect(statuses).toEqual([
      'running',
      'waiting_for_approval',
      'plan_rejected',
      'approved',
      'completed',
      'failed',
      'cancelled',
    ]);
  });

  it('persists no status that is derived from something else', () => {
    // The structural half, and the first draft of it was wrong in a way worth recording:
    // it asserted the two enums share no name, and `failed` has always been in both. That
    // sharing is correct — a failed run projects to `failed` — so the rule is not "no
    // overlap".
    //
    // The rule is that a status **computed from other evidence** must never be written
    // down. Each name below is derived: from the event log, from the task states, from a
    // freshness comparison. Persisting one means a crash between the evidence and the
    // opinion leaves a run asserting something its own tasks contradict, and then two
    // sources of truth disagree with no way to tell which is stale.
    const derived = [
      'planning',
      'implementing',
      'recovering',
      'verifying',
      'reviewing',
      'correcting',
      'blocked_on_human',
      'auto_recovery_exhausted',
      'plan_rejected_revisable',
    ];

    const stateText = withoutComments(read(join(ROOT, 'src/contracts/state.schema.ts')).text);
    const declaration = /RUN_STATUSES = \[([\s\S]*?)\]/.exec(stateText)?.[1] ?? '';
    const persisted = [...declaration.matchAll(/'([a-z_]+)'/g)].map((match) => match[1] ?? '');

    expect(persisted.length, 'the persisted statuses could not be read').toBeGreaterThan(0);
    expect(
      derived.filter((name) => persisted.includes(name)),
      'a computed status reached the persisted enum',
    ).toEqual([]);
  });

  it('declares the runtime statuses outside the persisted contract', () => {
    // One owner, and it is not a schema module. The types moved into `contracts/` when the
    // HTTP API began shipping the projection — `core` may import `contracts` and not the
    // reverse — but the invariant is about *persistence*, not about directories: every
    // `*.schema.ts` file describes something written to disk, and a projected status
    // sitting among them is how a crash mid-write comes to persist an opinion.
    const owners = sourceFiles('src')
      .map(read)
      .filter(({ text }) => /RUNTIME_STATUSES\s*=/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(owners).toEqual(['src/contracts/projection.ts']);
    expect(owners.every((path) => !path.endsWith('.schema.ts'))).toBe(true);
  });

  it('keeps every persisted schema ignorant of the projection', () => {
    // The direct form of the invariant. A schema that named a runtime status would be one
    // `z.object` away from writing one.
    const naming = sourceFiles('src/contracts')
      .filter((path) => path.endsWith('.schema.ts'))
      .map(read)
      .filter(({ text }) => /RuntimeStatus|RUNTIME_STATUSES/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(naming, 'a persisted schema names a projected status').toEqual([]);
  });

  it('never writes a runtime status to a store', () => {
    const code = codeOnly(read(join(ROOT, 'src/core/run-projection.ts')).text);

    for (const forbidden of ['updateRun', 'appendEvent', 'writeArtifact', 'StateStore']) {
      expect(code, `the projection calls ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('keeps the task graph file-agnostic (AD-43)', () => {
    // The projection consumes `DagNode`, so it is a place a file-shaped field could arrive
    // by the back door. Overlap is planning and scheduling policy, not graph topology.
    const dag = codeOnly(read(join(ROOT, 'src/core/dag.ts')).text);
    const node = dag.slice(dag.indexOf('interface DagNode'));
    const body = node.slice(node.indexOf('{'), node.indexOf('}') + 1);

    for (const field of ['files', 'likely', 'paths', 'scope']) {
      expect(body, `DagNode carries a ${field}`).not.toContain(field);
    }
  });
});

describe('one word, one meaning: attempt versus repair (AR §4.4)', () => {
  it('names StageRunner’s internal counter repair, not attempt', () => {
    // The evidence run wrote `attempt=1 failed` inside a file named `…-attempt-2.log`:
    // two different numbers under one name, in one sentence. An *attempt* is one agent
    // invocation for one task in one prepared workspace; this counter is re-prompts inside
    // one stage call.
    const code = codeOnly(read(join(ROOT, 'src/app/stage-runner.ts')).text);

    // The loop variable and what it writes.
    expect(code).toMatch(/let repair = 0/);
    expect(code).toMatch(/repairs:\s*repair/);
    // And the old spellings are gone from the emitting module.
    expect(code, 'stage-runner still declares an attempt counter').not.toMatch(/let attempt = 0/);
    expect(code, 'stage-runner still emits attempts').not.toMatch(/attempts:\s*attempt\b/);
  });

  it('writes the repair count into the log under its own name', () => {
    // Read with literals kept: the log line *is* a string literal, and `codeOnly` blanks
    // exactly the thing this rule is looking for.
    const text = withoutComments(read(join(ROOT, 'src/app/stage-runner.ts')).text);

    expect(text).toMatch(/repair=\$\{/);
    expect(text, 'the log still says attempt=').not.toMatch(/attempt=\$\{/);
  });

  it('still reads the old spelling back, so an existing run keeps its numbers', () => {
    // Renaming a field a reader depends on is a migration unless the reader accepts both.
    // Every event already on disk says `attempts`.
    //
    // Read through `withoutComments` rather than `codeOnly`: the field names *are* string
    // literals — `detail['repairs']` — and `codeOnly` blanks exactly those, so this rule
    // written against it would be asserting nothing.
    for (const path of ['src/core/stage-timeline.ts', 'src/app/telemetry.ts']) {
      const code = withoutComments(read(join(ROOT, path)).text);
      expect(code, `${path} does not read the new spelling`).toContain('repairs');
      expect(code, `${path} dropped the old spelling`).toContain('attempts');
    }
  });
});

describe('the (runner, model) capability seam (AD-30)', () => {
  it('reads a capabilities entry through one accessor', () => {
    // "Record or resolver" is answered once. A module indexing the map directly would get
    // a function where it expected an object — which type-checks nowhere useful and would
    // push callers to normalise it themselves, differently.
    const offenders: string[] = [];

    for (const file of sourceFiles('src')) {
      const { path, text } = read(file);
      if (path === 'src/core/role.ts') continue;
      const code = codeOnly(text);

      // The shape of the old direct lookup, in either spelling.
      if (/capabilities\[[^\]]+\]/.test(code)) offenders.push(path);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps every model name out of the core', () => {
    // AD-13, re-asserted where it is newly at risk: AD-30 hands the core a model string,
    // and the temptation is a lookup table keyed by it. The existing provider rule covers
    // vendor names; this covers the shape.
    const offenders = sourceFiles('src/core')
      .map(read)
      .filter(({ text }) => /gemini|antigravity|agy/i.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('keeps a per-model capability table inside the runner adapters, and nowhere else (AR-01)', () => {
    // **The line AR-00 drew and AR-01 crossed, redrawn where it now belongs.**
    //
    // AR-00 landed `capabilities(model?)` inert and pinned that inertness here, so that
    // encoding the measurement would have to be a deliberate edit rather than a drift.
    // AR-01 makes that edit: one adapter now answers differently per model, which is what
    // makes `clampReasoning` fire (C-03, I-20).
    //
    // What must not move is *where* the knowledge lives. A table keyed by model name is
    // provider knowledge; AD-13 puts it in the adapter that owns the provider, and AD-30
    // says explicitly that such a table "may never live in the core". So the rule inverts:
    // it no longer forbids the table, it confines it.
    const port = codeOnly(read(join(ROOT, 'src/ports/agent-runner.ts')).text);
    expect(port, 'the port does not declare the model parameter').toMatch(
      /capabilities\(\s*model\?:\s*string\s*\)/,
    );

    // The port stays a contract: it declares that an answer may depend on the model and
    // says nothing about any particular one.
    expect(port, 'the port names a model').not.toMatch(/gemini|antigravity|claude-|gpt-|sonnet|opus/i);

    const tables = sourceFiles('src')
      .map(read)
      .filter(({ text }) => /MEASURED_MODEL|MODEL_EFFORTS|modelCapabilities/.test(codeOnly(text)))
      .map(({ path }) => path);

    // Confined to the runner adapters. Not the core, not the app layer, not the CLI, not
    // the server — each of which receives the model as an opaque string and must keep
    // treating it as one.
    const strays = tables.filter((path) => !path.startsWith('src/adapters/runners/'));
    expect(strays, 'a per-model capability table escaped the runner adapters').toEqual([]);
  });

  it('lets no layer above the adapters reconcile a model id with an effort (AR-01)', () => {
    // The specific temptation this milestone creates. One vendor's model ids *encode* an
    // effort — an id ending in `-high` — while the effective effort is decided by
    // `clampReasoning` and may be `low`. The tidy-looking fix is to make the two agree
    // somewhere above the adapter, and every version of that fix is a heuristic applied to
    // a string the core is forbidden to interpret (AD-13).
    //
    // So: no layer above `src/adapters/` may take the model apart. The adapter may — it is
    // the only place that knows what the id means.
    const DISSECTION = [
      /\bmodel\b[^\n;]*\.(?:startsWith|endsWith|split|match|replace|slice|substring)\s*\(/,
      /\bmodel\b[^\n;]*\.includes\s*\(/,
    ];

    const offenders: string[] = [];
    for (const file of sourceFiles('src')) {
      const { path, text } = read(file);
      if (path.startsWith('src/adapters/')) continue;
      const code = codeOnly(text);
      if (DISSECTION.some((pattern) => pattern.test(code))) offenders.push(path);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the measurement in the documentation, beside the code that now encodes it', () => {
    // AR-00's acceptance named a *documentation* deliverable: "`docs/runner-capabilities.md`
    // gains an AGY section with measured per-model reasoning levels". AR-01 encodes it in
    // the adapter, and the documentation is what says where the numbers came from — a
    // table in code with no recorded provenance is an assertion, not a measurement.
    const doc = readFileSync(join(ROOT, 'docs/runner-capabilities.md'), 'utf8');

    expect(doc).toMatch(/##\s+AGY/);
    expect(doc).toMatch(/gemini-3\.1-pro/);
    // The distinction the section exists to draw.
    expect(doc).toMatch(/CLI surface/i);
    expect(doc).toMatch(/effective/i);
  });

  it('declares a non-interactive tool grant in every adapter', () => {
    // AD-32 makes this a required field, which means each adapter has to state what its
    // CLI documents. Unknown stays false, and false does not block execution — it produces
    // a warning rather than a silent pass.
    const adapters = [
      'src/adapters/runners/claude-code-runner.ts',
      'src/adapters/runners/codex-runner.ts',
      'src/adapters/runners/agy-runner.ts',
    ];

    for (const path of adapters) {
      const code = codeOnly(read(join(ROOT, path)).text);
      expect(code, `${path} declares no tool grants`).toContain('nonInteractiveToolGrants');
    }

    // The decorator forwards rather than declaring one of its own: a fallback's
    // capabilities were checked when its configuration was resolved.
    const fallback = codeOnly(read(join(ROOT, 'src/adapters/runners/fallback-runner.ts')).text);
    expect(fallback).toMatch(/primary\.capabilities\(model\)/);
  });
});

/**
 * The disease this milestone kept catching in itself: built, tested, and never wired.
 *
 * Three times in one sitting. `projectRun` answered C-19 … C-22 with thirty-nine passing
 * tests and **no consumer**, so every surface kept deriving its own answer and disagreeing.
 * `recoveryCostAgainstBaseline` was AR-09's acceptance criterion — "a recovered task's cost
 * against a first-attempt baseline" — with no caller, so nothing reported it.
 * `renderFailureContext` turned the Failure Context Packet into the text a retry is given,
 * had no caller, and `implementation.md` had no slot for it: **automatic recovery re-ran the
 * identical prompt**, which is a retry loop with bookkeeping rather than recovery.
 *
 * Every one of those had a green unit test. That is the point. A test proves a function
 * computes; nothing in a unit test proves anybody calls it, and "the milestone is done"
 * was read off the wrong signal all three times.
 */
describe('a core module built for a milestone is actually wired to one', () => {
  // The AR milestone modules. Scoped rather than global because a shared vocabulary module
  // legitimately exports more than any one caller uses; these were each written to be
  // consumed by a named surface, and each silently was not.
  const AR_MODULES = [
    'src/core/run-projection.ts',
    'src/core/prompt-budget.ts',
    'src/core/failure-context.ts',
    'src/core/acceptance.ts',
    'src/core/file-overlap.ts',
    'src/core/corrective-envelope.ts',
    'src/core/recovery-policy.ts',
    // M4's, added as each one gained its caller rather than in advance. A module listed
    // here before it is wired fails this rule, which is exactly the signal the rule is
    // for — so the list grows with the milestone instead of describing its plan.
    'src/core/collaboration/roster.ts',
    'src/core/collaboration/ids.ts',
    'src/core/collaboration/budgets.ts',
    'src/core/collaboration/threads.ts',
    'src/core/collaboration/handoffs.ts',
    'src/core/collaboration/blackboard.ts',
    'src/core/collaboration/context.ts',
    'src/core/path-containment.ts',
  ];

  const wholeSource = sourceFiles('src').map(read);

  it('exports no function that nothing calls', () => {
    const uncalled: string[] = [];

    for (const path of AR_MODULES) {
      const code = codeOnly(read(join(ROOT, path)).text);
      for (const [, name] of code.matchAll(/export function (\w+)/g)) {
        // One occurrence is the declaration itself. A function with only that has no call
        // site anywhere in the product — the exact shape all three defects took.
        const mentions = wholeSource.reduce(
          (total, file) =>
            total + [...codeOnly(file.text).matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length,
          0,
        );
        if (mentions <= 1) uncalled.push(`${path}:${name}`);
      }
    }

    expect(uncalled, 'exported, tested, and called by nothing').toEqual([]);
  });

  it('is reachable from a surface, not only from other core modules', () => {
    // The second half, and the one that catches a cluster of dead code that calls itself.
    // `core` is where answers are computed; `app`, `server` and `cli` are where they reach
    // somebody. A module none of them can see is a module nobody uses.
    const consumers = ['src/app', 'src/server', 'src/cli']
      .flatMap((dir) => sourceFiles(dir))
      .map(read);

    const unreachable = AR_MODULES.filter((path) => {
      const bare = path.slice(path.lastIndexOf('/') + 1, -3);
      return !consumers.some(({ text }) =>
        importSpecifiers(text).some(
          (specifier) => specifier.includes(bare) || specifier.includes('contracts/index'),
        ),
      );
    }).filter((path) => {
      // A module reached only through the contracts barrel still counts, so re-check the
      // narrow way: somebody names the module directly.
      const bare = path.slice(path.lastIndexOf('/') + 1, -3);
      return !consumers.some(({ text }) =>
        importSpecifiers(text).some((specifier) => specifier.includes(bare)),
      );
    });

    expect(unreachable, 'a core module no surface imports').toEqual([]);
  });
});

describe('collaboration carries no workflow authority (M4, I-27, I-29)', () => {
  // The single property that makes an agent-to-agent channel safe to have at all.
  // A message is model output arriving through a different door than a plan, and the
  // defence is the same one: the modules that read it are structurally incapable of
  // acting on it. Prose saying "messages are advisory" is a promise; an import ban is
  // a mechanism.
  const COLLABORATION = [
    ...sourceFiles('src/core/collaboration'),
    ...sourceFiles('src').filter((file) => /src\/app\/collaboration-[^/]+\.ts$/.test(file)),
    join(ROOT, 'src/contracts/collaboration.schema.ts'),
    join(ROOT, 'src/contracts/collaboration-config.schema.ts'),
  ].filter((file) => existsSync(file));

  it('exists at all', () => {
    // Guards the rules below against passing over an empty set — the failure mode
    // where a whole feature is renamed and every rule about it silently stops looking.
    expect(COLLABORATION.length).toBeGreaterThan(0);
  });

  it('reaches no module that can move a run', () => {
    const FORBIDDEN = [
      'scheduler',
      'integrator',
      'task-executor',
      'state-store',
      'attempt-receipt',
      'worktree-recovery',
      'run-actions',
      'approval',
      'corrective-round',
    ];

    const offenders = COLLABORATION.map(read).flatMap(({ path, text }) =>
      importSpecifiers(text)
        .filter((specifier) => FORBIDDEN.some((module) => specifier.includes(module)))
        .map((specifier) => `${path} → ${specifier}`),
    );

    expect(offenders, 'a collaboration module importing something that decides').toEqual([]);
  });

  it('reaches no shell, no process and no Git', () => {
    // I-29. A message body is text that a model wrote; a module that can both read one
    // and spawn a process is one refactor away from interpolating the first into the
    // second.
    const FORBIDDEN = ['node:child_process', 'child_process', 'git-command', 'git-client', 'git-workspaces', 'process-runner'];

    const offenders = COLLABORATION.map(read).flatMap(({ path, text }) =>
      importSpecifiers(text)
        .filter((specifier) => FORBIDDEN.some((module) => specifier.includes(module)))
        .map((specifier) => `${path} → ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });

  it('keeps the pure half free of Node built-ins, like the rest of core', () => {
    const offenders = sourceFiles('src/core/collaboration')
      .map(read)
      .filter(({ text }) => importSpecifiers(text).some((s) => s.startsWith('node:')))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('names no runner, model or provider', () => {
    // Same rule as `src/core`, restated for this feature because a roster is exactly
    // where a provider name is tempting: an agent has a runner, and the runner's *id*
    // comes from configuration rather than from a table here.
    const FORBIDDEN = ['claude', 'codex', 'anthropic', 'openai', 'gpt-', 'opus', 'sonnet', 'gemini'];

    const offenders = COLLABORATION.map(read).flatMap(({ path, text }) => {
      const code = codeOnly(text).toLowerCase();
      return FORBIDDEN.filter((name) => code.includes(name)).map((name) => `${path}: ${name}`);
    });

    expect(offenders).toEqual([]);
  });

  it('validates a referenced path with the ContextPacket rule and no second one', () => {
    // A second implementation of the traversal rules is a second chance to miss one of
    // them. The reference schema must reach `validateAndNormalizeRepositoryPath` rather
    // than test for `..` itself.
    const schema = read(join(ROOT, 'src/contracts/collaboration.schema.ts'));

    expect(schema.text).toContain('validateAndNormalizeRepositoryPath');
    // No hand-rolled traversal check beside it.
    expect(codeOnly(schema.text)).not.toMatch(/\.\.\//);
  });

  it('composes the outbox path in one module, and reads it from one place', () => {
    // The filename is the contract between an agent and the harvest, and it is also the
    // thing that must never be spelled twice: a second spelling in the executor would be
    // a file the harvest does not remove, which is I-32 broken silently.
    // **The one contract in this product that a model has to hold up its end of.** The
    // prompt tells the agent the name and the harvest looks for it; two spellings would be
    // an agent writing to a file nobody reads — a failure with no error, because an outbox
    // that is never found is indistinguishable from an agent that had nothing to say.
    //
    // Caught here first: `core/collaboration/context.ts` hardcoded it into the instruction
    // rather than interpolating the constant. It now imports it, like everything else.
    //
    // `defaults.ts` names it in the YAML template's own comment, which is documentation an
    // operator reads rather than a path this product composes. Allow-listed rather than
    // removed: a config template describing a mechanism without naming its file cannot be
    // acted on.
    const DOCUMENTATION = ['src/config/defaults.ts'];

    const owners = sourceFiles('src')
      .map(read)
      .filter(({ text }) => withoutComments(text).includes('.agent-flow-outbox.json'))
      .map(({ path }) => path)
      .filter((path) => !DOCUMENTATION.includes(path));

    expect(owners).toEqual(['src/contracts/collaboration.schema.ts']);
  });

  it('harvests before the tree is captured, in the executor (I-32)', () => {
    // The ordering is the whole guarantee and it is expressed as *line order* in one
    // method, which no type can enforce. So it is asserted directly: the harvest call
    // appears before the call that runs `git add -A`.
    const executor = codeOnly(read(join(ROOT, 'src/app/task-executor.ts')).text);

    const harvest = executor.indexOf('this.harvestCollaboration(');
    const capture = executor.indexOf('this.observeChange(workspace)');

    expect(harvest, 'the harvest call').toBeGreaterThan(-1);
    expect(capture, 'the tree capture').toBeGreaterThan(-1);
    expect(harvest).toBeLessThan(capture);
  });

  it('gives an agent no field in which to name its own sender (I-28)', () => {
    // The defence is the *absence* of the field: Zod strips unknown keys, so a forged
    // `from` is discarded by the parse rather than by a check somebody has to remember
    // to write. A `from` appearing in the proposed shape would silently re-open it.
    const schema = read(join(ROOT, 'src/contracts/collaboration.schema.ts')).text;
    const proposed = schema.slice(schema.indexOf('export const ProposedMessageSchema'));
    const body = proposed.slice(0, proposed.indexOf('});'));

    expect(codeOnly(body)).not.toMatch(/\bfrom:/);
  });
});

/**
 * The assignment authority is one module, and everything else reads its answer (M5, §43).
 *
 * **The rule these enforce is I-33**: an agent-authored message may say "Frontend should
 * take this" and only `core/team/policy.ts` assigns. Every rule below is one way that
 * could quietly stop being true — a second scorer in the browser, a handoff projection
 * that reroutes, an ownership matcher that grew a filesystem call — and each of them
 * would be discovered by a run that dispatched a task nobody could do.
 */
describe('one module decides who executes a task (M5, I-33 … I-39)', () => {
  const TEAM = sourceFiles('src/core/team').map(read);

  it('has a team core that imports no provider, adapter, port or Node built-in', () => {
    // The scoring function must be answerable on paper. A module that could reach a
    // provider could score a candidate by asking one, and the answer would stop being
    // reproducible from the log — which is the whole of I-34.
    const offenders = TEAM.filter(({ text }) =>
      importSpecifiers(text).some(
        (specifier) =>
          specifier.startsWith('node:') ||
          specifier.includes('/adapters/') ||
          specifier.includes('/ports/') ||
          specifier.includes('/app/') ||
          specifier.includes('/server/') ||
          specifier.includes('/cli/'),
      ),
    ).map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('answers the capability question through a predicate, never a capability map', () => {
    // `resolveRole` owns "can this runner do this work". A second implementation inside
    // the policy would be a second answer, and the one that disagrees shows up as a wave
    // that dispatched a task nobody could run.
    const offenders = TEAM.filter(({ text }) =>
      importSpecifiers(text).some((specifier) => specifier.includes('core/role')),
    ).map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('keeps the ownership matcher away from Git, the filesystem and any process', () => {
    // I-37: ownership is coordination, never containment. A matcher that could stat a
    // path would be a sandbox implemented in a policy file, and it would be the weakest
    // one in the product — the execution boundary is the worktree and the process group.
    const ownership = read(join(ROOT, 'src/core/team/ownership.ts'));

    expect(codeOnly(ownership.text)).not.toMatch(/\b(?:exec|spawn|readFile|stat|realpath)\b/i);
    expect(importSpecifiers(ownership.text)).toEqual([
      '../../contracts/index.js',
    ]);
  });

  it('normalises every path through the one function that already rejects traversal', () => {
    // A second path rule is a second chance to miss one of `..`, a drive letter or a
    // percent-encoded separator. The matcher delegates and holds no list of its own.
    const ownership = read(join(ROOT, 'src/core/team/ownership.ts'));

    expect(ownership.text).toContain('validateAndNormalizeRepositoryPath');
    expect(codeOnly(ownership.text)).not.toMatch(/\.\.\//);
  });

  it('has exactly one `resolveTaskAgent`, and it is the policy', () => {
    // The seam M4 built so that M5 would have somewhere to put a decision rather than a
    // second router beside the first. Two definitions is two answers to "who executes
    // this task", and the second one is reached by whichever caller imported it.
    const definitions = sourceFiles('src')
      .map(read)
      .filter(({ text }) => /export function resolveTaskAgent\b/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(definitions).toEqual(['src/core/team/policy.ts']);
  });

  it('lets the handoff projection project, and nothing else', () => {
    // A handoff is a conversation folded out of the message log. Deciding what one
    // *means* belongs to the policy, and keeping the two apart is what stops an accepted
    // message from being an instruction (I-33).
    const handoffs = read(join(ROOT, 'src/core/collaboration/handoffs.ts'));
    const code = codeOnly(handoffs.text);

    expect(code).not.toMatch(/resolveTaskAgent|rankCandidates|bestCandidate/);
    expect(handoffs.text).toMatch(/export function projectHandoffs\b/);
    // One export: a projection module that grew a second function is a module that is
    // becoming something else.
    expect([...code.matchAll(/export (?:function|const) (\w+)/g)].map((m) => m[1])).toEqual([
      'projectHandoffs',
    ]);
  });

  it('is called from four places, each of which is the same question', () => {
    // The policy defines it; the collaboration service asks it for the task about to
    // run; the wave constraint asks it a wave early, to find out whether the team has
    // room; and M6's reviewer selector asks it about a different piece of work — who
    // reviews this change — with review skills required and the author excluded. Four
    // call sites and one answer.
    //
    // The fourth is the charter's own instruction: "Reutilize M5. Não crie
    // `ReviewRouter`." A reviewer is assigned work, and this product has one function
    // that decides who does work.
    //
    // A fourth would need justifying here. The failure it guards against is a second
    // *implementation*, not a second caller: a module that scored candidates itself
    // would not appear in this list at all, which is what the `resolveTaskAgent` and
    // `Scheduler` uniqueness rules above are for.
    const callers = sourceFiles('src')
      .map(read)
      .filter(({ text }) => /\bresolveTaskAgent\s*\(/.test(codeOnly(text)))
      .map(({ path }) => path)
      .sort();

    expect(callers).toEqual([
      'src/app/collaboration-service.ts',
      'src/core/review/reviewer.ts',
      'src/core/team/policy.ts',
      'src/core/team/waves.ts',
    ]);
  });

  it('writes `task_assigned` from the executor alone', () => {
    // The audit row *is* the assignment record (M5-ACC-14). A second writer would be a
    // second account of one decision, and a crash between the two writes would leave
    // them disagreeing about who holds a task.
    const writers = sourceFiles('src')
      .map(read)
      .filter(({ text }) => /appendEvent\([^)]*['"]task_assigned['"]/.test(withoutComments(text)))
      .map(({ path }) => path);

    expect(writers).toEqual(['src/app/task-executor.ts']);
  });

  it('has one scheduler, and the team constraint is not a second one', () => {
    // §9 absolute. The constraint answers a question the scheduler asks it; it owns no
    // loop, dispatches nothing and decides no ordering.
    const schedulers = sourceFiles('src')
      .map(read)
      .filter(({ text }) => /export class Scheduler\b/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(schedulers).toEqual(['src/app/scheduler.ts']);

    const waves = codeOnly(read(join(ROOT, 'src/core/team/waves.ts')).text);
    expect(waves).not.toMatch(/\b(?:while|for)\s*\(.*\battempt/);
    expect(waves).not.toMatch(/\bexecute\s*\(|\bdispatch\b/);
  });

  it('derives busy from run state and stores it nowhere (I-39)', () => {
    // A persisted `busy` outlives the crash that ended the work, and the member it named
    // is then locked out of every later wave with nothing to explain it.
    const offenders = [...sourceFiles('src/core/team'), ...sourceFiles('src/contracts')]
      .map(read)
      .filter(({ text }) => /\b(?:busy|isBusy|currentlyRunning)\s*:/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('gives an agent no field in which to claim ownership or capacity (I-38)', () => {
    // Ownership and capacity are configuration a person wrote. The defence is the
    // absence of the field: Zod strips unknown keys, so a proposed `ownership` is
    // discarded by the parse rather than by a check somebody has to remember to write.
    const schema = read(join(ROOT, 'src/contracts/collaboration.schema.ts')).text;
    const proposed = schema.slice(schema.indexOf('export const ProposedMessageSchema'));
    const body = codeOnly(proposed.slice(0, proposed.indexOf('});')));

    expect(body).not.toMatch(/\b(?:ownership|capacity|assignTo|agentId|skills)\s*:/);
  });
});

/**
 * Review is advice; the gate is the authority (M6, §66, I-42 … I-47).
 *
 * Eleven rules the charter names. Two of them live in the dashboard's own suite, because
 * that is where the code they forbid would be written; the nine here are about who may
 * decide what, and each one is a way a model's opinion could quietly become a verdict.
 */
describe('a review proposes and a gate decides (M6, I-42 … I-47)', () => {
  const REVIEW = sourceFiles('src/core/review').map(read);

  it('keeps the review core free of providers, adapters, ports and Node', () => {
    // The same rule the team core lives under: a module that could reach a provider could
    // decide a finding by asking one, and the answer would stop being reproducible from
    // the log.
    const offenders = REVIEW.filter(({ text }) =>
      importSpecifiers(text).some(
        (specifier) =>
          specifier.startsWith('node:') ||
          specifier.includes('/adapters/') ||
          specifier.includes('/ports/') ||
          specifier.includes('/app/') ||
          specifier.includes('/server/') ||
          specifier.includes('/cli/'),
      ),
    ).map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('gives an implementer no way to approve its own work (I-42)', () => {
    // `is_author` is an exclusion in the assignment policy, checked before every other
    // filter — not a field recorded after the fact, which is what M5 had and what
    // described the problem while refusing nothing.
    //
    // Read with `withoutComments` rather than `codeOnly`: this rule is *about* the
    // literals, and `codeOnly` blanks exactly those.
    const assignment = withoutComments(read(join(ROOT, 'src/core/team/assignment.ts')).text);

    expect(assignment).toMatch(/isAuthor\?\.\([^)]*\) === true\) return 'is_author'/);
    // First, so an author is never reported as merely at capacity — a reason a person
    // would try to fix by raising a number.
    expect(assignment.indexOf("return 'is_author'")).toBeLessThan(
      assignment.indexOf("return 'role_mismatch'"),
    );
  });

  it('stores a finding without a status (I-43)', () => {
    // A *projection* has one by design — that is what it is for. What must not exist is a
    // persisted one: a column somebody writes is the second copy, and it is the one a
    // crash between two writes leaves wrong and an agent could eventually reach.
    const schema = read(join(ROOT, 'src/contracts/review.schema.ts')).text;

    for (const name of ['ReviewFindingSchema', 'ReviewRecordSchema']) {
      const declaration = schema.slice(schema.indexOf(`export const ${name}`));
      const body = codeOnly(declaration.slice(0, declaration.indexOf('});')));
      expect(body, name).not.toMatch(/\bstatus:/);
    }
  });

  it('lets collaboration answer a finding and never verify one', () => {
    // A message may acknowledge or dispute. `verified` comes from a later review that
    // read a corrected tree, or from a gate — never from something somebody said.
    const findings = codeOnly(read(join(ROOT, 'src/core/review/findings.ts')).text);

    expect(findings).toMatch(/if \(!hasCorrective\) return undefined;/);
    expect(findings).not.toMatch(/message[^;\n]*'verified'/);
  });

  it('gives a review no way to mark a quality gate passed (I-44)', () => {
    // A gate's status comes from an exit code Agent Flow read. Nothing in the review
    // domain may produce one from anything else.
    const service = codeOnly(read(join(ROOT, 'src/app/review-service.ts')).text);

    expect(service).not.toMatch(/status:\s*'passed'/);
  });

  it('gives a quality gate no field to carry a command in', () => {
    // §37: "command continua vindo da configuração humana existente. Nunca de LLM
    // output." The guarantee is structural rather than a substring somebody could keep
    // while changing what it does — a gate declares what a run *means*, and the only
    // place a command lives is the validation registry a person wrote.
    //
    // Checking that `gates.ts` mentions `registry.resolve` was the first version of this,
    // and a mutation that stopped resolving through it left the mention behind and passed.
    const schema = read(join(ROOT, 'src/contracts/review.schema.ts')).text;
    const declaration = schema.slice(schema.indexOf('export const QualityGateConfigSchema'));
    const body = codeOnly(declaration.slice(0, declaration.indexOf('});')));

    expect(body).not.toMatch(/\b(?:command|script|run|shell|exec):/);
  });

  it('spawns nothing from the review core', () => {
    const offenders = REVIEW.filter(({ text }) =>
      /\b(?:exec|spawn|execSync|execFile)\s*\(/.test(codeOnly(text)),
    ).map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('decides review freshness from tree identity, never from a clock', () => {
    // I-41. A review written after a change can still have read what came before it, so
    // a timestamp answers a different question from the one being asked.
    const decision = codeOnly(read(join(ROOT, 'src/core/review/decision.ts')).text);

    expect(decision).toMatch(/reviewedTree !== input\.integratedTree/);
    expect(decision).not.toMatch(/\bDate\b|createdAt\s*[<>]/);
  });

  it('has one authority over whether a change may proceed', () => {
    // `decideQuality`, and nothing beside it. Two functions answering "may this proceed"
    // is two answers, and the second one is reached by whichever caller imported it.
    const definitions = sourceFiles('src')
      .map(read)
      .filter(({ text }) => /export function decideQuality\b/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(definitions).toEqual(['src/core/review/decision.ts']);
  });

  it('leaves corrective work going through the assignment policy and the scheduler', () => {
    // §66's last three. A corrective task is a task in the plan: the generator adds it
    // and nothing else touches it, so it is routed, isolated, validated and integrated by
    // the same machinery as the work it corrects.
    const corrective = codeOnly(read(join(ROOT, 'src/core/review/corrective.ts')).text);

    // No dispatch, no worktree, no direct patching — it selects and reshapes, and the
    // task it produces is handed to the generator that puts it in the plan.
    expect(corrective).not.toMatch(/\bexecute\b|\bdispatch\b|worktree|writeFile|spawn/);
    // And it reaches nothing that could run the fix itself.
    expect(
      importSpecifiers(read(join(ROOT, 'src/core/review/corrective.ts')).text).filter(
        (specifier) => specifier.includes('/app/') || specifier.startsWith('node:'),
      ),
    ).toEqual([]);
  });

  it('adds corrective tasks to the plan in exactly one place', () => {
    const generators = sourceFiles('src')
      .map(read)
      .filter(({ text }) => /export function applyFixes\b/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(generators).toEqual(['src/core/corrective-plan.ts']);
  });
});

/**
 * §70's reality test, as a rule rather than a habit.
 *
 * **The live dogfood found what 3893 green tests could not.** `correctiveSelection` was
 * written, reviewed and covered, and no production code called it: a code-review finding
 * could not become a corrective task, so the whole `open → fixed → verified` lifecycle
 * was unreachable however many findings a real reviewer raised. The tests all called the
 * selector themselves, which is precisely the shape §70 warns about — "could every test
 * pass while no real agent could ever reach this path?"
 *
 * So the rule asks the question mechanically. A pure function nobody calls is not dead
 * code to be tidied later; in this layer it is a feature that does not exist.
 */
describe('every review capability is reachable from production code (§70)', () => {
  const REVIEW_CORE = 'src/core/review';

  /** Exported names, from the declaration forms this codebase actually uses. */
  function exportedNames(text: string): string[] {
    const code = codeOnly(text);
    const out: string[] = [];
    for (const match of code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
      if (match[1]) out.push(match[1]);
    }
    for (const match of code.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=/g)) {
      if (match[1]) out.push(match[1]);
    }
    return out;
  }

  it('reaches every function it exports from something the product runs', () => {
    const files = sourceFiles(REVIEW_CORE).map(read);
    const own = new Set(files.map(({ path }) => path));

    // Where a name is declared, so reaching a name can make its file live.
    const declaredIn = new Map<string, string>();
    for (const { path, text } of files) {
      for (const name of exportedNames(text)) declaredIn.set(name, path);
    }

    // **Live** starts as everything outside this directory: the app, the server, the CLI,
    // the adapters — the code the product actually runs. Tests are not here on purpose. A
    // capability whose only caller is a test is the situation this rule rejects.
    const live = sourceFiles('src')
      .map(read)
      .filter(({ path }) => !own.has(path))
      .map(({ text }) => codeOnly(text));

    // A name referenced by live code is reached; reaching it makes its own file live, so
    // whatever *it* calls is reached too. Repeated to a fixed point, which is what makes
    // an internal collaborator three modules deep count as wired.
    const reached = new Set<string>();
    for (let changed = true; changed; ) {
      changed = false;
      for (const [name, path] of declaredIn) {
        if (reached.has(name)) continue;
        if (!live.some((text) => new RegExp(`\\b${name}\\b`).test(text))) continue;
        reached.add(name);
        const source = files.find((file) => file.path === path);
        if (source !== undefined) live.push(codeOnly(source.text));
        changed = true;
      }
    }

    const unreachable = [...declaredIn]
      .filter(([name]) => !reached.has(name))
      .map(([name, path]) => `${path}: ${name}`);

    expect(unreachable).toEqual([]);
  });
});
