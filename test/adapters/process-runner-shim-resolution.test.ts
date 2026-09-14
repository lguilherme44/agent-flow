import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeProcessRunner } from '../../src/adapters/process/node-process-runner.js';

const RUNNER = join(process.cwd(), 'src/adapters/process/node-process-runner.ts');

/**
 * The child this runner owns is spawned through a shim-resolving wrapper.
 *
 * On Windows a CLI installed through npm is a `.cmd`, which `CreateProcess` cannot launch
 * and which Node refuses to guess at since the CVE-2024-27980 fix. A bare
 * `child_process.spawn('claude', …)` therefore returns ENOENT on a machine where
 * `claude --version` works in the terminal — and `ClaudeCodeRunner.healthCheck` reads that
 * ENOENT as `spawnFailed` and reports "not installed", which sends the operator to
 * reinstall a CLI that was there all along.
 *
 * Asserted by reading the source because the defect only exists on a platform this suite
 * cannot reach: a behavioural test would pass on macOS and Linux either way, which is the
 * precise reason the bug survived. The positive controls below exist because a rule that
 * scans for text is one typo away from being green about nothing.
 */
describe('the runner resolves an executable the way each platform needs (Windows shims)', () => {
  const source = readFileSync(RUNNER, 'utf8');

  it('reads the module the rules are about', () => {
    // Guards every assertion below from passing vacuously against an empty string.
    expect(source.length).toBeGreaterThan(1_000);
    expect(source).toContain('class NodeProcessRunner');
  });

  it('spawns the runner child through cross-spawn, not node:child_process', () => {
    // The default import is the wrapper; the named `nodeSpawn` is the plain one, kept
    // for `taskkill` only.
    expect(source).toMatch(/^import spawn from 'cross-spawn';$/m);

    const call = /const child = (\w+)\(options\.command/.exec(source);
    expect(call, 'the child spawn call moved — this rule no longer reads it').not.toBeNull();
    expect(call?.[1]).toBe('spawn');
  });

  it('keeps taskkill on the plain spawn, so teardown does not depend on the wrapper', () => {
    expect(source).toMatch(/nodeSpawn\('taskkill'/);
  });

  it('declares cross-spawn as a real dependency, not a dev one', () => {
    // An import that resolves only because a dev tool happens to hoist the package is a
    // consumer's `Cannot find module` at runtime.
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    expect(Object.keys(manifest.dependencies ?? {})).toContain('cross-spawn');
    expect(Object.keys(manifest.devDependencies ?? {})).not.toContain('cross-spawn');
  });

  it('still spawns a PATH-resolved executable and collects its output', async () => {
    // The behavioural half: the wrapper is a no-op on POSIX, and "no-op" has to mean the
    // runner kept working rather than that nothing was measured.
    const result = await new NodeProcessRunner().run({
      command: 'node',
      args: ['-e', 'process.stdout.write("resolved")'],
      cwd: process.cwd(),
      timeoutSeconds: 20,
    });

    expect(result.spawnFailed).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('resolved');
  });

  it('still reports a genuinely missing executable as a spawn failure', async () => {
    // The positive control for the test above: a wrapper that silently succeeded on
    // everything would make "it spawned" meaningless, and would also erase the one
    // signal `healthCheck` uses to say a runner is not installed.
    const result = await new NodeProcessRunner().run({
      command: 'agent-flow-no-such-executable-xyz',
      args: [],
      cwd: process.cwd(),
      timeoutSeconds: 20,
    });

    expect(result.spawnFailed).toBe(true);
  });
});
