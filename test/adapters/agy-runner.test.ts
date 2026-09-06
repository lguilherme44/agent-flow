import { describe, it, expect } from 'vitest';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { AgyRunner } from '../../src/adapters/runners/agy-runner.js';
import { ClaudeCodeRunner } from '../../src/adapters/runners/claude-code-runner.js';
import { CodexRunner } from '../../src/adapters/runners/codex-runner.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import type { AgentRunInput } from '../../src/ports/index.js';

function makeRunner(proc = new FakeProcessRunner()) {
  return { runner: new AgyRunner({ id: 'agy', processRunner: proc }), proc };
}

const baseInput: AgentRunInput = {
  prompt: 'Analyse this repository.',
  reasoning: 'high',
  workingDirectory: '/repo',
  permissions: 'read-only',
  timeoutSeconds: 900,
};

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('AgyRunner capabilities', () => {
  it('reports prompted structured output strategy', () => {
    expect(makeRunner().runner.capabilities().structuredOutputStrategy).toBe('prompted');
  });

  it('declares the CLI surface when no model is configured', () => {
    // What `agy --help` documents for `--effort`. Correct as a statement about the flag,
    // and the *only* honest answer when nothing narrows it.
    expect(makeRunner().runner.capabilities().supportedReasoningLevels).toEqual(['low', 'medium', 'high']);
  });

  /**
   * AD-30 and C-03, activated (AR-01).
   *
   * The CLI's `--effort` flag accepts `low|medium|high`; the model behind it may not. The
   * old signature could not express the difference — no argument reached `capabilities()` —
   * so the mismatch was undetectable before invocation and cost a task attempt.
   *
   * AR-00 landed the parameter and the measurement as documentation, deliberately inert.
   * AR-01 encodes it here, in the adapter that owns the provider (AD-13). The measurement
   * itself is in `docs/runner-capabilities.md`: `agy models` enumerates one id per offered
   * effort, and `gemini-3.1-pro` shows `-high` and `-low` and no `-medium`.
   */
  describe('per-model reasoning levels, as measured (AD-30, C-03)', () => {
    it('narrows to the measured set for the family that was measured', () => {
      expect(
        makeRunner().runner.capabilities('gemini-3.1-pro-high').supportedReasoningLevels,
      ).toEqual(['low', 'high']);
    });

    it('answers identically for every id in one family, because the suffix is a setting', () => {
      // `gemini-3.1-pro-low` and `gemini-3.1-pro-high` are one model at two settings, not
      // two models. If the answer depended on which id somebody typed, the clamp would too.
      const runner = makeRunner().runner;
      const high = runner.capabilities('gemini-3.1-pro-high').supportedReasoningLevels;
      const low = runner.capabilities('gemini-3.1-pro-low').supportedReasoningLevels;
      const bare = runner.capabilities('gemini-3.1-pro').supportedReasoningLevels;

      expect(low).toEqual(high);
      expect(bare).toEqual(high);
    });

    it('reports the CLI surface for a family nobody probed', () => {
      // The documentation is explicit that only one row is a measurement: the other
      // families show a `-medium` id and would *plausibly* offer all three, and plausibly
      // is not a measurement. Claiming a narrowing here would be inventing evidence.
      const runner = makeRunner().runner;

      for (const model of ['gemini-3.7-flash-medium', 'claude-sonnet-4-6', 'gpt-oss-120b-medium']) {
        expect(runner.capabilities(model).supportedReasoningLevels, model).toEqual([
          'low',
          'medium',
          'high',
        ]);
      }
    });

    it('narrows nothing but the reasoning levels', () => {
      // A per-model table is a statement about efforts. Everything else — read-only,
      // non-interactivity, the tool grants — is a property of the CLI and must not drift
      // because a model string was passed.
      const runner = makeRunner().runner;
      const { supportedReasoningLevels: _narrow, ...rest } = runner.capabilities('gemini-3.1-pro-high');
      const { supportedReasoningLevels: _wide, ...baseline } = runner.capabilities();

      expect(rest).toEqual(baseline);
    });
  });

  describe('non-interactive tool grants (AD-32)', () => {
    it('grants file edits and does not claim command execution', () => {
      // The distinction `supportsNonInteractive` could not draw. This runner *was*
      // non-interactive and still failed: it tried a shell command, local policy demanded
      // a confirmation, and nobody was there to answer.
      expect(makeRunner().runner.capabilities().nonInteractiveToolGrants).toEqual({
        fileEdit: true,
        commandExecution: false,
      });
    });

    it('still reports itself as non-interactive, so the two stay separate properties', () => {
      const capabilities = makeRunner().runner.capabilities();
      expect(capabilities.supportsNonInteractive).toBe(true);
      expect(capabilities.nonInteractiveToolGrants.commandExecution).toBe(false);
    });
  });

  /**
   * One criterion, applied to every CLI adapter — and this runner genuinely fails it.
   *
   * PRI-18 flipped this adapter to `true`, reasoning that its `false` rested on writes to
   * `~/.gemini` while `claude` and `codex` write `~/.claude` and `~/.codex` and declare
   * `true`. The reasoning about the *criterion* was right and the conclusion was wrong: a
   * live end-to-end run failed one stage later, and the measurement is recorded in
   * {@link AgyRunner.capabilities}.
   *
   * `--mode plan` is a planning workflow rather than a containment mode. It writes its
   * answer to a file under `~/.gemini/antigravity-cli/brain/` and returns a sentence
   * pointing at it, so a stage handed that gets a pointer or nothing — the discovery stage
   * produced 2,709 output tokens and an empty `text`. `--mode accept-edits`, with or
   * without `--sandbox`, answers inline and overwrote a real file in the working directory.
   *
   * The assertion stays about the *set*, because nothing asserting the three together is
   * why the original divergence lasted. What differs now is stated rather than implied.
   */
  it('answers supportsReadOnly on the same criterion as every other CLI adapter', () => {
    const proc = new FakeProcessRunner();
    const claude = new ClaudeCodeRunner({ id: 'claude', processRunner: proc });
    const codex = new CodexRunner({ id: 'codex', processRunner: proc, fs: new InMemoryFileSystem() });

    // The two whose read-only mode both contains writes and returns the answer.
    expect(claude.capabilities().supportsReadOnly).toBe(true);
    expect(codex.capabilities().supportsReadOnly).toBe(true);
    // And the one that has no such mode. Measured, not assumed — see the doc comment.
    expect(makeRunner().runner.capabilities().supportsReadOnly).toBe(false);
  });

  it('reports non-interactive and working directory support', () => {
    const caps = makeRunner().runner.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsWorkingDirectory).toBe(true);
  });
});

