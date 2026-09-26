import { describe, it, expect } from 'vitest';
import { ProjectConfigSchema, RolesConfigSchema } from '../../src/contracts/index.js';
import {
  commandCitations,
  commandGrantsFor,
  executorCommandsOf,
  uncoveredCitations,
} from '../../src/core/command-grants.js';
import type { RunnerCapabilities } from '../../src/ports/agent-runner.js';

const project = (commands: Record<string, string>, validationCommands: Record<string, string> = {}) =>
  ProjectConfigSchema.parse({ project: { name: 'demo', type: 'node' }, commands, validationCommands });

describe('commandGrantsFor (FR-001, FR-004, SEC-001, SEC-002)', () => {
  const declared = project(
    { install: 'npm ci', lint: 'eslint src/**/*.ts', test: '  npm run test  ' },
    {
      'typecheck-deck': 'npm run typecheck:deck',
      single: 'vitest run test/?',
      chained: 'npm run a && npm run b',
      home: 'echo $HOME',
    },
  );

  it('grants a safe line, trimmed, and excludes every unsafe one with its reason', () => {
    const grants = commandGrantsFor(declared, true);

    expect(grants.granted).toEqual(['npm run test', 'npm run typecheck:deck']);
    expect(grants.excluded).toEqual([
      { id: 'chained', line: 'npm run a && npm run b', reason: 'shell_syntax' },
      { id: 'home', line: 'echo $HOME', reason: 'shell_syntax' },
      { id: 'install', line: 'npm ci', reason: 'install' },
      { id: 'lint', line: 'eslint src/**/*.ts', reason: 'wildcard' },
      { id: 'single', line: 'vitest run test/?', reason: 'wildcard' },
    ]);
  });

  it('grants nothing to an untrusted project, and still names what it would exclude', () => {
    const grants = commandGrantsFor(declared, false);
    expect(grants.granted).toEqual([]);
    expect(grants.excluded.map(({ id }) => id)).toContain('install');
    // Positive control: the same project, trusted, is granted lines.
    expect(commandGrantsFor(declared, true).granted).not.toEqual([]);
  });

  it('grants nothing when there is no project file', () => {
    expect(commandGrantsFor(undefined, true)).toEqual({ granted: [], excluded: [] });
  });

  it.each([
    ['a pipe', 'npm test | tee out'],
    ['a semicolon', 'npm test; rm -rf x'],
    ['a redirection', 'npm test > out'],
    ['an input redirection', 'npm test < in'],
    ['a backtick', 'npm test `id`'],
    ['parentheses', 'npm test (x)'],
    ['a double quote', 'npm test "a b"'],
    ['a single quote', "npm test 'a b'"],
    ['a percent sign', 'npm test %PATH%'],
  ])('excludes a line with %s', (_label, line) => {
    expect(commandGrantsFor(project({ test: line }), true)).toEqual({
      granted: [],
      excluded: [{ id: 'test', line, reason: 'shell_syntax' }],
    });
  });

  it('excludes a line break and a blank declaration', () => {
    const grants = commandGrantsFor(project({ build: '   ' }, { multi: 'npm run a\nnpm run b' }), true);
    expect(grants.granted).toEqual([]);
    expect(grants.excluded).toEqual([
      { id: 'build', line: '', reason: 'empty' },
      { id: 'multi', line: 'npm run a\nnpm run b', reason: 'line_break' },
    ]);
  });

  it('grants a line shared by two ids once, in registry id order', () => {
    const grants = commandGrantsFor(project({ test: 'npm test', lint: 'npm run lint' }, { unit: 'npm test' }), true);
    expect(grants.granted).toEqual(['npm run lint', 'npm test']);
  });

  it('does not report a blank standard step that a validation command overrides', () => {
    const grants = commandGrantsFor(project({ test: ' ' }, { test: 'npm test' }), true);
    expect(grants).toEqual({ granted: ['npm test'], excluded: [] });
  });
});

