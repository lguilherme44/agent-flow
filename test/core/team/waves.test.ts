import { describe, it, expect } from 'vitest';
import { teamWaveAdmission } from '../../../src/core/team/waves.js';
import { deriveAgentRoster } from '../../../src/core/collaboration/roster.js';
import { GlobalConfigSchema, TaskSchema, type GlobalConfig, type Task } from '../../../src/contracts/index.js';

/**
 * What a team forbids a wave from holding (M5-07, §29–§33).
 *
 * **Two constraints that a scheduler asks about and does not own.** The scheduler decides
 * ordering, width and timing exactly as it did in M2; this only ever answers "may this
 * one join", and only ever with a no.
 *
 * The property that must never break is at the bottom of this file: **a wave of one is
 * always admissible.** Both constraints are relations between a candidate and the tasks
 * already in the wave, so the first candidate faces neither — which is what makes it
 * impossible for a full team or an exclusive area to stall a run rather than slow it.
 */

const NOW = '2026-08-09T21:00:00.000Z';

function task(id: string, files: readonly string[]): Task {
  return TaskSchema.parse({
    id,
    title: `Task ${id}`,
    description: 'Some work.',
    complexity: 'normal',
    risk: 'low',
    dependencies: [],
    requirements: ['FR-001'],
    files: { likely: [...files] },
    acceptanceCriteria: ['It compiles.'],
    validation: ['test'],
  });
}

function withTeam(members: Record<string, Record<string, unknown>>): GlobalConfig {
  return GlobalConfigSchema.parse({
    runners: { claude: { type: 'claude-code-cli' } },
    roles: {
      architect: { runner: 'claude', effort: 'high' },
      sdd: { runner: 'claude', effort: 'high' },
      planner: { runner: 'claude', effort: 'high' },
      planReviewer: { runner: 'claude', effort: 'high' },
      executors: {
        trivial: { runner: 'claude', effort: 'low' },
        normal: { runner: 'claude', effort: 'medium' },
        complex: { runner: 'claude', effort: 'high' },
      },
      verification: { runner: 'claude', effort: 'medium' },
      finalReviewer: { runner: 'claude', effort: 'high' },
    },
    teams: {
      core: {
        members: Object.fromEntries(
          Object.entries(members).map(([id, member]) => [
            id,
            { roles: 'executor.normal', runner: 'claude', ...member },
          ]),
        ),
        policies: {},
      },
    },
  });
}

function admissionFor(config: GlobalConfig): ReturnType<typeof teamWaveAdmission> {
  return teamWaveAdmission({
    config,
    roster: deriveAgentRoster(config),
    canImplement: () => true,
    routedRole: () => 'executor.normal',
    now: NOW,
  });
}

/** The greedy admission the scheduler performs, so a whole wave can be asserted at once. */
function waveOf(config: GlobalConfig, ready: readonly Task[]): string[] {
  const admit = admissionFor(config);
  const batch: Task[] = [];
  for (const candidate of ready) {
    if (admit(candidate, batch) === undefined) batch.push(candidate);
  }
  return batch.map((held) => held.id);
}

describe('a configuration with no team', () => {
  it('admits everything, so waves are the ones M2 formed', () => {
    // M5-ACC-01. The constraints are what a team buys; a legacy run buys nothing and
    // pays nothing.
    const legacy = GlobalConfigSchema.parse({
      runners: { claude: { type: 'claude-code-cli' } },
      roles: {
        architect: { runner: 'claude', effort: 'high' },
        sdd: { runner: 'claude', effort: 'high' },
        planner: { runner: 'claude', effort: 'high' },
        planReviewer: { runner: 'claude', effort: 'high' },
        executors: {
          trivial: { runner: 'claude', effort: 'low' },
          normal: { runner: 'claude', effort: 'medium' },
          complex: { runner: 'claude', effort: 'high' },
        },
        verification: { runner: 'claude', effort: 'medium' },
        finalReviewer: { runner: 'claude', effort: 'high' },
      },
    });

    expect(
      waveOf(legacy, [task('TASK-001', ['src/db/a.ts']), task('TASK-002', ['src/db/b.ts'])]),
    ).toEqual(['TASK-001', 'TASK-002']);
  });
});

