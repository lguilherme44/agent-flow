import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';

/**
 * The fakes are load-bearing: every later test depends on them behaving like the
 * real thing. If they lie, the suite is decorative.
 */

describe('InMemoryFileSystem', () => {
  it('round-trips a file', async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFileAtomic('/a/b.json', '{"x":1}');
    expect(await fs.readFile('/a/b.json')).toBe('{"x":1}');
    expect(await fs.exists('/a/b.json')).toBe(true);
  });

  it('writes through a temp path before the final one (AD-06)', async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFileAtomic('/state.json', 'v2');
    expect(fs.writes).toEqual(['/state.json.tmp', '/state.json']);
  });

  it('leaves the previous content intact when a write is interrupted', async () => {
    // The whole reason writeFileAtomic is part of the port contract.
    const fs = new InMemoryFileSystem();
    await fs.writeFileAtomic('/state.json', 'good');

    fs.failNextAtomicWriteAfterTemp = true;
    await expect(fs.writeFileAtomic('/state.json', 'partial')).rejects.toThrow();

    expect(await fs.readFile('/state.json')).toBe('good');
  });

  it('throws on a missing file', async () => {
    await expect(new InMemoryFileSystem().readFile('/nope')).rejects.toThrow('ENOENT');
  });

  it('appends without clobbering', async () => {
    const fs = new InMemoryFileSystem();
    await fs.appendFile('/events.jsonl', 'a\n');
    await fs.appendFile('/events.jsonl', 'b\n');
    expect(await fs.readFile('/events.jsonl')).toBe('a\nb\n');
  });

  it('lists direct children only', async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFileAtomic('/runs/AF-2026-001/state.json', '{}');
    await fs.writeFileAtomic('/runs/AF-2026-002/state.json', '{}');
    expect(await fs.readDir('/runs')).toEqual(['AF-2026-001', 'AF-2026-002']);
  });

  it('removes a directory subtree', async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFileAtomic('/runs/AF-2026-001/state.json', '{}');
    await fs.remove('/runs/AF-2026-001');
    expect(await fs.exists('/runs/AF-2026-001/state.json')).toBe(false);
  });
});

describe('FixedClock', () => {
  it('does not move on its own', () => {
    const clock = new FixedClock('2026-08-09T20:00:00.000Z');
    expect(clock.now()).toBe('2026-08-09T20:00:00.000Z');
    expect(clock.now()).toBe('2026-08-09T20:00:00.000Z');
  });

  it('advances only when told', () => {
    const clock = new FixedClock('2026-08-09T20:00:00.000Z');
    clock.advance(90_000);
    expect(clock.now()).toBe('2026-08-09T20:01:30.000Z');
  });
});

describe('FakeProcessRunner', () => {
  it('records the argv it was asked to run', async () => {
    const proc = new FakeProcessRunner();
    await proc.run({ command: 'claude', args: ['-p', 'hi'], cwd: '/repo', timeoutSeconds: 10 });
    expect(proc.lastCall?.command).toBe('claude');
    expect(proc.lastCall?.args).toEqual(['-p', 'hi']);
  });

  it('replays queued responses in order, then the fallback', async () => {
    const proc = new FakeProcessRunner()
      .push({ stdout: 'first' })
      .push({ stdout: 'second' })
      .always({ stdout: 'rest' });

    const opts = { command: 'x', args: [], cwd: '/', timeoutSeconds: 1 };
    expect((await proc.run(opts)).stdout).toBe('first');
    expect((await proc.run(opts)).stdout).toBe('second');
    expect((await proc.run(opts)).stdout).toBe('rest');
  });

  it('can simulate a missing executable', async () => {
    const proc = new FakeProcessRunner().always({ spawnFailed: true, exitCode: null });
    const result = await proc.run({ command: 'codex', args: [], cwd: '/', timeoutSeconds: 1 });
    expect(result.spawnFailed).toBe(true);
  });
});

describe('FakeAgentRunner', () => {
  it('reports capabilities without touching a CLI', () => {
    expect(new FakeAgentRunner().capabilities().structuredOutputStrategy).toBe('native');
  });

  it('replays scripted successes and failures', async () => {
    const runner = new FakeAgentRunner().pushJson({ feature: 'f' }).pushFailure('quota_exceeded');
    const input = {
      prompt: 'p',
      reasoning: 'high' as const,
      workingDirectory: '/repo',
      permissions: 'read-only' as const,
      timeoutSeconds: 60,
    };

    const first = await runner.run(input);
    expect(first.ok && first.json).toEqual({ feature: 'f' });

    const second = await runner.run(input);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.errorCode).toBe('quota_exceeded');
  });

  it('exposes an unhealthy state for the degraded-path tests', async () => {
    const runner = new FakeAgentRunner('codex').setHealth({
      installed: true,
      executable: false,
      auth: 'unknown',
    });
    const health = await runner.healthCheck();
    expect(health.installed).toBe(true);
    expect(health.executable).toBe(false);
  });
});
