import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { ClaudeCodeRunner } from '../../src/adapters/runners/claude-code-runner.js';
import type { AgentRunInput } from '../../src/ports/index.js';

/**
 * Not one real CLI invocation in this file.
 *
 * Two things are asserted: the exact argv built for a given input, and the
 * parsing of output recorded from the real CLI in AF-10. That is what keeps the
 * suite fast, free, and still honest about the wire format.
 */

const FIXTURES = join(import.meta.dirname, '../fixtures/responses/claude');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

function makeRunner(proc = new FakeProcessRunner()) {
  return { runner: new ClaudeCodeRunner({ id: 'claude', processRunner: proc }), proc };
}

const baseInput: AgentRunInput = {
  prompt: 'Analyse this repository.',
  reasoning: 'high',
  workingDirectory: '/repo',
  permissions: 'read-only',
  timeoutSeconds: 900,
};

/** Value that follows a flag in argv, or undefined when the flag is absent. */
function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('capabilities', () => {
  it('reports native structured output (proven in AF-10)', () => {
    expect(makeRunner().runner.capabilities().structuredOutputStrategy).toBe('native');
  });

  it('reports all four logical reasoning levels', () => {
    expect(makeRunner().runner.capabilities().supportedReasoningLevels).toEqual([
      'low',
      'medium',
      'high',
      'very_high',
    ]);
  });

  it('reports read-only and non-interactive support', () => {
    const caps = makeRunner().runner.capabilities();
    expect(caps.supportsReadOnly).toBe(true);
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsWorkingDirectory).toBe(true);
  });
});

describe('command execution grant (D-9)', () => {
  it('is not granted by default: acceptEdits alone runs no command in -p', () => {
    expect(makeRunner().runner.capabilities().nonInteractiveToolGrants?.commandExecution).toBe(false);
  });

  const grants = (platform: NodeJS.Platform, ...rules: string[]) => new ClaudeCodeRunner({
    id: 'claude',
    processRunner: new FakeProcessRunner(),
    platform,
    extraArgs: ['--allowedTools', ...rules],
  }).capabilities().nonInteractiveToolGrants?.commandExecution;

  it('is granted when the runner args allow a Bash command', () => {
    // Measured on the Deck, 23/09/2026: a project declared
    // `--allowedTools Bash(docker run --rm --network none:*)`, `doctor` in the terminal said
    // OK, and the Diagnostics page said "falta permissão" for every executor — the page read
    // this static `false` and never the args the operator wrote.
    expect(grants('linux', 'Bash(npm run:*)', 'Bash(git status:*)')).toBe(true);
    expect(grants('darwin', 'Bash(npm run:*)')).toBe(true);
  });

  it('on Windows, is granted by the PowerShell rule and not by a Bash one', () => {
    // Measured 23/09/2026 on claude 2.1.280 / Windows: with only
    // `Bash(docker run --rm --network none:*)` the command was denied, and
    // `permission_denials[0].tool_name` was "PowerShell". The same rule declared as
    // `PowerShell(...)` ran it. Counting the Bash rule there reported a grant that is not one.
    expect(grants('win32', 'PowerShell(docker run --rm --network none:*)')).toBe(true);
    expect(grants('win32', 'Bash(docker run --rm --network none:*)')).toBe(false);
    expect(grants('win32', 'Bash(npm test:*)', 'PowerShell(npm test:*)')).toBe(true);
  });

  it('elsewhere, is not granted by a PowerShell rule alone', () => {
    expect(grants('linux', 'PowerShell(npm test:*)')).toBe(false);
  });

  it('reads the flag written with an equals sign too', () => {
    const runner = (arg: string) => new ClaudeCodeRunner({
      id: 'claude',
      processRunner: new FakeProcessRunner(),
      platform: 'win32',
      extraArgs: [arg],
    }).capabilities().nonInteractiveToolGrants?.commandExecution;
    expect(runner('--allowedTools=PowerShell(npm test:*)')).toBe(true);
    expect(runner('--allowed-tools=Read,PowerShell(git status:*)')).toBe(true);
    expect(runner('--allowedTools=Bash(npm test:*)')).toBe(false);
  });

  it('is not granted by an allowlist that names no Bash command', () => {
    const runner = new ClaudeCodeRunner({
      id: 'claude',
      processRunner: new FakeProcessRunner(),
      extraArgs: ['--allowedTools', 'mcp__codegraph'],
    });
    expect(runner.capabilities().nonInteractiveToolGrants?.commandExecution).toBe(false);
  });
});

