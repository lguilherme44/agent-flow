import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { LOCK_VERSION } from '../../src/app/run-execution-lock.js';
import { review, type RunActionDeps } from '../../src/app/run-actions.js';

/**
 * §18.2 — `review` under the run execution lease, and only where it needs one.
 *
 * At M2-05 `review` was deliberately outside the lease, and that was correct: it
 * read the user's working tree, so it could not collide with anything. §19.1
 * moves `runVerification` and the reviewer's `GitClient` into the **integration
 * worktree** — the same checkout the Integrator merges into — and two failures
 * open at once:
 *
 *   - a review running under a scheduler would run lint, typecheck, test and
 *     build over a tree a merge is rewriting underneath it, and report a result
 *     for a tree that never existed at any single instant;
 *   - recovery detects a crashed merge by observing `MERGE_HEAD` in that
 *     worktree, and a concurrent review observing the same worktree mid-merge
 *     would reach a conclusion about a run that is perfectly healthy.
 *
 * So the lease is taken for **what the command touches**, not for what it is
 * called: an isolated review takes it, a sequential review does not.
 */

const PROJECT_CONFIG = `project:
  name: demo
  type: node
commands:
  test: npm test
`;

const PROMPTS = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
  'verification',
  'final-review',
];

async function project(isolation: 'worktree' | 'none') {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const host = new FakeHost();

  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
  for (const name of PROMPTS) {
    fs.seed(
      `/install/prompts/${name}.md`,
      `---\npermissions: read-only\noutputFormat: markdown\nrequiredVars: [repositoryMap]\n---\n\n# ${name}\n`,
    );
  }
  fs.seed(
    '/install/prompts/implementation.md',
    '---\npermissions: write\noutputFormat: json\nrequiredVars: [task, sdd]\n---\n\n# implementation\n',
  );

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('a feature', (runId) =>
    isolation === 'worktree'
      ? {
          isolationMode: 'worktree' as const,
          planningBase: 'a'.repeat(40),
          gitRunKey: `${runId}-0f3a91c4bd27e615`,
        }
      : { isolationMode: 'none' as const },
  );

  const deps: RunActionDeps = {
    fs,
    clock,
    processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: '' }),
    projectDir: '/repo',
    globalConfigPath: '/install/config.yaml',
    promptsDir: '/install/prompts',
    host,
    owner: 'cli',
  };

  return { fs, host, store, deps, runId: run.runId };
}

/** A claim on disk, as a holder in another process would have left one. */
function holdLock(fs: InMemoryFileSystem, runId: string, pid: number): void {
  fs.seed(
    `/repo/.agent-flow/runs/${runId}/execution.lock.1`,
    JSON.stringify({
      version: LOCK_VERSION,
      generation: 1,
      runId,
      pid,
      hostname: 'test-host',
      owner: 'cli',
      operation: 'run',
      createdAt: '2026-08-10T19:00:00.000Z',
    }),
  );
}

describe('review while the run holds its lease (§18.2)', () => {
  it('is refused with run_busy in worktree mode', async () => {
    const { fs, host, deps, runId } = await project('worktree');
    host.spawn(31_337);
    holdLock(fs, runId, 31_337);

    const outcome = await review(deps, runId);

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe('run_busy');
    // And it names what is busy, so a person is not left guessing whether they
    // are competing with their own terminal.
    expect(!outcome.ok && outcome.error.message).toContain('executed');
  });

  it('says so before it reads anything about the run', async () => {
    // The refusal has to come from the lease rather than from a missing plan:
    // the point is that nothing observed the integration worktree at all.
    const { fs, host, store, deps, runId } = await project('worktree');
    host.spawn(31_337);
    holdLock(fs, runId, 31_337);

    await review(deps, runId);

    const types = (await store.readEvents(runId)).map((event) => event.type);
    expect(types).not.toContain('execution_lock_acquired');
    expect(await store.readArtifact(runId, 'verification')).toBeNull();
    expect(await store.readArtifact(runId, 'finalReview')).toBeNull();
  });

  it('is not refused in sequential mode, where it only reads the project directory', async () => {
    // §25.1 and §18.2 together: the lease is taken for what the command touches.
    // A sequential review reads the user's tree exactly as it always has, so
    // refusing it because a run is busy would be a refusal with nothing behind it.
    const { fs, host, deps, runId } = await project('none');
    host.spawn(31_337);
    holdLock(fs, runId, 31_337);

    const outcome = await review(deps, runId);

    expect(outcome.ok).toBe(false);
    // It got past the lease and stopped on the run's own contents instead.
    expect(!outcome.ok && outcome.error.code).not.toBe('run_busy');
    expect(!outcome.ok && outcome.error.code).toBe('no_plan');
  });

  it('refuses an isolated run whose integration branch was never initialised', async () => {
    // §19.2: one tree, and it is the commit `state.integrationHead` names. A run
    // that never integrated anything has no such commit, and falling back to the
    // user's working tree would be reviewing something else entirely — which is
    // exactly the "verified tree A, reviewed tree B" split that would make a
    // green run mean nothing.
    const { fs, store, deps, runId } = await project('worktree');
    await store.writeArtifact(runId, 'sdd', '# SDD\n');
    await store.writeArtifact(
      runId,
      'plan',
      JSON.stringify({
        feature: 'a feature',
        tasks: [
          {
            id: 'TASK-001',
            title: 'Work',
            description: 'Do it.',
            complexity: 'trivial',
            risk: 'low',
            dependencies: [],
            requirements: ['FR-001'],
            acceptanceCriteria: ['Done.'],
            validation: ['test'],
          },
        ],
      }),
    );

    const outcome = await review(deps, runId);

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe('integration_head_missing');
    // Nothing ran against the user's tree on the way to that answer.
    expect(await fs.exists('/repo/.agent-flow/runs/' + runId + '/reviews/verification.json')).toBe(
      false,
    );
  });
});
