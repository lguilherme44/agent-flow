import { describe, it, expect } from 'vitest';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { ClaudeCodeRunner } from '../../src/adapters/runners/claude-code-runner.js';
import { CodexRunner } from '../../src/adapters/runners/codex-runner.js';
import { AgyRunner } from '../../src/adapters/runners/agy-runner.js';
import { BaseRunner, type ErrorRule, type RunnerInvocation } from '../../src/adapters/runners/base-runner.js';
import type { AgentRunInput, RunnerCapabilities, RunnerHealth } from '../../src/ports/index.js';

/**
 * `execution.isolateRunnerSettings` reaches the argv of every CLI adapter (PRI-18).
 *
 * The defect this covers was measured rather than imagined. A live run produced an SDD in
 * Portuguese under a persona for an English repository — neither came from any of the
 * eleven prompts this product ships, both came from `~/.claude/settings.json` on the
 * machine that ran it. A second runner expanded one of the operator's own skills mid-task
 * and left `.atl/` and a 56 KB cache untracked *inside the repository under test*.
 *
 * Written as one cross-adapter file rather than three additions, because the property
 * being defended is symmetry: the original `supportsReadOnly` divergence — one adapter
 * judged by a criterion the other two never faced — survived for as long as it did
 * precisely because nothing asserted the three together.
 */

const writeInput: AgentRunInput = {
  prompt: 'Analyse this repository.',
  reasoning: 'high',
  workingDirectory: '/repo',
  permissions: 'write',
  timeoutSeconds: 900,
};

const readOnlyInput: AgentRunInput = { ...writeInput, permissions: 'read-only' };

/** Argv of the one spawn a `run()` performs. */
async function argvOf(
  runner: { run: (i: AgentRunInput) => Promise<unknown> },
  proc: FakeProcessRunner,
  input: AgentRunInput = writeInput,
) {
  await runner.run(input);
  return proc.calls[0]?.args ?? [];
}

/**
 * The flag each CLI documents for "ignore what this machine's owner configured".
 *
 * Read from `--help` on the versions in `docs/runner-capabilities.md`, not guessed: a flag
 * a CLI does not have is rejected at spawn, and a flag that exists but means something
 * else is worse — it would look like the leak was closed.
 */
const ADAPTERS = [
  {
    name: 'claude-code-cli',
    flag: '--safe-mode',
    /**
     * The second flag, and it is not decoration.
     *
     * Measured against `claude 2.1.263` on a machine whose settings set `language`:
     * `--safe-mode` alone still answered in that language, and `--setting-sources ''`
     * beside it answered in English. One covers the settings file, the other covers
     * `CLAUDE.md`, skills, plugins, hooks and MCP servers.
     */
    alsoFlag: '--setting-sources',
    /** Whether this adapter's flag survives a read-only stage. See `agy-cli` below. */
    readOnlyToo: true,
    build: (proc: FakeProcessRunner, isolate?: boolean) =>
      new ClaudeCodeRunner({
        id: 'claude',
        processRunner: proc,
        ...(isolate === undefined ? {} : { isolateSettings: isolate }),
      }),
  },
  {
    name: 'codex-cli',
    flag: '--ignore-user-config',
    readOnlyToo: true,
    build: (proc: FakeProcessRunner, isolate?: boolean) =>
      new CodexRunner({
        id: 'codex',
        processRunner: proc,
        fs: new InMemoryFileSystem(),
        ...(isolate === undefined ? {} : { isolateSettings: isolate }),
      }),
  },
  {
    name: 'agy-cli',
    flag: '--disable-slash-commands',
    // Measured: `--mode plan --disable-slash-commands` makes the CLI warn that plan mode
    // has no effect. Containment is not traded for isolation, so read-only stages go
    // without it.
    readOnlyToo: false,
    build: (proc: FakeProcessRunner, isolate?: boolean) =>
      new AgyRunner({
        id: 'agy',
        processRunner: proc,
        ...(isolate === undefined ? {} : { isolateSettings: isolate }),
      }),
  },
] as const;

