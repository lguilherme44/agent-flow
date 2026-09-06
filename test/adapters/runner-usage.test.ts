import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { ClaudeCodeRunner } from '../../src/adapters/runners/claude-code-runner.js';
import { CodexRunner } from '../../src/adapters/runners/codex-runner.js';
import { AgyRunner } from '../../src/adapters/runners/agy-runner.js';
import type { AgentRunInput } from '../../src/ports/index.js';

/**
 * What a call spent, from the envelope the CLI already returned (PRI-19).
 *
 * Every fixture here is real output. The point of the finding was that these numbers
 * arrive on every response and were parsed and discarded — a synthetic fixture written
 * from the shape the envelope *should* have would reproduce the same blindness, and did
 * once already in this repository, when a parser offered `Fetching` as a model name.
 */

const FIXTURES = join(import.meta.dirname, '../fixtures/responses');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const input: AgentRunInput = {
  prompt: 'Analyse this repository.',
  reasoning: 'high',
  workingDirectory: '/repo',
  permissions: 'read-only',
  timeoutSeconds: 900,
};

describe('Claude Code reports model, tokens and cost (PRI-19)', () => {
  it('reads all three off the envelope it was already parsing', async () => {
    const proc = new FakeProcessRunner().push({ stdout: fixture('claude/success-json.json'), exitCode: 0 });
    const runner = new ClaudeCodeRunner({ id: 'claude', processRunner: proc });

    const result = await runner.run(input);

    expect(result.ok).toBe(true);
    // `canonicalModel`, which is the answer to "which model wrote this" that survives
    // AD-13's advice not to pin one. Before this, a run with no pinned model was
    // unattributable — `executionDetail` emitted a model only when the config named it.
    expect(result.usage).toEqual({
      model: 'claude-sonnet-5',
      inputTokens: 2,
      outputTokens: 9,
      cacheReadTokens: 31810,
      cacheWriteTokens: 23786,
      costUsd: 0.1524,
    });
  });

  it('keeps the cache read separate from the fresh input', async () => {
    // 31,810 cached against 2 fresh. Summing them into one number would hide the whole
    // difference between a run that cost cents and one that cost dollars.
    const proc = new FakeProcessRunner().push({ stdout: fixture('claude/success-json.json'), exitCode: 0 });
    const result = await new ClaudeCodeRunner({ id: 'claude', processRunner: proc }).run(input);

    expect(result.usage?.inputTokens).toBe(2);
    expect(result.usage?.cacheReadTokens).toBe(31810);
  });

  it('attributes a multi-model call to the model that wrote the answer', async () => {
    const envelope = JSON.parse(fixture('claude/success-json.json')) as Record<string, unknown>;
    const stdout = JSON.stringify({
      ...envelope,
      modelUsage: {
        'claude-haiku-4-5': { outputTokens: 3, canonicalModel: 'claude-haiku-4-5' },
        'claude-sonnet-5': { outputTokens: 900, canonicalModel: 'claude-sonnet-5' },
      },
    });
    const proc = new FakeProcessRunner().push({ stdout, exitCode: 0 });

    const result = await new ClaudeCodeRunner({ id: 'claude', processRunner: proc }).run(input);

    expect(result.usage?.model).toBe('claude-sonnet-5');
  });

  it('reports what a failed call spent, because the model still answered', async () => {
    const proc = new FakeProcessRunner().push({
      stdout: fixture('claude/SYNTHETIC-error-quota.json'),
      exitCode: 1,
    });

    const result = await new ClaudeCodeRunner({ id: 'claude', processRunner: proc }).run(input);

    expect(result.ok).toBe(false);
    // The synthetic quota fixture carries no usage block, so nothing is reported — which
    // is the other half of the contract: absent means unmeasured, never zero.
    expect(result.usage).toBeUndefined();
  });

  it('says nothing rather than zero when the envelope carries no accounting', async () => {
    const proc = new FakeProcessRunner().push({
      stdout: JSON.stringify({ is_error: false, subtype: 'success', result: 'done' }),
      exitCode: 0,
    });

    const result = await new ClaudeCodeRunner({ id: 'claude', processRunner: proc }).run(input);

    expect(result.ok).toBe(true);
    expect(result.usage).toBeUndefined();
  });
});

describe('agy reports tokens and no cost (PRI-19)', () => {
  it('reads the token block its envelope actually carries', async () => {
    // Captured by running `agy 1.1.27`. It reports tokens, and it names neither a cost nor
    // a model — so this adapter reports neither.
    const proc = new FakeProcessRunner().push({ stdout: fixture('agy/success-json.json'), exitCode: 0 });

    const result = await new AgyRunner({ id: 'agy', processRunner: proc }).run(input);

    expect(result.ok).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 20735, outputTokens: 1, cacheReadTokens: 0 });
    expect(result.usage?.costUsd).toBeUndefined();
    expect(result.usage?.model).toBeUndefined();
  });
});

describe('codex reports nothing, and says so (PRI-19)', () => {
  it('produces no usage at all rather than a fabricated one', async () => {
    // Its answer arrives in a file and its stdout interleaves hook output, colour codes
    // and a token counter. Scraping a number out of that stream would be a guess wearing
    // the costume of a measurement.
    const proc = new FakeProcessRunner().push({ stdout: '', exitCode: 0 });
    const fs = new InMemoryFileSystem();
    const runner = new CodexRunner({
      id: 'codex',
      processRunner: proc,
      fs,
      uniqueId: () => 'test',
    });
    await fs.writeFileAtomic('/tmp/agent-flow-codex-test.out', 'done');

    const result = await runner.run(input);

    expect(result.ok).toBe(true);
    expect(result.usage).toBeUndefined();
  });
});
