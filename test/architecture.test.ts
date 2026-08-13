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

/** Strips comments and string literals so identifier scans do not hit prose. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
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
    const { text } = read(join(ROOT, 'src/app/task-workspaces.ts'));
    const code = codeOnly(text);

    expect(code).toContain('config.project?.commands?.install');
    expect(code).toContain('runCommands');

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
    expect(code).toMatch(/maxConcurrency:\s*concurrency\.effective/);
    // The shape of the bug, spelled out so it cannot come back by copy-paste.
    expect(code).not.toMatch(/maxConcurrency:\s*config\.global\.parallelism\.maxTasks/);
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
    const PREPARES = ['src/app/task-workspaces.ts', 'src/cli/doctor.ts'];
    const RECLAIMS = ['src/cli/doctor.ts'];

    const offenders: string[] = [];
    for (const file of sourceFiles('src')) {
      const { path, text } = read(file);
      if (path.startsWith('src/adapters/git/')) continue;
      const code = codeOnly(text);

      if (!PREPARES.includes(path) && /\.addWorktree\s*\(/.test(code)) {
        offenders.push(`${path}: addWorktree`);
      }
      for (const method of ['removeWorktree', 'unlockWorktree', 'pruneWorktrees']) {
        if (!RECLAIMS.includes(path) && new RegExp(`\\.${method}\\s*\\(`).test(code)) {
          offenders.push(`${path}: ${method}`);
        }
      }
      // M2-05's, and still nobody's.
      for (const method of ['commitTree', 'updateRef', 'writeTree', 'stageAll', 'abortMerge']) {
        if (new RegExp(`\\.${method}\\s*\\(`).test(code)) {
          offenders.push(`${path}: ${method}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('writes a task result from the executor only (M2-04)', () => {
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
    const WRITER = 'src/app/task-executor.ts';

    const offenders = sourceFiles('src')
      .map((file) => read(file))
      .filter(({ path }) => path !== WRITER && path !== 'src/app/paths.ts')
      // `state-store.ts` reads one back; reading is not writing.
      .filter(({ path }) => path !== 'src/app/state-store.ts')
      .filter(({ text }) => /taskResult\s*\(/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);

    // Positive control: the writer still writes, so the rule is guarding a real
    // call rather than a name nothing uses any more.
    expect(codeOnly(read(join(ROOT, WRITER)).text)).toMatch(/taskResult\s*\(/);

    // And the scheduler does not build one. `TaskResultSchema` is how the fiction
    // would be assembled — parsed, so it would even look careful.
    const scheduler = codeOnly(read(join(ROOT, 'src/app/scheduler.ts')).text);
    expect(scheduler).not.toContain('TaskResultSchema');
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
    const FORCES = ['src/cli/doctor.ts'];
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

  it('hands no production caller the isolated ceiling (I-11, M2-11)', () => {
    // Having the capability is not using it. `resolveTaskConcurrency` grew a
    // second parameter in M2-01 and every production call still passes one
    // argument, so the effective concurrency of a real run is one — whatever the
    // configuration says and whatever mode a run records.
    //
    // M2-11 is the milestone that changes this, and this is the test it has to
    // come and edit. Until then, a second argument appearing anywhere in `src` is
    // parallelism arriving without the machinery that makes it safe.
    const passesTheMode = (source: string): boolean =>
      /resolveTaskConcurrency\s*\([^)]*,/.test(codeOnly(source));

    // A rule that cannot see the thing it forbids passes forever. The literal is
    // blanked by `codeOnly`, so the detection is on the argument, not its value.
    expect(passesTheMode("resolveTaskConcurrency(config.parallelism.maxTasks, 'worktree')")).toBe(
      true,
    );
    expect(passesTheMode('resolveTaskConcurrency(config.parallelism.maxTasks, mode)')).toBe(true);
    expect(passesTheMode('resolveTaskConcurrency(config.parallelism.maxTasks)')).toBe(false);

    const offenders = sourceFiles('src')
      .map(read)
      // The resolver's own signature is where the second parameter is declared.
      .filter(({ path }) => path !== RESOLVER)
      .filter(({ text }) => passesTheMode(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
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

  it('writes no attempt artifact yet', () => {
    // The attempt artifact is M2-05. The contract lands early so the adapters can
    // be built against it, but a *writer* appearing before the receipt machinery
    // would put a file on disk claiming evidence nothing produced.
    const declaresIt = new Set(['src/contracts/attempt.schema.ts', 'src/contracts/index.ts']);

    const offenders = sourceFiles('src')
      .map(read)
      .filter(({ path }) => !declaresIt.has(path))
      .filter(
        ({ text }) =>
          /TaskAttemptResult|AttemptReceipt/.test(codeOnly(text)) ||
          importSpecifiers(text).some((specifier) => specifier.includes('attempt.schema')),
      )
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
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
    const { text } = read(join(ROOT, 'src/server/project-registry.ts'));
    const registry = codeOnly(text);

    expect(importSpecifiers(text)).toContain('node:path');
    expect(registry).toMatch(/\.relative\(/);
    // No separator arithmetic left. The slug's own `[^a-z0-9]` class is not path
    // logic and lives in `slug`, which `codeOnly` blanks as a literal.
    expect(registry).not.toMatch(/lastIndexOf\(/);
    expect(registry).not.toMatch(/startsWith\(\s*root/);
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
      // The server reads the lock for a pre-flight conflict answer; it never takes it.
      'src/server/server.ts',
    ]);

    const server = codeOnly(read(join(ROOT, 'src/server/server.ts')).text);
    expect(server).toContain('.describe(');
    expect(server, 'the server acquires the lock itself').not.toContain('.acquire(');
  });

  it('holds the lock across every action that moves a run', () => {
    // `start`, `revise` and `retryTask` touch a run while a scheduler might be running;
    // `approve` and `reject` move the gate that decides whether it may (AF-L01.2).
    // Every one goes through the helper rather than doing its own acquire/release, so
    // none of them can forget the `finally` — and there is one lease, not two mutexes
    // that would each exclude a set of peers the other was not in.
    const actions = read(join(ROOT, 'src/app/run-actions.ts')).text;
    const locked = [...actions.matchAll(/withExecutionLock\(deps, store, runId, '(\w+)'/g)].map(
      (match) => match[1],
    );

    expect(locked.sort()).toEqual(['approve', 'reject', 'retry', 'revise', 'run']);
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
