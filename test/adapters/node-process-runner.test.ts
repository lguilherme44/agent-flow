import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * A child that spawns a grandchild, then outlives its own timeout.
 *
 * **Written in Node rather than in `sh`, and that is the whole portability story here.**
 * These tests used `/bin/sh -c '( sleep 1; echo x > /tmp/marker ) & sleep 8'`, which on
 * Windows cannot spawn at all. Two of them then failed outright — and one, `leaves no
 * grandchild running behind it`, *passed*: the marker was absent because nothing had ever
 * run, so the assertion that no grandchild survived was true for the wrong reason. A
 * regression test for V-09 that cannot spawn a tree is the most expensive kind of green.
 *
 * The property under test — the timeout reaches a process the runner did not spawn — has
 * nothing to do with which shell expresses it. `JSON.stringify` carries the marker path
 * into the inner script, which is also what makes a Windows path with backslashes survive.
 */
/**
 * The grandchild announces itself, and only then starts counting down.
 *
 * **Two markers, because one of them was an assumption.** The earlier fixture wrote a
 * single marker one second in, and every caller slept a fixed number of milliseconds
 * before letting the kill land. Measured under a loaded gate on Windows: the kill arrived
 * while the grandchild was still being created, `taskkill /T` walked a tree that did not
 * contain it yet, the direct child died — and the second attempt had no root left to walk,
 * because a pid tree with a dead root reaches nothing. The orphan then wrote its marker
 * and the assertion read a real, narrow platform race as a containment defect.
 *
 * `alive` is written the instant the grandchild runs, so a test can wait for it and make
 * the kill provably later than the process it claims to reach. `survived` is written far
 * enough out that it appears only if the grandchild outlived the kill.
 */
const spawnsAGrandchild = (
  markers: { readonly alive: string; readonly survived: string },
  { holdMs = 20_000, survivesAfterMs = 5_000 } = {},
): string => {
  const grandchild =
    `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(markers.alive)},"x");` +
    `setTimeout(()=>{fs.writeFileSync(${JSON.stringify(markers.survived)},"x")},${String(survivesAfterMs)})`;
  return (
    `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],` +
    `{stdio:"ignore"});setTimeout(()=>{},${String(holdMs)});`
  );
};

/** A marker path this test owns, in the platform's own temp directory. */
const markerPath = (name: string): string =>
  join(tmpdir(), `agent-flow-${name}-${String(process.pid)}`);

/** A pair of markers for one grandchild, cleared before use. */
async function grandchildMarkers(name: string) {
  const { existsSync, rmSync } = await import('node:fs');
  const alive = markerPath(`${name}-alive`);
  const survived = markerPath(`${name}-survived`);
  rmSync(alive, { force: true });
  rmSync(survived, { force: true });

  return {
    alive,
    survived,
    /** Resolves once the grandchild exists. Bounded, so a fixture that never spawns fails. */
    async waitUntilAlive(timeoutMs = 20_000): Promise<void> {
      // Checked before the clock, so `waitUntilAlive(0)` reads as "it must already be
      // there" rather than as an unconditional failure.
      const deadline = Date.now() + timeoutMs;
      do {
        if (existsSync(alive)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      throw new Error('no grandchild was ever created, so nothing could be proved');
    },
    /** True when the grandchild outlived the kill. Clears both markers on the way out. */
    outlivedTheKill(): boolean {
      const survived = existsSync(markerPath(`${name}-survived`));
      rmSync(markerPath(`${name}-alive`), { force: true });
      rmSync(markerPath(`${name}-survived`), { force: true });
      return survived;
    },
  };
}

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
    const target = tmpdir();
    const result = await runNode('process.stdout.write(process.cwd())', { cwd: target });
    // `realpath`, because macOS reports `/var/folders/…` for a `/private/var` temp dir
    // and Windows can hand back a short 8.3 form of the same directory.
    expect(result.stdout.toLowerCase()).toContain(
      target.split(/[\\/]/).filter(Boolean).slice(-1)[0]?.toLowerCase() ?? 'tmp',
    );
  });
});