describe('an area somebody declared exclusive', () => {
  const config = withTeam({
    dba: { ownership: { exclusive: ['src/db/**'] } },
    backend: { capacity: { maxConcurrentTasks: 4 } },
  });

  it('holds back the second task that writes into it', () => {
    // **The case file overlap cannot see.** These two name no path in common, so
    // `core/file-overlap.ts` is silent — and somebody said this area takes one writer.
    const admit = admissionFor(config);
    const deferral = admit(task('TASK-002', ['src/db/migrations/001.sql']), [
      task('TASK-001', ['src/db/schema.ts']),
    ]);

    expect(deferral?.reason).toBe('ownership');
    expect(deferral?.waitsFor).toBe('TASK-001');
    expect(deferral?.patterns).toEqual(['src/db/**']);
  });

  it('says which area, so an operator can act on the row', () => {
    const admit = admissionFor(config);
    const deferral = admit(task('TASK-002', ['src/db/b.ts']), [task('TASK-001', ['src/db/a.ts'])]);

    expect(deferral?.detail).toContain('src/db/**');
  });

  it('admits a task that writes somewhere else entirely', () => {
    const admit = admissionFor(config);

    expect(
      admit(task('TASK-002', ['src/server/routes.ts']), [task('TASK-001', ['src/db/a.ts'])]),
    ).toBeUndefined();
  });

  it('does not hold back a second writer into a merely preferred area', () => {
    // A preference ranks; it does not narrow a wave. A preference with teeth would be an
    // exclusive claim an operator did not know they were making.
    const preferred = withTeam({
      dba: { ownership: { preferred: ['src/db/**'] }, capacity: { maxConcurrentTasks: 4 } },
    });
    const admit = admissionFor(preferred);

    expect(
      admit(task('TASK-002', ['src/db/b.ts']), [task('TASK-001', ['src/db/a.ts'])]),
    ).toBeUndefined();
  });

  it('serialises a run of migrations into one task per wave', () => {
    expect(
      waveOf(config, [
        task('TASK-001', ['src/db/a.sql']),
        task('TASK-002', ['src/db/b.sql']),
        task('TASK-003', ['src/db/c.sql']),
      ]),
    ).toEqual(['TASK-001']);
  });
});

describe('a team that is full', () => {
  it('holds back the task nobody has room for', () => {
    const config = withTeam({ solo: {} });
    const admit = admissionFor(config);

    const deferral = admit(task('TASK-002', ['src/b.ts']), [task('TASK-001', ['src/a.ts'])]);

    expect(deferral?.reason).toBe('capacity');
    expect(deferral?.agents).toEqual(['solo']);
  });

  it('admits as many tasks as the team has room for, and no more', () => {
    // §33: the constraint narrows a wave to what the team can hold, and does not narrow
    // it further. Two members of one each take one task; the third waits.
    const config = withTeam({ alpha: {}, omega: {} });

    expect(
      waveOf(config, [
        task('TASK-001', ['src/a.ts']),
        task('TASK-002', ['src/b.ts']),
        task('TASK-003', ['src/c.ts']),
      ]),
    ).toEqual(['TASK-001', 'TASK-002']);
  });

  it('lets a member with room for two take two in one wave', () => {
    const config = withTeam({ solo: { capacity: { maxConcurrentTasks: 2 } } });

    expect(
      waveOf(config, [
        task('TASK-001', ['src/a.ts']),
        task('TASK-002', ['src/b.ts']),
        task('TASK-003', ['src/c.ts']),
      ]),
    ).toEqual(['TASK-001', 'TASK-002']);
  });

  it('does not hold back a task no member could ever take', () => {
    // A member excluded for its role stays excluded next wave too, so waiting achieves
    // nothing — the router's fallback runs it. Deferring here would be a deadlock spelled
    // as a policy.
    const config = withTeam({ reviewer: { roles: 'finalReviewer' } });
    const admit = admissionFor(config);

    expect(
      admit(task('TASK-002', ['src/b.ts']), [task('TASK-001', ['src/a.ts'])]),
    ).toBeUndefined();
  });

  it('does not hold back a task whose members no runner can serve', () => {
    const config = withTeam({ solo: {} });
    const admit = teamWaveAdmission({
      config,
      roster: deriveAgentRoster(config),
      canImplement: () => false,
      routedRole: () => 'executor.normal',
      now: NOW,
    });

    expect(
      admit(task('TASK-002', ['src/b.ts']), [task('TASK-001', ['src/a.ts'])]),
    ).toBeUndefined();
  });
});

describe('the invariant that keeps a run moving', () => {
  it('always admits the first candidate, however full and however exclusive', () => {
    // **A wave of one is always admissible.** Both constraints are relations to the
    // tasks already admitted, and there are none. Without this a full team stalls a run
    // rather than slowing it, and the stall is silent.
    const config = withTeam({ solo: { ownership: { exclusive: ['**'] } } });
    const admit = admissionFor(config);

    expect(admit(task('TASK-001', ['src/a.ts']), [])).toBeUndefined();
  });

  it('reports ownership rather than capacity when both apply', () => {
    // The recorded reason has to be the one a person can act on, and a contended
    // exclusive area is not solved by waiting for a member to free up.
    const config = withTeam({ solo: { ownership: { exclusive: ['src/db/**'] } } });
    const admit = admissionFor(config);

    const deferral = admit(task('TASK-002', ['src/db/b.ts']), [task('TASK-001', ['src/db/a.ts'])]);
    expect(deferral?.reason).toBe('ownership');
  });

  it('is deterministic — the same wave forms twice', () => {
    const config = withTeam({ alpha: {}, omega: {} });
    const ready = [task('TASK-001', ['src/a.ts']), task('TASK-002', ['src/b.ts']), task('TASK-003', ['src/c.ts'])];

    expect(waveOf(config, ready)).toEqual(waveOf(config, ready));
  });
});
