import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
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

/**
 * A child that traps SIGTERM, says so, and then stays alive.
 *
 * The handler is installed *before* the announcement, so READY on stdout means
 * "a SIGTERM from here on will be ignored" rather than merely "the process
 * exists".
 */
const READY_CHILD =
  'process.on("SIGTERM",()=>{});process.stdout.write("READY");setInterval(()=>{},1000)';

/**
 * How long this machine needs to get that child to READY, right now.
 *
 * Spawned directly rather than through the runner, because the runner's timeout
 * is the thing being calibrated. Three samples and the worst one, tripled: the
 * intent is a timeout comfortably past start-up without being a number somebody
 * picked, so that a real escalation failure still fails.
 */
async function readyWithin(script: string): Promise<{ timeoutSeconds: number }> {
  const samples: number[] = [];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    samples.push(
      await new Promise<number>((resolve) => {
        const startedAt = Date.now();
        const child = spawn(node, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
        const finish = (ms: number) => {
          child.kill('SIGKILL');
          resolve(ms);
        };
        child.stdout.on('data', () => finish(Date.now() - startedAt));
        child.on('error', () => finish(1_000));
      }),
    );
  }

  const slowest = Math.max(...samples);
  return { timeoutSeconds: Math.max(0.2, (slowest * 3) / 1000) };
}

describe('timeout (R-11)', () => {
  it('kills a process that outruns its timeout', async () => {
    const result = await runNode('setTimeout(() => {}, 60_000)', { timeoutSeconds: 0.2 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    // A CLI that traps SIGTERM must not be able to hold the pipeline hostage.
    //
    // **The child announces readiness, and the timeout is derived from how long
    // that actually took.** The property under test is the escalation — SIGTERM,
    // grace, SIGKILL — and it used to be entangled with a second, unrelated
    // question: whether Node finishes starting up within 200ms. Measured, that
    // is 18–24ms on an idle machine and **51–600ms under a fork storm, with 38
    // of 40 samples over 200ms**. When start-up loses that race the child dies
    // on the default SIGTERM disposition, the signal is SIGTERM, and the test
    // reports a broken escalation that is not broken.
    //
    // So `readyWithin` measures the handshake on this machine, now, and the
    // timeout is set from it. Nothing about the escalation is relaxed: the grace
    // period is unchanged, and a runner that failed to escalate still fails
    // here. What is no longer asserted is a claim about interpreter start-up.
    const startup = await readyWithin(READY_CHILD);

    const result = await runNode(READY_CHILD, {
      timeoutSeconds: startup.timeoutSeconds,
      killGraceMs: 100,
    });

    // The condition was genuinely established before the signal arrived: the
    // handler is installed on the line before READY is written. Without this the
    // assertion below could pass for the wrong reason on a very slow machine.
    expect(result.stdout, 'the child never reported readiness').toContain('READY');
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
  });

  it('kills a child that does not trap SIGTERM with SIGTERM', async () => {
    // The other side of the pair, and what says the escalation above is real
    // rather than the runner always reaching for SIGKILL.
    const result = await runNode('process.stdout.write("READY");setInterval(()=>{},1000)', {
      timeoutSeconds: 0.5,
      killGraceMs: 5_000,
    });

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGTERM');
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

describe('timeout reaches the whole process tree (V-09 regression)', () => {
  // Was a defect: the timeout did not fire at all when the child had children.
  //
  // A grandchild inherits the stdout pipes, and Node emits `close` only once
  // the process has exited *and* every stream is closed — so killing the direct
  // child left the promise pending until the grandchild finished on its own.
  // Measured before the fix: 4s against a 300ms timeout.
  //
  // This is the normal case rather than an exotic one. Every validation command
  // is shelled out, `npm test` spawns node, and the agent CLIs spawn
  // subprocesses of their own.
  const shell = (script: string, overrides: Record<string, unknown> = {}) =>
    runner.run({
      command: '/bin/sh',
      args: ['-c', script],
      cwd: '/tmp',
      timeoutSeconds: 0.3,
      killGraceMs: 150,
      ...overrides,
    });

  it('gives up on schedule even when the child spawned its own children', async () => {
    const startedAt = Date.now();
    const result = await shell('( sleep 5 ) & sleep 8');
    const elapsed = Date.now() - startedAt;

    expect(result.timedOut).toBe(true);
    // Before the fix this waited the full 8 seconds.
    expect(elapsed).toBeLessThan(2_000);
  }, 15_000);

  it('leaves no grandchild running behind it', async () => {
    const { existsSync, rmSync } = await import('node:fs');
    const marker = `/tmp/agent-flow-tree-test-${String(process.pid)}`;
    rmSync(marker, { force: true });

    await shell(`( sleep 1; echo x > ${marker} ) & sleep 8`);

    // The grandchild would write its marker one second in. Wait past that.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const survived = existsSync(marker);
    rmSync(marker, { force: true });
    expect(survived).toBe(false);
  }, 15_000);

  it('still reports a normal exit for a process that finishes in time', async () => {
    // The group signalling must not disturb the ordinary path.
    const result = await shell('echo done', { timeoutSeconds: 10 });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('done');
  }, 15_000);
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