describe('derived command grants on write invocations (FR-001, FR-005, FR-006)', () => {
  const writeInput: AgentRunInput = { ...baseInput, permissions: 'write' };

  interface ArgvCase {
    readonly platform: NodeJS.Platform;
    readonly grants?: readonly string[];
    readonly extraArgs?: readonly string[];
  }

  async function argvFor(given: ArgvCase, input: AgentRunInput = writeInput): Promise<readonly string[]> {
    const proc = new FakeProcessRunner().always({ stdout: fixture('success-json.json') });
    const runner = new ClaudeCodeRunner({
      id: 'claude',
      processRunner: proc,
      platform: given.platform,
      ...(given.grants === undefined ? {} : { commandGrants: given.grants }),
      ...(given.extraArgs === undefined ? {} : { extraArgs: given.extraArgs }),
    });
    await runner.run(input);
    return proc.lastCall?.args ?? [];
  }

  /** The tokens from the derived `--allowedTools` up to and including `acceptEdits`. */
  function derivedList(args: readonly string[]): readonly string[] {
    const mode = args.indexOf('acceptEdits');
    const flag = args.lastIndexOf('--allowedTools', mode);
    return flag === -1 ? [] : args.slice(flag, mode + 1);
  }

  it('grants each declared line by prefix, right before the permission mode, on linux', async () => {
    const args = await argvFor({ platform: 'linux', grants: ['npm run lint'] });
    expect(derivedList(args)).toEqual(['--allowedTools', 'Bash(npm run lint:*)', '--permission-mode', 'acceptEdits']);
    expect(args.some((arg) => arg.startsWith('PowerShell('))).toBe(false);
  });

  it('adds the PowerShell rule right after each Bash rule on win32', async () => {
    const args = await argvFor({ platform: 'win32', grants: ['npm run lint', 'npm run typecheck:deck'] });
    expect(derivedList(args)).toEqual([
      '--allowedTools',
      'Bash(npm run lint:*)',
      'PowerShell(npm run lint:*)',
      'Bash(npm run typecheck:deck:*)',
      'PowerShell(npm run typecheck:deck:*)',
      '--permission-mode',
      'acceptEdits',
    ]);
  });

  it('emits a line granted twice once', async () => {
    const args = await argvFor({ platform: 'linux', grants: ['npm run lint', 'npm run lint'] });
    expect(args.filter((arg) => arg === 'Bash(npm run lint:*)')).toHaveLength(1);
  });

  it.each([
    ['the identical rule', ['--allowedTools', 'Bash(npm run lint:*)']],
    ['the bare tool', ['--allowedTools', 'Bash']],
    ['a prefix ending at a word boundary', ['--allowedTools', 'Bash(npm run:*)']],
    ['a prefix inside a comma list', ['--allowedTools', 'Read,Bash(npm run:*)']],
    ['a prefix written with an equals sign', ['--allowed-tools=Bash(npm run:*)']],
  ])('omits the Bash rule the operator already grants with %s', async (_label, extraArgs) => {
    const args = await argvFor({ platform: 'linux', grants: ['npm run lint'], extraArgs });
    expect(derivedList(args)).toEqual([]);
    // The operator's args still ride last, untouched.
    expect(args.slice(-extraArgs.length)).toEqual(extraArgs);
  });

  it.each([
    ['a prefix that splits a word', 'Bash(npm r:*)'],
    ['an exact rule, which is not modelled', 'Bash(npm run lint)'],
    ['the other platform tool', 'PowerShell(npm run:*)'],
  ])('keeps the Bash rule on linux against %s', async (_label, rule) => {
    const args = await argvFor({ platform: 'linux', grants: ['npm run lint'], extraArgs: ['--allowedTools', rule] });
    expect(derivedList(args)).toEqual(['--allowedTools', 'Bash(npm run lint:*)', '--permission-mode', 'acceptEdits']);
  });

  it('on win32, an operator PowerShell prefix suppresses only the PowerShell rule', async () => {
    const args = await argvFor({
      platform: 'win32',
      grants: ['npm run lint'],
      extraArgs: ['--allowedTools', 'PowerShell(npm run:*)'],
    });
    expect(derivedList(args)).toEqual(['--allowedTools', 'Bash(npm run lint:*)', '--permission-mode', 'acceptEdits']);
  });

  it('on win32, a Bash-only operator rule does not suppress the PowerShell rule', async () => {
    const args = await argvFor({
      platform: 'win32',
      grants: ['npm run lint'],
      extraArgs: ['--allowedTools', 'Bash(npm run lint:*)'],
    });
    expect(derivedList(args)).toEqual(['--allowedTools', 'PowerShell(npm run lint:*)', '--permission-mode', 'acceptEdits']);
  });

  it('keeps the isolation args and the operator args after the derived list, operator last (SEC-004)', async () => {
    const extraArgs = ['--allowedTools', 'Read'];
    const args = await argvFor({ platform: 'linux', grants: ['npm run lint'], extraArgs });
    expect(args.slice(-extraArgs.length)).toEqual(extraArgs);
    expect(args.indexOf('Bash(npm run lint:*)')).toBeLessThan(args.indexOf('--setting-sources'));
    expect(args.indexOf('--setting-sources')).toBeLessThan(args.length - extraArgs.length);
  });

  it('leaves a read-only invocation exactly as it was (FR-002, SEC-004)', async () => {
    const withGrants = await argvFor({ platform: 'win32', grants: ['npm run lint'] }, baseInput);
    const without = await argvFor({ platform: 'win32' }, baseInput);
    expect(withGrants).toEqual(without);
    expect(withGrants.some((arg) => arg.includes('npm run lint'))).toBe(false);
  });

  it('leaves a write invocation with no grants exactly as it was, and grants change it (FR-002)', async () => {
    const empty = await argvFor({ platform: 'linux', grants: [] });
    const absent = await argvFor({ platform: 'linux' });
    const granted = await argvFor({ platform: 'linux', grants: ['npm run lint'] });
    expect(empty).toEqual(absent);
    expect(absent).not.toContain('--allowedTools');
    // Positive control: the same invocation with a grant is a different argv.
    expect(granted).not.toEqual(absent);
  });
});

