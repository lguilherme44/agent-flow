import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { judgeAgainstBase, type BaselineDeps } from '../../src/app/baseline-verification.js';

/**
 * What the base says, judged without Git (the integration suite drives the real checkout).
 *
 * Adversarial review: a base command that timed out (124) or could not start (127) is the
 * environment answering, not the base — reading it as "fails on the base too" turned an
 * environment problem into permission, and the cache kept it for the rest of the run.
 */
function deps(exitCode: number): { deps: BaselineDeps; fs: InMemoryFileSystem; released: string[] } {
  const fs = new InMemoryFileSystem();
  const released: string[] = [];
  return {
    fs,
    released,
    deps: {
      fs,
      processRunner: new FakeProcessRunner().always({ exitCode }),
      openCheckout: () => Promise.resolve({ ok: true, cwd: '/base', release: () => (released.push('/base'), Promise.resolve()) }),
      prepare: () => Promise.resolve({ ok: true }),
    },
  };
}

const REQUEST = {
  base: 'a'.repeat(40),
  steps: [{ step: 'lint' as const, command: 'npm run lint' }],
  timeoutSeconds: 60,
  cachePath: '/run/baseline.json',
};

describe('judgeAgainstBase', () => {
  it('reads a failure on the base as pre-existing, a pass as a regression, and caches both', async () => {
    const failing = deps(1);
    expect((await judgeAgainstBase(failing.deps, REQUEST)).get('lint')?.verdict).toBe('pre_existing');
    expect(await failing.fs.exists('/run/baseline.json')).toBe(true);

    const passing = deps(0);
    expect((await judgeAgainstBase(passing.deps, REQUEST)).get('lint')?.verdict).toBe('regression');
  });

  it('says when the base checkout could not be taken away', async () => {
    // Adversarial review: a Windows EBUSY left a `baseline-*` directory with node_modules and
    // nothing on the run said so, unlike a read-only stage's twin.
    const leaky = deps(1);
    const retained: string[] = [];
    const withLeak: BaselineDeps = {
      ...leaky.deps,
      openCheckout: () =>
        Promise.resolve({ ok: true, cwd: '/base', release: () => Promise.resolve({ removed: false, detail: 'EBUSY' }) }),
      onRetained: (detail) => {
        retained.push(detail);
      },
    };

    await judgeAgainstBase(withLeak, REQUEST);

    expect(retained).toEqual(['EBUSY']);
  });

  it('runs the base in the shell the project named, as the head ran', async () => {
    // Merge with master's `commandShell`: a POSIX line under the host default fails on the base
    // for the shell, and that failure would read as pre-existing.
    const named = deps(1);
    const proc = named.deps.processRunner as FakeProcessRunner;

    await judgeAgainstBase(named.deps, { ...REQUEST, commandShell: 'sh' });

    expect(proc.lastCall?.command).toBe('sh');
    expect(proc.lastCall?.args).toEqual(['-c', 'npm run lint']);
  });

  it.each([124, 127])('never reads exit %i on the base as permission, and does not cache it', async (exitCode) => {
    const environment = deps(exitCode);

    const verdict = (await judgeAgainstBase(environment.deps, REQUEST)).get('lint');

    expect(verdict?.verdict).toBe('not_run');
    expect(await environment.fs.exists('/run/baseline.json')).toBe(false);
    expect(environment.released).toEqual(['/base']);
  });
});