describe('executorCommandsOf (FR-008)', () => {
  /** Every non-executor role points at a runner no test gives capabilities, so none can leak in. */
  const roles = (runners: { trivial: string; normal: string; complex: string }, disabled: readonly string[] = []) => {
    const other = { runner: 'elsewhere', effort: 'high' };
    return RolesConfigSchema.parse({
      architect: other,
      sdd: other,
      planner: other,
      planReviewer: other,
      verification: other,
      finalReviewer: other,
      executors: {
        trivial: { runner: runners.trivial, effort: 'low', enabled: !disabled.includes('trivial') },
        normal: { runner: runners.normal, effort: 'medium', enabled: !disabled.includes('normal') },
        complex: { runner: runners.complex, effort: 'high', enabled: !disabled.includes('complex') },
      },
    });
  };

  const caps = (grants: Partial<RunnerCapabilities['nonInteractiveToolGrants']>): RunnerCapabilities => ({
    supportedReasoningLevels: ['low', 'medium', 'high'],
    supportsReadOnly: true,
    supportsNonInteractive: true,
    supportsWorkingDirectory: true,
    structuredOutputStrategy: 'native',
    nonInteractiveToolGrants: { fileEdit: true, commandExecution: true, ...grants },
  });

  it('is unknown when a route does not report its prefixes', () => {
    const result = executorCommandsOf(roles({ trivial: 'a', normal: 'b', complex: 'a' }), {
      a: caps({ grantedCommandPrefixes: ['npm run lint'], grantsAnyCommand: true }),
      b: caps({}),
    });
    expect(result).toEqual({ known: false, any: false, prefixes: [] });
  });

  it('is unknown when a route has no registered runner', () => {
    const result = executorCommandsOf(roles({ trivial: 'a', normal: 'a', complex: 'missing' }), {
      a: caps({ grantedCommandPrefixes: ['npm run lint'], grantsAnyCommand: false }),
    });
    expect(result.known).toBe(false);
  });

  it('intersects the prefixes of every route', () => {
    const result = executorCommandsOf(roles({ trivial: 'a', normal: 'b', complex: 'c' }), {
      a: caps({ grantedCommandPrefixes: ['npm run lint', 'npm test', 'npx vitest'], grantsAnyCommand: false }),
      b: caps({ grantedCommandPrefixes: ['npm test', 'npm run lint'], grantsAnyCommand: true }),
      c: () => caps({ grantedCommandPrefixes: ['npm test', 'npm run lint', 'npm run build'], grantsAnyCommand: false }),
    });
    expect(result).toEqual({ known: true, any: false, prefixes: ['npm run lint', 'npm test'] });
  });

  it('grants any only when every route grants any', () => {
    const everyRoute = executorCommandsOf(roles({ trivial: 'a', normal: 'a', complex: 'b' }), {
      a: caps({ grantedCommandPrefixes: [], grantsAnyCommand: true }),
      b: caps({ grantedCommandPrefixes: [], grantsAnyCommand: true }),
    });
    expect(everyRoute.any).toBe(true);

    const oneRoute = executorCommandsOf(roles({ trivial: 'a', normal: 'a', complex: 'b' }), {
      a: caps({ grantedCommandPrefixes: [], grantsAnyCommand: true }),
      b: caps({ grantedCommandPrefixes: [], grantsAnyCommand: false }),
    });
    expect(oneRoute).toEqual({ known: true, any: false, prefixes: [] });
  });

  it('ignores a disabled route, and is unknown when none is enabled', () => {
    const capabilities = {
      a: caps({ grantedCommandPrefixes: ['npm test'], grantsAnyCommand: false }),
      b: caps({}),
    };
    expect(executorCommandsOf(roles({ trivial: 'b', normal: 'a', complex: 'a' }, ['trivial']), capabilities)).toEqual({
      known: true,
      any: false,
      prefixes: ['npm test'],
    });
    expect(
      executorCommandsOf(roles({ trivial: 'a', normal: 'a', complex: 'a' }, ['trivial', 'normal', 'complex']), capabilities)
        .known,
    ).toBe(false);
  });
});

describe('commandCitations (FR-009, SEC-003)', () => {
  const commands = ['npm run test', 'npx vitest'];

  it('reads inline spans of two or more words whose first word opens a known command', () => {
    expect(commandCitations('Run `npm run e2e:android` and `npx  vitest run x.test.ts`.', commands)).toEqual([
      'npm run e2e:android',
      'npx vitest run x.test.ts',
    ]);
  });

  it('reads every line of a fenced block, and no span inside it', () => {
    const text = ['Before `npm run a`.', '```sh', 'npm run b', '', 'echo `npm run c`', '```', 'After.'].join('\n');
    expect(commandCitations(text, commands)).toEqual(['npm run b', 'npm run a']);
  });

  it('treats a tilde fence like a backtick fence, and only its own kind closes it', () => {
    const text = ['~~~', 'npm run b', '```', 'npm run c', '~~~', '`npm run d`'].join('\n');
    expect(commandCitations(text, commands)).toEqual(['npm run b', 'npm run c', 'npm run d']);
  });

  it('ignores a single word, an unknown first word, and prose', () => {
    expect(
      commandCitations('Bump `npm`, edit `src/app/x.ts`, call `adb shell ls`, then npm run e2e in prose.', commands),
    ).toEqual([]);
  });

  it('matches a double-backtick span as one span, and lists each citation once', () => {
    expect(commandCitations('``npm run `x` y`` and `npm run e2e` and `npm run e2e`', commands)).toEqual([
      'npm run `x` y',
      'npm run e2e',
    ]);
  });

  it('finds nothing when no command is known', () => {
    expect(commandCitations('`npm run e2e:android`', [])).toEqual([]);
  });
});

describe('uncoveredCitations (FR-009)', () => {
  const commands = ['npm run test', 'npx vitest'];

  it('covers an exact command and a command followed by a space', () => {
    expect(uncoveredCitations(['npm run test', 'npm run test -- --run', 'npx vitest run x.test.ts'], commands)).toEqual([]);
  });

  it('does not cover a longer word that merely starts with a command', () => {
    expect(uncoveredCitations(['npm run test:deck', 'npm run e2e:android'], commands)).toEqual([
      'npm run test:deck',
      'npm run e2e:android',
    ]);
  });
});