describe('what the executor may run, as capabilities report it (FR-007)', () => {
  const grantsOf = (platform: NodeJS.Platform, commandGrants: readonly string[], extraArgs: readonly string[] = []) =>
    new ClaudeCodeRunner({
      id: 'claude',
      processRunner: new FakeProcessRunner(),
      platform,
      commandGrants,
      extraArgs,
    }).capabilities().nonInteractiveToolGrants;

  it('reports nothing granted, and says so, when there is nothing', () => {
    const grants = grantsOf('linux', []);
    expect(grants.commandExecution).toBe(false);
    expect(grants.grantedCommandPrefixes).toEqual([]);
    expect(grants.grantsAnyCommand).toBe(false);
  });

  it('counts a granted declared line as command execution', () => {
    expect(grantsOf('linux', ['npm run lint']).commandExecution).toBe(true);
    expect(grantsOf('win32', ['npm run lint']).commandExecution).toBe(true);
  });

  it('lists the declared lines and the operator prefixes for the platform tool, sorted and once', () => {
    const grants = grantsOf('linux', ['npm run typecheck', 'npm run lint'], [
      '--allowedTools',
      'Bash(npx vitest:*)',
      'Bash(npm run lint:*)',
      'PowerShell(npm run build:*)',
      'Read',
    ]);
    expect(grants.grantedCommandPrefixes).toEqual(['npm run lint', 'npm run typecheck', 'npx vitest']);
    expect(grants.grantsAnyCommand).toBe(false);
  });

  it('on win32 reads PowerShell prefixes and not Bash ones', () => {
    const grants = grantsOf('win32', [], ['--allowedTools', 'Bash(npx vitest:*)', 'PowerShell(npx tsc:*)']);
    expect(grants.grantedCommandPrefixes).toEqual(['npx tsc']);
  });

  it('reports any command for the bare platform tool only', () => {
    expect(grantsOf('linux', [], ['--allowedTools', 'Bash']).grantsAnyCommand).toBe(true);
    expect(grantsOf('linux', [], ['--allowedTools', 'Bash(npm:*)']).grantsAnyCommand).toBe(false);
    expect(grantsOf('win32', [], ['--allowedTools', 'Bash']).grantsAnyCommand).toBe(false);
    expect(grantsOf('win32', [], ['--allowedTools', 'PowerShell']).grantsAnyCommand).toBe(true);
  });
});

