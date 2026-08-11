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
