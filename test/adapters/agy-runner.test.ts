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
    // And the one whose `--sandbox` closes the terminal and not the editor. `true` here is
    // a routing decision, stated as one in the doc comment: `false` would bar this runner
    // from six of the nine roles and break the operator who has a single agent.
    expect(makeRunner().runner.capabilities().supportsReadOnly).toBe(true);
  });

  /**
   * The flags the routing decision leans on, asserted rather than described.
   *
   * `supportsReadOnly: true` is defensible only while a read-only stage is actually
   * narrowed — measured on `agy 1.1.27`: with `--sandbox` a shell write comes back
   * `denied_actions: [command]` and the file is untouched, and without it the same prompt
   * overwrote `target.txt`. If these arguments ever stop being sent, the capability
   * becomes a claim about nothing, silently. That is what this test is for.
   */
  it('closes the terminal on a read-only stage, and leaves it open on a writing one', async () => {
    const ok = { stdout: JSON.stringify({ status: 'SUCCESS', response: 'ok' }) };

    const readOnly = makeRunner(new FakeProcessRunner().always(ok));
    await readOnly.runner.run({ ...baseInput, permissions: 'read-only' });
    expect(readOnly.proc.lastCall?.args).toContain('--sandbox');
    // Never `--mode plan`: it answers with a pointer to a file outside the workspace.
    expect(readOnly.proc.lastCall?.args).not.toContain('plan');

    const writing = makeRunner(new FakeProcessRunner().always(ok));
    await writing.runner.run({ ...baseInput, permissions: 'write' });
    expect(writing.proc.lastCall?.args).not.toContain('--sandbox');
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

  it('runs non-interactively with the stream output format and workingDirectory in add-dir', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({
        stdout: JSON.stringify({ status: 'SUCCESS', response: 'done' }),
      }),
    );

    const result = await runner.run(baseInput);

    expect(proc.lastCall?.command).toBe('agy');
    expect(proc.lastCall?.args).not.toContain('-p');
    // stream-json since dogfood 08/10; a plain envelope on stdout still reads as before.
    expect(valueAfter(proc.lastCall?.args ?? [], '--output-format')).toBe('stream-json');
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

  /**
   * D16 — the role's budget reaches the CLI, because otherwise the CLI's own beats it.
   *
   * `agy` waits five minutes by default and then exits **0** with `status: SUCCESS` and a
   * placeholder where the answer should be. Measured twice on this repository: the plan
   * reviewer at 289 s with an empty response, the planner at 299.4 s with *"Waiting for
   * task completion."* — and both roles had been given far longer by configuration. A
   * 2400 s budget that a 300 s default silently overrules is not a budget.
   */
  it('hands the CLI the caller\'s budget, so its own five-minute default cannot preempt it', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({
        stdout: JSON.stringify({ status: 'SUCCESS', response: 'done' }),
      }),
    );

    await runner.run({ ...baseInput, timeoutSeconds: 2400 });

    expect(valueAfter(proc.lastCall?.args ?? [], '--print-timeout')).toBe('2460s');
  });

  it('leaves the last word to agent-flow, sending a longer limit than it enforces', async () => {
    // Above and not equal: two limits racing at the same instant is a coin flip between an
    // honest timeout and a SUCCESS carrying nothing. The one that fires must be ours.
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({
        stdout: JSON.stringify({ status: 'SUCCESS', response: 'done' }),
      }),
    );

    await runner.run({ ...baseInput, timeoutSeconds: 900 });

    const sent = valueAfter(proc.lastCall?.args ?? [], '--print-timeout');
    expect(sent).toBe('960s');
    expect(Number.parseInt(sent ?? '0', 10)).toBeGreaterThan(900);
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

  it('classifies denied_actions in envelope as permission_denied', async () => {
    const { runner } = makeRunner(
      new FakeProcessRunner().always({
        exitCode: 0,
        stdout: JSON.stringify({
          status: 'SUCCESS',
          response: '',
          denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
        }),
      }),
    );

    const result = await runner.run(baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('execution_failed');
    }
  });
});