describe('every CLI adapter honours the isolation switch (PRI-18)', () => {
  for (const adapter of ADAPTERS) {
    describe(adapter.name, () => {
      it(`passes ${adapter.flag} by default`, async () => {
        // Default rather than opt-in, and the default is what the finding is about: the
        // leak happened on a machine nobody had configured to leak.
        const proc = new FakeProcessRunner();
        const args = await argvOf(adapter.build(proc), proc);
        expect(args).toContain(adapter.flag);
        if ('alsoFlag' in adapter) {
          // Both, and in the shape the CLI was measured to honour: the flag takes a value
          // and the empty list is what "load no settings file" is spelled as.
          expect(args).toContain(adapter.alsoFlag);
          expect(args[args.indexOf(adapter.alsoFlag) + 1]).toBe('');
        }
      });

      it('omits it when the operator turned isolation off', async () => {
        const proc = new FakeProcessRunner();
        const args = await argvOf(adapter.build(proc, false), proc);
        expect(args).not.toContain(adapter.flag);
        if ('alsoFlag' in adapter) expect(args).not.toContain(adapter.alsoFlag);
      });

      it(
        adapter.readOnlyToo
          ? 'passes it on a read-only stage too'
          : 'stands down on a read-only stage, where it would cancel plan mode',
        async () => {
          const proc = new FakeProcessRunner();
          const args = await argvOf(adapter.build(proc), proc, readOnlyInput);
          if (adapter.readOnlyToo) expect(args).toContain(adapter.flag);
          else expect(args).not.toContain(adapter.flag);
        },
      );

      it('leaves the operator the last word', async () => {
        // `RunnerConfig.args` is appended after the isolation flag on purpose. A person who
        // needs their own value to win over one this product added on their behalf can
        // still have it, and where the CLI takes the last occurrence they do.
        const proc = new FakeProcessRunner();
        const runner = adapter.name === 'codex-cli'
          ? new CodexRunner({ id: 'codex', processRunner: proc, fs: new InMemoryFileSystem(), extraArgs: ['--mine'] })
          : adapter.name === 'agy-cli'
            ? new AgyRunner({ id: 'agy', processRunner: proc, extraArgs: ['--mine'] })
            : new ClaudeCodeRunner({ id: 'claude', processRunner: proc, extraArgs: ['--mine'] });

        const args = await argvOf(runner, proc);
        // Both positions asserted, not just their order. `indexOf` answers -1 for an
        // absent flag, so comparing the two alone passes when the isolation flag was
        // never emitted — which is the defect this file exists to catch, reported as a
        // pass by the test meant to catch it.
        expect(args).toContain(adapter.flag);
        expect(args).toContain('--mine');
        expect(args.indexOf('--mine')).toBeGreaterThan(args.indexOf(adapter.flag));
      });
    });
  }
});

/**
 * A CLI with nothing to offer contributes nothing.
 *
 * The base returns an empty list, and an adapter that does not override it must not
 * acquire a flag by inheritance: a flag its CLI does not parse would turn every run into a
 * spawn failure, which is a worse outcome than the leak.
 */
class BareRunner extends BaseRunner {
  protected defaultCommand(): string {
    return 'bare';
  }
  capabilities(): RunnerCapabilities {
    return {
      supportedReasoningLevels: ['low'],
      supportsReadOnly: true,
      supportsNonInteractive: true,
      supportsWorkingDirectory: true,
      structuredOutputStrategy: 'prompted',
      nonInteractiveToolGrants: { fileEdit: false, commandExecution: false },
    };
  }
  async healthCheck(): Promise<RunnerHealth> {
    return { installed: true, executable: true, auth: 'unknown' };
  }
  protected buildInvocation(): RunnerInvocation {
    return { command: 'bare', args: ['--only-mine'] };
  }
  protected errorRules(): readonly ErrorRule[] {
    return [];
  }
  protected parseSuccess(): { text: string } {
    return { text: 'ok' };
  }
}

describe('an adapter whose CLI has no such flag', () => {
  it('spawns exactly what it built, isolation on or off', async () => {
    const on = new FakeProcessRunner();
    const off = new FakeProcessRunner();

    expect(await argvOf(new BareRunner({ id: 'bare', processRunner: on }), on)).toEqual(['--only-mine']);
    expect(
      await argvOf(new BareRunner({ id: 'bare', processRunner: off, isolateSettings: false }), off),
    ).toEqual(['--only-mine']);
  });
});