describe('ClaudeCodeRunner model suggestions (AD-13)', () => {
  const CATALOG_DIR = '/home/me/.claude/cache/model-catalog';

  /** The shape `claude 2.1.280` writes, trimmed to the fields the adapter reads. */
  function catalogFile(fetchedAt: number, models: readonly Record<string, unknown>[], surface = 'cc'): string {
    return JSON.stringify({ version: 2, fetchedAt, staleAt: fetchedAt + 3_600_000, catalog: { surface, config: { id: 'x', models } } });
  }

  function withCatalog(files: Record<string, string>, version = '2.1.280 (Claude Code)') {
    const fs = new InMemoryFileSystem();
    for (const [name, content] of Object.entries(files)) fs.seed(`${CATALOG_DIR}/${name}`, content);
    const proc = new FakeProcessRunner().always({ stdout: `${version}\n` });
    return { runner: new ClaudeCodeRunner({ id: 'claude', processRunner: proc, fs, modelCatalogDir: CATALOG_DIR }), proc };
  }

  it('falls back to the aliases the CLI documents when there is no catalog to read', async () => {
    // `claude --help` on 2.1.280: "an alias for the latest model (e.g. 'fable', 'opus', or
    // 'sonnet')". Fable was missing from the old declared list, which is how a model the
    // account could run never reached the editor.
    const runner = new ClaudeCodeRunner({ id: 'claude', processRunner: new FakeProcessRunner() });
    expect(await runner.listModels?.()).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  });

  it('offers the ids of the catalog the CLI cached for this account, then the aliases', async () => {
    const { runner } = withCatalog({
      'org-a-cc.json': catalogFile(1_000, [
        { id: 'claude-opus-5-5', section: 'main', min_claude_code_version: '2.1.280' },
        { id: 'claude-fable-5-1', section: 'main', min_claude_code_version: '2.1.251' },
        { id: 'claude-sonnet-5', section: 'main' },
        { id: 'claude-opus-5', section: 'overflow' },
      ]),
    });

    expect(await runner.listModels?.()).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-sonnet-5',
      'claude-opus-5',
      'fable',
      'opus',
      'sonnet',
      'haiku',
    ]);
  });

  it('leaves out a model the installed CLI is too old to run', async () => {
    // Offering it would let a person pin a role to an id the spawned CLI rejects, and the
    // failure would surface mid-run instead of in the editor.
    const { runner } = withCatalog({
      'org-a-cc.json': catalogFile(1_000, [
        { id: 'claude-opus-5-5', section: 'main', min_claude_code_version: '2.1.280' },
        { id: 'claude-sonnet-5', section: 'main' },
      ]),
    }, '2.1.270 (Claude Code)');

    expect(await runner.listModels?.()).toEqual(['claude-sonnet-5', 'fable', 'opus', 'sonnet', 'haiku']);
  });

  it('keeps a floored model when the CLI version cannot be read, since the CLI is the judge', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${CATALOG_DIR}/a-cc.json`, catalogFile(1_000, [{ id: 'claude-opus-5-5', section: 'main', min_claude_code_version: '2.1.280' }]));
    const proc = new FakeProcessRunner().always({ spawnFailed: true });
    const runner = new ClaudeCodeRunner({ id: 'claude', processRunner: proc, fs, modelCatalogDir: CATALOG_DIR });

    expect((await runner.listModels?.())?.[0]).toBe('claude-opus-5-5');
  });

  it('reads the most recently fetched catalog when several accounts left one', async () => {
    const { runner } = withCatalog({
      'org-old-cc.json': catalogFile(1_000, [{ id: 'claude-opus-4-6', section: 'main' }]),
      'org-new-cc.json': catalogFile(2_000, [{ id: 'claude-opus-5-5', section: 'main' }]),
    });

    const models = await runner.listModels?.();
    expect(models?.[0]).toBe('claude-opus-5-5');
    expect(models).not.toContain('claude-opus-4-6');
  });

  it('ignores a catalog that is not Claude Code\'s or does not parse, rather than failing the page', async () => {
    const { runner } = withCatalog({
      'broken-cc.json': '{ not json',
      'desktop.json': catalogFile(9_000, [{ id: 'claude-desktop-only', section: 'main' }], 'desktop'),
      'shape.json': JSON.stringify({ version: 2, catalog: { surface: 'cc', config: { models: 'nope' } } }),
    });

    expect(await runner.listModels?.()).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  });

  it('asks the CLI its version only when some model sets a floor', async () => {
    const { runner, proc } = withCatalog({ 'a-cc.json': catalogFile(1_000, [{ id: 'claude-sonnet-5', section: 'main' }]) });
    await runner.listModels?.();
    expect(proc.calls).toHaveLength(0);
  });
});

describe('argv construction', () => {
  it('runs non-interactively with JSON output', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run(baseInput);

    expect(proc.lastCall?.command).toBe('claude');
    expect(proc.lastCall?.args).toContain('-p');
    expect(valueAfter(proc.lastCall?.args ?? [], '--output-format')).toBe('json');
  });

  it('passes the prompt on stdin, never as a positional argument', async () => {
    // AF-10: --disallowedTools is variadic and swallowed a positional prompt
    // word by word. stdin removes the ambiguity and the argv length ceiling.
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run(baseInput);

    expect(proc.lastCall?.stdin).toBe('Analyse this repository.');
    expect(proc.lastCall?.args).not.toContain('Analyse this repository.');
  });

  it('targets the working directory through spawn, since there is no --cwd', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run(baseInput);
    expect(proc.lastCall?.cwd).toBe('/repo');
  });

  it('forwards the timeout to the process layer', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run({ ...baseInput, timeoutSeconds: 120 });
    expect(proc.lastCall?.timeoutSeconds).toBe(120);
  });
});

describe('model selection (AD-13)', () => {
  it('omits --model entirely when configuration names none', async () => {
    // A pinned model name rots. Leaving the flag off lets the CLI apply
    // whatever the user already configured for it.
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run(baseInput);
    expect(proc.lastCall?.args).not.toContain('--model');
  });

  it('passes the model through untouched when one is set', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run({ ...baseInput, model: 'opus' });
    expect(valueAfter(proc.lastCall?.args ?? [], '--model')).toBe('opus');
  });
});

describe('reasoning translation (R-09)', () => {
  const cases = [
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['very_high', 'xhigh'],
  ] as const;

  for (const [logical, physical] of cases) {
    it(`maps ${logical} to ${physical}`, async () => {
      const { runner, proc } = makeRunner(
        new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
      );
      await runner.run({ ...baseInput, reasoning: logical });
      expect(valueAfter(proc.lastCall?.args ?? [], '--effort')).toBe(physical);
    });
  }

  it('never emits max', async () => {
    // `max` exists but costs disproportionately more than xhigh for these
    // stages. Excluded on purpose, asserted so nobody "upgrades" it later.
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run({ ...baseInput, reasoning: 'very_high' });
    expect(proc.lastCall?.args).not.toContain('max');
  });

  it('always emits a value the CLI recognises', async () => {
    // An unknown --effort is ignored with a warning rather than failing, so a
    // wrong mapping would silently run at the default level. The CLI will not
    // catch this for us.
    const VALID = ['low', 'medium', 'high', 'xhigh', 'max'];
    for (const reasoning of ['low', 'medium', 'high', 'very_high'] as const) {
      const { runner, proc } = makeRunner(
        new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
      );
      await runner.run({ ...baseInput, reasoning });
      expect(VALID).toContain(valueAfter(proc.lastCall?.args ?? [], '--effort'));
    }
  });
});

describe('permissions (§35, AD-14)', () => {
  it('uses plan mode and denies edit tools for a read-only stage', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run({ ...baseInput, permissions: 'read-only' });

    const args = proc.lastCall?.args ?? [];
    expect(valueAfter(args, '--permission-mode')).toBe('plan');
    expect(args).toContain('--disallowedTools');
    expect(args).toContain('Write');
    expect(args).toContain('Edit');
  });

  it('allows edits for an implementation stage', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run({ ...baseInput, permissions: 'write' });

    const args = proc.lastCall?.args ?? [];
    expect(valueAfter(args, '--permission-mode')).toBe('acceptEdits');
    expect(args).not.toContain('--disallowedTools');
  });

  it('never passes --dangerously-skip-permissions', async () => {
    // The only containment agent-flow actually has is the runner's own sandbox.
    // Disabling it would leave nothing at all.
    for (const permissions of ['read-only', 'write'] as const) {
      const { runner, proc } = makeRunner(
        new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
      );
      await runner.run({ ...baseInput, permissions });
      expect(proc.lastCall?.args.join(' ')).not.toContain('dangerously');
    }
  });
});

describe('structured output', () => {
  it('passes the schema and returns the parsed object', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-structured-output.json') }),
    );

    const schema = { type: 'object', properties: { feature: { type: 'string' } } };
    const result = await runner.run({ ...baseInput, outputSchema: schema });

    expect(valueAfter(proc.lastCall?.args ?? [], '--json-schema')).toBe(JSON.stringify(schema));
    expect(result.ok && result.json).toEqual({ feature: 'recurring-bookings', count: 3 });
  });

  it('omits --json-schema when no schema was asked for', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run(baseInput);
    expect(proc.lastCall?.args).not.toContain('--json-schema');
  });

  it('falls back to parsing result when structured_output is absent', async () => {
    // Belt and braces: the runtime normally fills structured_output, but the
    // string in `result` is the same JSON and is enough on its own.
    const envelope = JSON.stringify({
      subtype: 'success',
      is_error: false,
      result: '{"feature":"x"}',
    });
    const { runner } = makeRunner(new FakeProcessRunner().always({ stdout: envelope }));

    const result = await runner.run({ ...baseInput, outputSchema: { type: 'object' } });
    expect(result.ok && result.json).toEqual({ feature: 'x' });
  });

  it('reports invalid_output when a schema was requested but nothing parses', async () => {
    const envelope = JSON.stringify({ subtype: 'success', is_error: false, result: 'not json' });
    const { runner } = makeRunner(new FakeProcessRunner().always({ stdout: envelope }));

    const result = await runner.run({ ...baseInput, outputSchema: { type: 'object' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('invalid_output');
  });
});

describe('extra context flags', () => {
  it('appends a system prompt when given', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run({ ...baseInput, systemPrompt: 'You are terse.' });
    expect(valueAfter(proc.lastCall?.args ?? [], '--append-system-prompt')).toBe('You are terse.');
  });

  it('grants extra read paths through --add-dir', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run({ ...baseInput, additionalReadPaths: ['/shared/docs'] });

    const args = proc.lastCall?.args ?? [];
    expect(args).toContain('--add-dir');
    expect(args).toContain('/shared/docs');
  });
});

describe('success parsing against recorded output', () => {
  it('extracts the answer from a real JSON envelope', async () => {
    const { runner } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    const result = await runner.run(baseInput);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('PROBE_OK');
  });
});

describe('error normalisation (§22.1)', () => {
  it('maps a missing binary to runner_unavailable', async () => {
    // The Codex failure mode, reachable for any runner.
    const { runner } = makeRunner(
      new FakeProcessRunner().always({ spawnFailed: true, exitCode: null, stderr: 'ENOENT' }),
    );
    const result = await runner.run(baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('runner_unavailable');
  });

  it('maps a timeout to timeout', async () => {
    const { runner } = makeRunner(
      new FakeProcessRunner().always({ timedOut: true, exitCode: null, signal: 'SIGKILL' }),
    );
    const result = await runner.run(baseInput);
    if (!result.ok) expect(result.errorCode).toBe('timeout');
  });

  it('maps a 401 envelope to auth_required', async () => {
    const { runner } = makeRunner(
      new FakeProcessRunner().always({
        stdout: fixture('SYNTHETIC-error-auth.json'),
        exitCode: 1,
      }),
    );
    const result = await runner.run(baseInput);
    if (!result.ok) expect(result.errorCode).toBe('auth_required');
  });

  it('maps a 429 envelope to quota_exceeded', async () => {
    const { runner } = makeRunner(
      new FakeProcessRunner().always({
        stdout: fixture('SYNTHETIC-error-quota.json'),
        exitCode: 1,
      }),
    );
    const result = await runner.run(baseInput);
    if (!result.ok) expect(result.errorCode).toBe('quota_exceeded');
  });

  it('recognises a usage-limit message even without a status code', async () => {
    // The synthetic fixtures are guesses about wording, so normalisation keys
    // on the status first. Text matching is the secondary signal, not the only
    // one — that way a phrasing change degrades to execution_failed rather than
    // silently mislabelling a quota problem.
    const envelope = JSON.stringify({
      is_error: true,
      subtype: 'error_during_execution',
      result: 'Claude usage limit reached. Your limit will reset at 9pm.',
    });
    const { runner } = makeRunner(new FakeProcessRunner().always({ stdout: envelope, exitCode: 1 }));

    const result = await runner.run(baseInput);
    if (!result.ok) expect(result.errorCode).toBe('quota_exceeded');
  });

  it('does not mistake a successful document about quotas for a quota failure', async () => {
    // Found end-to-end: an SDD discussing booking rate limits matched the
    // quota heuristic and a perfectly good response was reported as a failure.
    // Explicit success in the envelope has to outrank text matching.
    const envelope = JSON.stringify({
      is_error: false,
      subtype: 'success',
      api_error_status: null,
      result:
        '# Software Design Document\n\n## Security\nSEC-001: enforce a per-user rate limit and ' +
        'a monthly quota; requests beyond the usage limit reached are rejected.',
    });
    const { runner } = makeRunner(new FakeProcessRunner().always({ stdout: envelope, exitCode: 0 }));

    const result = await runner.run(baseInput);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain('rate limit');
  });

  it('still reports a real quota failure when the envelope says it failed', async () => {
    const envelope = JSON.stringify({
      is_error: true,
      subtype: 'error_during_execution',
      result: 'Claude usage limit reached.',
    });
    const { runner } = makeRunner(new FakeProcessRunner().always({ stdout: envelope, exitCode: 1 }));

    const result = await runner.run(baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('quota_exceeded');
  });

  it('falls back to execution_failed for an unrecognised failure', async () => {
    const { runner } = makeRunner(
      new FakeProcessRunner().always({
        exitCode: 1,
        stdout: fixture('error-invalid-model.txt'),
      }),
    );
    const result = await runner.run(baseInput);

    expect(result.ok).toBe(false);
    // Not a fallback trigger (§55): a bad model name is a configuration
    // mistake and must stay visible instead of being routed around.
    if (!result.ok) expect(result.errorCode).toBe('execution_failed');
  });

  it('keeps the original message for diagnosis', async () => {
    const { runner } = makeRunner(
      new FakeProcessRunner().always({ exitCode: 1, stdout: fixture('error-invalid-model.txt') }),
    );
    const result = await runner.run(baseInput);
    if (!result.ok) expect(result.raw).toContain('definitely-not-a-model');
  });
});

// The Codex adapter was caught letting the prompt decide the error code (the
// live Python run: an SDD about retry backoff reported the runner as rate
// limited). This adapter's success guard is structural and stronger, but the
// text rule underneath it still read `envelope.result` — the model's own
// answer. Defence in depth: prose written by the model is never diagnosis.
describe('the model answer is not read as a diagnosis', () => {
  const envelope = (over: Record<string, unknown>) =>
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
      ...over,
    });

  it('does not report quota when only the answer mentions rate limits', async () => {
    // `subtype` is deliberately unfamiliar: the guard depends on recognising
    // it, and a CLI release that adds a new one must not turn every design
    // document about throttling into a quota failure.
    const { runner, proc } = makeRunner();
    proc.always(() => ({
      exitCode: 0,
      stdout: envelope({
        subtype: 'success_with_warnings',
        result: 'The retry helper exists to survive rate limit failures.',
      }),
    }));

    const result = await runner.run(baseInput);

    if (!result.ok) expect(result.errorCode).not.toBe('quota_exceeded');
  });

  it('still reads the message when the envelope says it is an error', async () => {
    // When `is_error` is true, `result` holds the CLI's explanation rather than
    // the model's answer — and then its wording is exactly the right evidence.
    const { runner, proc } = makeRunner();
    proc.always(() => ({
      exitCode: 1,
      stdout: envelope({
        subtype: 'error',
        is_error: true,
        result: 'Usage limit reached. Try again later.',
      }),
    }));

    const result = await runner.run(baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('quota_exceeded');
  });
})