describe('AgyRunner dangerouslySkipPermissions', () => {
  it('passes --dangerously-skip-permissions and reports commandExecution capability when enabled', async () => {
    const proc = new FakeProcessRunner().always({
      exitCode: 0,
      stdout: JSON.stringify({ status: 'SUCCESS', response: '{"ok":true}' }),
    });
    const runner = new AgyRunner({
      id: 'agy',
      processRunner: proc,
      dangerouslySkipPermissions: true,
    });

    expect(runner.capabilities().nonInteractiveToolGrants?.commandExecution).toBe(true);

    await runner.run(baseInput);
    expect(proc.lastCall?.args).toContain('--dangerously-skip-permissions');
  });

  it('omits --dangerously-skip-permissions when disabled', async () => {
    const proc = new FakeProcessRunner().always({
      exitCode: 0,
      stdout: JSON.stringify({ status: 'SUCCESS', response: '{"ok":true}' }),
    });
    const runner = new AgyRunner({
      id: 'agy',
      processRunner: proc,
      dangerouslySkipPermissions: false,
    });

    expect(runner.capabilities().nonInteractiveToolGrants?.commandExecution).toBe(false);

    await runner.run(baseInput);
    expect(proc.lastCall?.args).not.toContain('--dangerously-skip-permissions');
  });
});

/**
 * Dogfood 08/10 — "tela congelada", for this runner too. The lines below are the ones
 * `agy 1.3.3 --output-format stream-json` printed when probed (paths shortened): a tool step
 * opening and closing, a message in two pieces, and the `result` line, whose object is the
 * envelope `--output-format json` printed.
 */
