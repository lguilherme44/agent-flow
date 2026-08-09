import { describe, it, expect } from 'vitest';
import { NodeProcessRunner } from '../../src/adapters/process/node-process-runner.js';

/**
 * These run real child processes. They are still fast and free — the point of
 * the ProcessRunner port is that nothing above it ever needs to.
 */
const runner = new NodeProcessRunner();
const node = process.execPath;

const runNode = (script: string, overrides: Record<string, unknown> = {}) =>
  runner.run({
    command: node,
    args: ['-e', script],
    cwd: process.cwd(),
    timeoutSeconds: 10,
    ...overrides,
  });

describe('basic execution', () => {
  it('captures stdout and a zero exit code', async () => {
    const result = await runNode('process.stdout.write("hello")');
    expect(result.stdout).toBe('hello');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.spawnFailed).toBe(false);
  });

  it('captures stderr separately from stdout', async () => {
    const result = await runNode('process.stdout.write("out");process.stderr.write("err")');
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
  });

  it('reports a non-zero exit code without throwing', async () => {
    // A failing CLI is data, not an exception. The adapter decides what the
    // exit code means; throwing here would force every caller into try/catch.
    const result = await runNode('process.exit(3)');
    expect(result.exitCode).toBe(3);
  });

  it('measures duration', async () => {
    const result = await runNode('process.stdout.write("x")');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('working directory', () => {
  it('runs the child in the requested directory', async () => {
    // Every agent invocation targets a specific repository. Getting this wrong
    // would point an agent at whatever directory the CLI happened to start in.
    const result = await runNode('process.stdout.write(process.cwd())', { cwd: '/tmp' });
    expect(result.stdout).toContain('tmp');
  });
});

describe('environment', () => {
  it('passes extra variables to the child', async () => {
    const result = await runNode('process.stdout.write(process.env.AF_TEST ?? "unset")', {
      env: { AF_TEST: 'present' },
    });
    expect(result.stdout).toBe('present');
  });

  it('keeps the parent environment so CLI auth still resolves', async () => {
    // The runners rely on each CLI's own local login (§54). Wiping the
    // environment would break exactly the thing the design depends on.
    const result = await runNode('process.stdout.write(process.env.PATH ? "yes" : "no")', {
      env: { AF_TEST: 'present' },
    });
    expect(result.stdout).toBe('yes');
  });
});

describe('stdin', () => {
  it('feeds stdin and closes it', async () => {
    // Without closing, a CLI reading to EOF would hang forever.
    const result = await runNode(
      'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.trim()))',
      { stdin: 'piped input' },
    );
    expect(result.stdout).toBe('piped input');
  });
});

describe('timeout (R-11)', () => {
  it('kills a process that outruns its timeout', async () => {
    const result = await runNode('setTimeout(() => {}, 60_000)', { timeoutSeconds: 0.2 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    // A CLI that traps SIGTERM must not be able to hold the pipeline hostage.
    const result = await runNode(
      'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
      { timeoutSeconds: 0.2, killGraceMs: 100 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
  });

  it('returns whatever output arrived before the kill', async () => {
    const result = await runNode(
      'process.stdout.write("partial");setTimeout(()=>{},60_000)',
      { timeoutSeconds: 0.3 },
    );
    expect(result.stdout).toBe('partial');
    expect(result.timedOut).toBe(true);
  });

  it('does not flag a fast process as timed out', async () => {
    const result = await runNode('process.stdout.write("quick")', { timeoutSeconds: 10 });
    expect(result.timedOut).toBe(false);
  });
});

describe('missing executable', () => {
  it('reports a spawn failure instead of crashing', async () => {
    // Not hypothetical: the Codex CLI on this machine is installed via npm but
    // its native binary is gone, so every invocation fails exactly like this.
    const result = await runner.run({
      command: '/nonexistent/definitely-not-here',
      args: [],
      cwd: process.cwd(),
      timeoutSeconds: 5,
    });

    expect(result.spawnFailed).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).not.toBe('');
  });

  it('reports a spawn failure for a directory that is not executable', async () => {
    const result = await runner.run({
      command: '/tmp',
      args: [],
      cwd: process.cwd(),
      timeoutSeconds: 5,
    });
    expect(result.spawnFailed).toBe(true);
  });
});

describe('output limits', () => {
  it('truncates oversized output and says so', async () => {
    // An agent that dumps a whole repository into stdout must not be able to
    // exhaust memory in the orchestrator.
    const result = await runNode('process.stdout.write("x".repeat(50_000))', {
      maxOutputBytes: 1_000,
    });

    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThan(2_000);
    expect(result.stdout).toContain('truncated');
  });

  it('leaves output under the limit untouched', async () => {
    const result = await runNode('process.stdout.write("small")', { maxOutputBytes: 1_000 });
    expect(result.truncated).toBe(false);
    expect(result.stdout).toBe('small');
  });

  it('truncates stderr on the same terms', async () => {
    const result = await runNode('process.stderr.write("y".repeat(50_000))', {
      maxOutputBytes: 1_000,
    });
    expect(result.truncated).toBe(true);
    expect(result.stderr).toContain('truncated');
  });
});