describe('environment', () => {
  it('passes extra variables to the child', async () => {
    const result = await runNode('process.stdout.write(process.env.AF_TEST ?? "unset")', {
      env: { AF_TEST: 'present' },
    });
    expect(result.stdout).toBe('present');
  });

  it('keeps what a CLI needs to find itself and log in', async () => {
    // The runners rely on each CLI's own local login (§54). The allowlist is a list of
    // what they need, so this is the case that decides whether it is right.
    const result = await runNode(
      'process.stdout.write([process.env.PATH, process.env.HOME].every(Boolean) ? "yes" : "no")',
      { env: { AF_TEST: 'present' } },
    );
    expect(result.stdout).toBe('yes');
  });

  it('does not hand a coding agent a credential it was never given (PRI-17)', async () => {
    // The default. A child used to receive `{ ...process.env }` — every credential the
    // operator's shell exports, most of which have nothing to do with the task.
    const previous = process.env['AWS_SECRET_ACCESS_KEY'];
    process.env['AWS_SECRET_ACCESS_KEY'] = 'must-not-reach-the-child';

    try {
      const result = await runNode(
        'process.stdout.write(process.env.AWS_SECRET_ACCESS_KEY ?? "absent")',
      );
      expect(result.stdout).toBe('absent');
    } finally {
      if (previous === undefined) delete process.env['AWS_SECRET_ACCESS_KEY'];
      else process.env['AWS_SECRET_ACCESS_KEY'] = previous;
    }
  });

  it('hands it over when the caller asks to inherit, and says why at its call site', async () => {
    // `git-command.ts` and `verification-commands.ts` are the two, and both write the
    // reason down. This asserts the escape hatch works rather than that it is used.
    const previous = process.env['AF_INHERIT_PROBE'];
    process.env['AF_INHERIT_PROBE'] = 'inherited';

    try {
      const result = await runNode('process.stdout.write(process.env.AF_INHERIT_PROBE ?? "absent")', {
        envMode: 'inherit',
      });
      expect(result.stdout).toBe('inherited');
    } finally {
      if (previous === undefined) delete process.env['AF_INHERIT_PROBE'];
      else process.env['AF_INHERIT_PROBE'] = previous;
    }
  });

  it('honours a removal even for a name the allowlist would have passed', async () => {
    // A removal is a stronger statement than the allowlist's silence. The Git boundary
    // relies on it, and a name that survived because it was also allowed would be the
    // quietest possible way for `GIT_DIR` to come back.
    const result = await runNode('process.stdout.write(process.env.HOME ? "yes" : "no")', {
      unsetEnv: ['HOME'],
    });
    expect(result.stdout).toBe('no');
  });

  it('passes what the operator declared', async () => {
    const previous = process.env['ACME_REGION'];
    process.env['ACME_REGION'] = 'sa-east-1';

    try {
      const result = await runNode('process.stdout.write(process.env.ACME_REGION ?? "absent")', {
        envPass: ['ACME_'],
      });
      expect(result.stdout).toBe('sa-east-1');
    } finally {
      if (previous === undefined) delete process.env['ACME_REGION'];
      else process.env['ACME_REGION'] = previous;
    }
  });
});