describe('AgyRunner stream (dogfood 08/10)', () => {
  const ANSWER = { answer: '4' };
  const step = (fields: Record<string, unknown>) =>
    JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c', ...fields } });
  const lines = [
    JSON.stringify({ event: 'init', conversation_id: 'c', init: { cwd: '/repo', tools: ['view_file'] } }),
    step({ step_index: 0, state: 'DONE', step_type: 'user_input' }),
    step({ step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 1 } }),
    step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: '/repo/a.txt' } } }),
    step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: '/repo/a.txt' }, output: '2 lines, 6 bytes' } }),
    step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Read a.txt; ' }),
    step({ step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'it says hello.\n' }),
    JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'c', status: 'SUCCESS', response: JSON.stringify(ANSWER), duration_seconds: 6.8, num_turns: 1,
        structured_output: ANSWER, usage: { input_tokens: 25579, output_tokens: 117 },
      },
    }),
  ];
  const stream = `${lines.join('\n')}\n`;

  it('reports each tool call once, as it starts, and each message whole', async () => {
    const seen: unknown[] = [];
    const proc = new FakeProcessRunner().always((options) => {
      // Split mid-line, as a pipe delivers it.
      options.onStdout?.(stream.slice(0, 300));
      options.onStdout?.(stream.slice(300));
      return { exitCode: 0, stdout: stream };
    });
    const { runner } = makeRunner(proc);

    const result = await runner.run({ ...baseInput, onActivity: (activity) => seen.push(activity) });

    expect(result.ok).toBe(true);
    expect(seen).toEqual([
      { kind: 'tool', tool: 'view_file', target: '/repo/a.txt' },
      { kind: 'text', text: 'Read a.txt; it says hello.' },
    ]);
  });

  it('reads the answer, the structured output and the usage from the result line', async () => {
    const { runner } = makeRunner(new FakeProcessRunner().always({ exitCode: 0, stdout: stream }));

    const result = await runner.run({ ...baseInput, outputSchema: { type: 'object' } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.json).toEqual(ANSWER);
    expect(result.usage?.inputTokens).toBe(25579);
    expect(result.usage?.turns).toBe(1);
  });

  it('keeps the result line when the buffered output was truncated before it', async () => {
    const proc = new FakeProcessRunner().always((options) => {
      options.onStdout?.(stream);
      return { exitCode: 0, stdout: `${stream.slice(0, 120)}\n… [truncated]`, truncated: true };
    });
    const { runner } = makeRunner(proc);

    const result = await runner.run({ ...baseInput, outputSchema: { type: 'object' } });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.json).toEqual(ANSWER);
  });

  it('does not report the answer of a structured stage as something the agent said', async () => {
    const seen: unknown[] = [];
    const answer = [
      step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: `${JSON.stringify(ANSWER)}\n` }),
      lines.at(-1) ?? '',
    ].join('\n');
    const proc = new FakeProcessRunner().always((options) => {
      options.onStdout?.(answer);
      return { exitCode: 0, stdout: answer };
    });
    const { runner } = makeRunner(proc);

    await runner.run({ ...baseInput, outputSchema: { type: 'object' }, onActivity: (activity) => seen.push(activity) });

    expect(seen).toEqual([]);
  });

  it('reads a failure from the result line, as the json envelope carried it', async () => {
    // The shape was measured with an invalid `--model` (status ERROR, its `error`, exit 1); a
    // 429 was not provoked, so `status_code` here is the json envelope's field in that shape.
    const failed = JSON.stringify({
      event: 'result',
      result: { conversation_id: '', status: 'ERROR', response: '', error: 'too many requests', status_code: 429 },
    });
    const { runner } = makeRunner(new FakeProcessRunner().always({ exitCode: 1, stdout: `${failed}\n` }));

    const result = await runner.run(baseInput);

    expect(result.ok).toBe(false);
    // `status_code` read from inside the result line, so the existing rule still fires.
    if (!result.ok) expect(result.errorCode).toBe('quota_exceeded');
  });

  it('does not take the init event for the answer when a stream ends at exit 0 without its result', async () => {
    const cut = `${lines.slice(0, 3).join('\n')}\n`;
    const { runner } = makeRunner(new FakeProcessRunner().always({ exitCode: 0, stdout: cut }));

    const result = await runner.run(baseInput);

    // Under `json` the same run printed nothing and read as an empty answer; it still does.
    expect(result.ok && result.text).toBe('');
  });

  it('reads an auto-denied command from the result line, as measured under --sandbox', async () => {
    // agy 1.3.3, a read-only stage asked to run `echo hi > x.txt`: the step ends in ERROR, the
    // result still says SUCCESS and carries `denied_actions`, stderr has the jetski line.
    const seen: unknown[] = [];
    const denied = [
      step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi > x.txt' } } }),
      step({ step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi > x.txt' }, error: { type: 'TOOL_ERROR', message: 'permission check failed' } } }),
      JSON.stringify({
        event: 'result',
        result: { conversation_id: 'c', status: 'SUCCESS', response: '', num_turns: 1, denied_actions: [{ action: 'command', display_name: 'RunCommand' }] },
      }),
    ].join('\n');
    const proc = new FakeProcessRunner().always((options) => {
      options.onStdout?.(`${denied}\n`);
      return {
        exitCode: 0,
        stdout: `${denied}\n`,
        stderr: 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.',
      };
    });
    const { runner } = makeRunner(proc);

    const result = await runner.run({ ...baseInput, onActivity: (activity) => seen.push(activity) });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.raw).toContain('"denied_actions":[{"action":"command"');
    expect(seen).toEqual([{ kind: 'tool', tool: 'run_command', target: 'echo hi > x.txt' }]);
  });

  it('keeps no step content in what a killed run carries to logs, and reports nothing twice', async () => {
    const seen: unknown[] = [];
    const killed = [
      lines[0],
      step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'cat .env' } } }),
      step({ step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'SECRET-FILE-CONTENT' }),
    ].join('\n');
    const proc = new FakeProcessRunner().always((options) => {
      options.onStdout?.(`${killed}\n`);
      return { exitCode: null, timedOut: true, stdout: `${killed}\n`, stderr: 'error: connection reset' };
    });
    const { runner } = makeRunner(proc);

    const result = await runner.run({ ...baseInput, onActivity: (activity) => seen.push(activity) });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.raw).not.toContain('SECRET-FILE-CONTENT');
    expect(result.raw).not.toContain('cat .env');
    // Diagnosed from stderr, as under `json`: the init event is not the first thing a reader sees.
    expect(result.raw).not.toContain('"event":"init"');
    expect(result.raw).toContain('error: connection reset');
    // Reported live, and not again when the stream was searched for its result line.
    expect(seen).toEqual([
      { kind: 'tool', tool: 'run_command', target: 'cat .env' },
      { kind: 'text', text: 'SECRET-FILE-CONTENT' },
    ]);
  });
});