describe('AgyRunner model enumeration (AD-13)', () => {
  it('reads the ids `agy models` prints, and drops the human labels beside them', async () => {
    // Copied from `agy models` 1.1.25, progress line and all — the first version of this
    // fixture was written from the shape the output should have had, and agreed with a
    // parser that offered `Fetching` as a model.
    const proc = new FakeProcessRunner().push({
      stdout: [
        'Fetching available models...',
        'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
        'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
        'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
        '',
      ].join('\n'),
      exitCode: 0,
    });
    const { runner } = makeRunner(proc);

    expect(await runner.listModels?.()).toEqual([
      'gemini-3.8-flash-high', 'gemini-3.1-pro-low', 'claude-sonnet-4-6',
    ]);
    expect(proc.calls[0]?.args).toEqual(['models']);
  });

  it('offers nothing when the CLI is absent or refuses, rather than failing', async () => {
    // This feeds a suggestion list. A screen with no suggestions is the screen we had.
    expect(await makeRunner(new FakeProcessRunner().push({ spawnFailed: true })).runner.listModels?.()).toEqual([]);
    expect(await makeRunner(new FakeProcessRunner().push({ exitCode: 1, stderr: 'unknown command' })).runner.listModels?.()).toEqual([]);
  });
});

describe('AgyRunner argv construction', () => {
  /**
   * The arguments actually handed to the CLI when the clamp has fired (AR-01).
   *
   * This vendor's model ids *encode* an effort — `gemini-3.1-pro-high` — while the
   * effective effort is decided by the reasoning mechanism, which may land on `low`. The
   * two are produced by different mechanisms on purpose: the model is opaque to the core
   * (AD-13), and `capabilities(model)` belongs to this adapter (AD-30).
   *
   * So the adapter forwards both verbatim. It does **not** rewrite the id to match the
   * effort, and it does not rewrite the effort to match the id: either would be a
   * heuristic nobody measured, applied to a string the core is forbidden to interpret.
   */
  it('forwards the model id and the effective effort verbatim, reconciling neither', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: JSON.stringify({ status: 'SUCCESS', response: 'ok' }) }),
    );

    await runner.run({ ...baseInput, model: 'gemini-3.1-pro-high', reasoning: 'low' });

    expect(valueAfter(proc.lastCall?.args ?? [], '--model')).toBe('gemini-3.1-pro-high');
    expect(valueAfter(proc.lastCall?.args ?? [], '--effort')).toBe('low');
  });

  it('runs non-interactively with json output format and workingDirectory in add-dir', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({
        stdout: JSON.stringify({ status: 'SUCCESS', response: 'done' }),
      }),
    );

    const result = await runner.run(baseInput);

    expect(proc.lastCall?.command).toBe('agy');
    expect(proc.lastCall?.args).not.toContain('-p');
    expect(valueAfter(proc.lastCall?.args ?? [], '--output-format')).toBe('json');
    expect(valueAfter(proc.lastCall?.args ?? [], '--add-dir')).toBe('/repo');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('done');
    }
  });

  it('maps reasoning level to CLI effort flags', async () => {
    const proc = new FakeProcessRunner().always({
      stdout: JSON.stringify({ status: 'SUCCESS', response: 'done' }),
    });
    const runner = new AgyRunner({ id: 'agy', processRunner: proc });

    await runner.run({ ...baseInput, reasoning: 'low' });
    expect(valueAfter(proc.lastCall?.args ?? [], '--effort')).toBe('low');

    await runner.run({ ...baseInput, reasoning: 'high' });
    expect(valueAfter(proc.lastCall?.args ?? [], '--effort')).toBe('high');
  });

  it('passes prompt on stdin', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({
        stdout: JSON.stringify({ status: 'SUCCESS', response: 'done' }),
      }),
    );

    await runner.run(baseInput);
    expect(proc.lastCall?.stdin).toBe('Analyse this repository.');
  });
});

describe('AgyRunner error classification', () => {
  it('classifies 429 status as quota_exceeded', async () => {
    const { runner } = makeRunner(
      new FakeProcessRunner().always({
        exitCode: 1,
        stdout: JSON.stringify({ is_error: true, status_code: 429, error: 'Rate limit' }),
      }),
    );

    const result = await runner.run(baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('quota_exceeded');
    }
  });

  it('classifies 401 status as auth_required', async () => {
    const { runner } = makeRunner(
      new FakeProcessRunner().always({
        exitCode: 1,
        stdout: JSON.stringify({ is_error: true, status_code: 401, error: 'Unauthorized' }),
      }),
    );

    const result = await runner.run(baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('auth_required');
    }
  });

  it('classifies error status in envelope as execution_failed', async () => {
    const { runner } = makeRunner(
      new FakeProcessRunner().always({
        exitCode: 0,
        stdout: JSON.stringify({ status: 'ERROR', error: 'Internal failure' }),
      }),
    );

    const result = await runner.run(baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('execution_failed');
    }
  });
});