describe('cancellation (PRI-09, PRI-14)', () => {
  // A timeout is the child running out of *its* patience. This is somebody else running
  // out of theirs, and until it existed there was no such thing: the only way to stop an
  // agent mid-flight was to kill the orchestrator, which leaves the agent's own process
  // group alive because nothing signals children when a parent dies.

  it('stops a running child and says the reason was cancellation', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const startedAt = Date.now();
    const result = await runNode('setTimeout(() => {}, 30_000)', {
      signal: controller.signal,
      timeoutSeconds: 30,
      killGraceMs: 150,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.cancelled).toBe(true);
    // Not a timeout. The two mean opposite things to whoever reads the result: one is a
    // failure worth classifying, the other is an operator decision.
    expect(result.timedOut).toBe(false);
    expect(elapsed).toBeLessThan(5_000);
  }, 40_000);

  it('spawns nothing at all when the signal has already aborted', async () => {
    // On a cancelled run, a process started and immediately killed is still an agent
    // invocation somebody is billed for.
    const controller = new AbortController();
    controller.abort();

    const result = await runNode('process.stdout.write("this must never run")', {
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(result.stdout).toBe('');
    expect(result.durationMs).toBe(0);
  });

  it('reaches the whole process group, leaving no grandchild behind', async () => {
    // The same failure the timeout path already documents, on the other path. A cancel
    // that signalled only the direct child would leave exactly the orphans `detached`
    // exists to prevent.
    //
    // **The cancel is the one path where the test owns the clock**, so the ordering is a
    // fact rather than a hope: the abort is fired *after* the grandchild has announced
    // itself, which is the only way "the kill reached it" means anything.
    const markers = await grandchildMarkers('cancel-test');

    const controller = new AbortController();
    const run = runNode(spawnsAGrandchild(markers), {
      timeoutSeconds: 60,
      killGraceMs: 150,
      signal: controller.signal,
    });

    await markers.waitUntilAlive();
    controller.abort();
    await run;

    // Past the point the grandchild would have written, had it lived.
    await new Promise((resolve) => setTimeout(resolve, 6_000));

    expect(markers.outlivedTheKill()).toBe(false);
  }, 60_000);

  it('leaves an ordinary run untouched when the signal never fires', async () => {
    const controller = new AbortController();

    const result = await runNode('process.stdout.write("done")', { signal: controller.signal });

    expect(result.cancelled).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('done');
  });

  it('reports cancellation rather than timeout when both could be true', async () => {
    // The operator's decision is the reason it stopped. Recording it as a timeout would
    // classify the work as having failed.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 120);

    const result = await runNode('setTimeout(()=>{},8000)', {
      timeoutSeconds: 0.3,
      killGraceMs: 100,
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
  }, 20_000);
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

    /**
     * **The escalation is asserted where an escalation exists.**
     *
     * `SIGTERM` is a POSIX concept. On Windows there is no signal a process can trap and
     * ignore — Node maps `child.kill('SIGTERM')` onto `TerminateProcess`, and this runner
     * reaches for `taskkill /T /F` — so the child above dies on the first attempt and the
     * grace period never elapses. Asserting `SIGKILL` there asserts a mechanism the
     * platform does not have, and it failed for that reason rather than for a defect.
     *
     * What is common to both, and what the pipeline actually depends on, is the sentence
     * above: a CLI that traps SIGTERM cannot hold the run hostage. That is `timedOut`,
     * and it is asserted on every platform.
     */
    if (process.platform !== 'win32') expect(result.signal).toBe('SIGKILL');
    else expect(result.exitCode === 0 && result.signal === null).toBe(false);
  });

  it('kills a child that does not trap SIGTERM with SIGTERM', async () => {
    // The other side of the pair, and what says the escalation above is real
    // rather than the runner always reaching for SIGKILL.
    const result = await runNode('process.stdout.write("READY");setInterval(()=>{},1000)', {
      timeoutSeconds: 0.5,
      killGraceMs: 5_000,
    });

    expect(result.timedOut).toBe(true);

    // The pair only exists where the two signals are distinguishable. See the escalation
    // test above: on Windows there is one way to stop a process, and `taskkill /F`
    // reports no signal at all — so what is asserted there is that it stopped, promptly,
    // rather than which of two signals stopped it.
    if (process.platform !== 'win32') expect(result.signal).toBe('SIGTERM');
    else expect(result.exitCode).not.toBe(0);
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
  const tree = (script: string, overrides: Record<string, unknown> = {}) =>
    runNode(script, { timeoutSeconds: 0.3, killGraceMs: 150, ...overrides });

  it('gives up on schedule even when the child spawned its own children', async () => {
    const markers = await grandchildMarkers('tree-schedule');
    const startedAt = Date.now();
    const result = await tree(spawnsAGrandchild(markers));
    const elapsed = Date.now() - startedAt;

    expect(result.timedOut).toBe(true);
    // Before the fix this waited the full hold.
    expect(elapsed).toBeLessThan(4_000);
    markers.outlivedTheKill();
  }, 20_000);

  it('can see a survivor, and names the limit of a pid tree', async () => {
    // The control this pair needed and did not have, and it took two measurements to get
    // right — both worth keeping, because each one is a claim about the platform.
    //
    //   1. Switching the tree kill off does **not** turn the assertion red on Windows: a
    //      fully started grandchild dies with its parent anyway. So "no marker" proves
    //      nothing until something shows a marker can appear at all.
    //   2. `detached: true` does not escape either. `taskkill /T` walks *parent pids*, and
    //      detaching changes the console, not the parentage.
    //
    // What does escape is a process whose parent has already exited: it is re-parented,
    // so it is in nobody's tree, and no pid-rooted kill can reach it. That is the honest
    // limit of this mechanism rather than a defect in it — and it is exactly the survivor
    // the assertion below has to be able to see.
    const markers = await grandchildMarkers('tree-control');
    const orphan =
      `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(markers.alive)},"x");` +
      `setTimeout(()=>{fs.writeFileSync(${JSON.stringify(markers.survived)},"x")},5000)`;
    // The middle process spawns and **exits at once** — no timer — so by the time the
    // kill lands its child has already been re-parented out of the tree.
    const escapes =
      `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(orphan)}],` +
      `{stdio:"ignore",detached:true}).unref();`;

    const result = await tree(
      `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(escapes)}],{stdio:"ignore"});` +
        `setTimeout(()=>{},20000);`,
      { timeoutSeconds: 3 },
    );

    expect(result.timedOut).toBe(true);
    await markers.waitUntilAlive(0);
    await new Promise((resolve) => setTimeout(resolve, 6_000));

    expect(markers.outlivedTheKill(), 'a re-parented process should have outlived the kill').toBe(true);
  }, 30_000);

  it('leaves no grandchild running behind it', async () => {
    // **Three seconds, not 300 ms, and the number is the whole repair.** The timeout is
    // the one path where the runner owns the clock, so the test cannot fire the kill
    // after the grandchild exists — it can only give the tree enough room to *be* a tree
    // before the kill lands. At 300 ms it did not: measured under a loaded gate, the kill
    // arrived mid-creation, `taskkill /T` walked a tree the grandchild was not in yet, and
    // the second attempt had a dead root and reached nothing. The orphan was real; the
    // defect it looked like was not.
    //
    // The alive marker is what turns the budget into evidence: if the grandchild never
    // announced itself, the test says so instead of quietly passing on a tree that was
    // never built — the same trap the `/bin/sh` version of this test fell into.
    const markers = await grandchildMarkers('tree-test');

    const result = await tree(spawnsAGrandchild(markers), { timeoutSeconds: 3 });

    expect(result.timedOut, 'no tree was spawned, so nothing was proved').toBe(true);
    await markers.waitUntilAlive(0);

    // Past the point the grandchild would have written, had it lived.
    await new Promise((resolve) => setTimeout(resolve, 6_000));

    expect(markers.outlivedTheKill()).toBe(false);
  }, 30_000);

  it('still reports a normal exit for a process that finishes in time', async () => {
    // The tree signalling must not disturb the ordinary path.
    const result = await tree('process.stdout.write("done")', { timeoutSeconds: 10 });

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
