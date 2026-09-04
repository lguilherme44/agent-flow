import { describe, it, expect } from 'vitest';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { ClaudeCodeRunner } from '../../src/adapters/runners/claude-code-runner.js';
import { CodexRunner } from '../../src/adapters/runners/codex-runner.js';
import { AgyRunner } from '../../src/adapters/runners/agy-runner.js';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import type { AgentRunInput } from '../../src/ports/index.js';

/**
 * `RunnerConfig.args` — the seam for what the schema does not model.
 *
 * It exists because pointing a coding CLI at another inference endpoint is spelled
 * differently by every CLI, and without a seam that need is met by a wrapper script
 * on each operator's machine: outside version control, unreviewed, unreproducible.
 *
 * Tested on all three CLI adapters because the base option is optional, and an
 * adapter with a constructor of its own can drop it by omission with nothing
 * complaining — which is exactly what `codex-runner` did on the first pass, and its
 * own comment had predicted for `envPass`.
 */
const input: AgentRunInput = {
  prompt: 'Analyse this repository.',
  reasoning: 'high',
  workingDirectory: '/tmp',
  timeoutSeconds: 60,
  permissions: 'read-only',
};

const EXTRA = ['-c', 'model_provider="llamacpp"'];

describe('extra args reach the spawn', () => {
  it('claude-code-cli appends them after its own argv', async () => {
    const proc = new FakeProcessRunner();
    await new ClaudeCodeRunner({ id: 'c', processRunner: proc, extraArgs: EXTRA }).run(input);
    const args = proc.calls[0]?.args ?? [];
    expect(args.slice(-2)).toEqual(EXTRA);
    expect(args.length).toBeGreaterThan(2);
  });

  it('agy-cli appends them after its own argv', async () => {
    const proc = new FakeProcessRunner();
    await new AgyRunner({ id: 'a', processRunner: proc, extraArgs: EXTRA }).run(input);
    expect((proc.calls[0]?.args ?? []).slice(-2)).toEqual(EXTRA);
  });

  it('codex-cli forwards them despite having its own constructor', async () => {
    // The regression this file exists for.
    const proc = new FakeProcessRunner();
    await new CodexRunner({
      id: 'x',
      processRunner: proc,
      fs: new NodeFileSystem(),
      extraArgs: EXTRA,
    }).run(input);
    expect((proc.calls[0]?.args ?? []).slice(-2)).toEqual(EXTRA);
  });

  it('changes nothing when no args are configured', async () => {
    const proc = new FakeProcessRunner();
    await new ClaudeCodeRunner({ id: 'c', processRunner: proc }).run(input);
    const args = proc.calls[0]?.args ?? [];
    expect(args).not.toContain('-c');
  });
});
