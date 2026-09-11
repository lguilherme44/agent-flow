import type { RunActionDeps } from '../../src/app/run-actions.js';
import { InMemoryFileSystem } from './in-memory-file-system.js';
import { FixedClock } from './fixed-clock.js';
import { FakeHost } from './fake-host.js';
import { FakeProcessRunner } from './fake-process-runner.js';

/**
 * Returns a default RunActionDeps with actor { kind: 'keyboard' } and permits
 * overrides.
 */
export function fakeRunActionDeps(overrides: Partial<RunActionDeps> = {}): RunActionDeps {
  return {
    fs: overrides.fs ?? new InMemoryFileSystem(),
    clock: overrides.clock ?? new FixedClock(),
    processRunner:
      overrides.processRunner ??
      new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' }),
    projectDir: overrides.projectDir ?? '/repo',
    globalConfigPath: overrides.globalConfigPath ?? '/install/config.yaml',
    promptsDir: overrides.promptsDir ?? '/install/prompts',
    host: overrides.host ?? new FakeHost(),
    owner: overrides.owner ?? 'cli',
    actor: overrides.actor ?? { kind: 'keyboard' },
    ...overrides,
  };
}

export const runActionDeps = fakeRunActionDeps;
