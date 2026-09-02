import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { StateStore } from '../../src/app/state-store.js';
import { Scheduler } from '../../src/app/scheduler.js';
import { teamWaveAdmission } from '../../src/core/team/waves.js';
import { deriveAgentRoster } from '../../src/core/collaboration/roster.js';
import { resolveTaskAgent } from '../../src/core/team/policy.js';
import { exclusiveContention } from '../../src/core/team/ownership.js';
import { overlappingPaths } from '../../src/core/file-overlap.js';
import { routeTask } from '../../src/core/router.js';
import {
  GlobalConfigSchema,
  PlanSchema,
  TaskSchema,
  type GlobalConfig,
  type Task,
} from '../../src/contracts/index.js';
import type { TaskExecutor } from '../../src/app/task-executor.js';
import type { TaskResult } from '../../src/contracts/index.js';
import { TaskResultSchema } from '../../src/contracts/index.js';

/**
 * Eight ready tasks, four members, three ways a wave can be wrong (§12 concurrency).
 *
 * **The assertion that matters is not "no violation" but "maximum safe concurrency".** A
 * constraint that serialised the whole plan would satisfy every safety property in this
 * file and be indistinguishable from having no parallelism at all — which is why every
 * safety test below is paired with a test that the wave was as wide as it was allowed to
 * be, and why the widths are asserted as numbers rather than as "more than one".
 *
 * Three constraints are in play at once and they are not the same question:
 *
 *   file overlap    two tasks name a path in common (AD-43, unconditional)
 *   ownership       two tasks write into one area declared exclusive (M5)
 *   capacity        the members who could take them are full (M5)
 *
 * Run through the **real** `Scheduler`, with a stub executor that records what shared a
 * wave — because a wave is a property of the loop, and a test that called the admission
 * function in a loop of its own would be testing a copy of the scheduler.
 */

const PROJECT = '/repo';
const NOW = '2026-08-09T21:00:00.000Z';

const ROLES = {
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
};

/**
 * Four members, and every dimension of the problem represented once.
 *
 *   dba       owns `src/db/**` exclusively, takes one at a time
 *   backend   owns `src/server/**`, takes two
 *   frontend  owns `apps/web/**`, takes two
 *   generalist owns nothing, takes one — the member a task with no home falls to
 */
const TEAM: GlobalConfig = GlobalConfigSchema.parse({
  runners: { claude: { type: 'claude-code-cli' } },
  roles: ROLES,
  collaboration: { enabled: true },
  teams: {
    core: {
      members: {
        dba: {
          roles: 'executor.normal',
          runner: 'claude',
          skills: ['sql'],
          capacity: { maxConcurrentTasks: 1 },
          ownership: { exclusive: ['src/db/**'] },
        },
        backend: {
          roles: 'executor.normal',
          runner: 'claude',
          skills: ['typescript'],
          capacity: { maxConcurrentTasks: 2 },
          ownership: { preferred: ['src/server/**'] },
        },
        frontend: {
          roles: 'executor.normal',
          runner: 'claude',
          skills: ['vue'],
          capacity: { maxConcurrentTasks: 2 },
          ownership: { preferred: ['apps/web/**'] },
        },
        generalist: {
          roles: 'executor.normal',
          runner: 'claude',
          capacity: { maxConcurrentTasks: 1 },
        },
      },
      policies: {},
    },
  },
});

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

/**
 * Eight tasks, ready together, contending in all three ways.
 *
 *   001, 002   two migrations under one exclusive area, sharing no path
 *   003, 004   two server files, one of them shared with 005
 *   005        names `src/server/shared.ts`, which 004 also names
 *   006, 007   two web files, no contention
 *   008        no declared files at all — "the plan did not say"
 */
const TASKS: readonly Task[] = [
  task('TASK-001', ['src/db/001.sql']),
  task('TASK-002', ['src/db/002.sql']),
  task('TASK-003', ['src/server/a.ts']),
  task('TASK-004', ['src/server/shared.ts']),
  task('TASK-005', ['src/server/shared.ts']),
  task('TASK-006', ['apps/web/a.vue']),
  task('TASK-007', ['apps/web/b.vue']),
  task('TASK-008', []),
];

/** Records which tasks were actually in flight together. */
function recordingExecutor() {
  const waves: string[][] = [];
  let inFlight: string[] = [];
  let settling: Promise<void> | undefined;

  const executor = {
    execute: async (candidate: Task): Promise<TaskResult> => {
      inFlight.push(candidate.id);
      // One microtask turn: every task the scheduler dispatched in this wave has been
      // entered before any of them returns, so `inFlight` is the wave.
      settling ??= Promise.resolve().then(() => {
        waves.push([...inFlight].sort());
        inFlight = [];
        settling = undefined;
      });
      await settling;

      return TaskResultSchema.parse({
        task: candidate.id,
        status: 'completed',
        runner: 'fake',
        reasoning: 'medium',
        startedAt: NOW,
        finishedAt: NOW,
        validation: { passed: true, commands: [] },
      });
    },
  } as unknown as TaskExecutor;

  return { executor, waves };
}

async function run(concurrency: number, config: GlobalConfig = TEAM) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const store = new StateStore({ fs, clock, projectDir: PROJECT });
  const created = await store.createRun('eight at once');
  const { executor, waves } = recordingExecutor();

  const scheduler = new Scheduler({
    store,
    executor,
    maxConcurrency: concurrency,
    waveAdmission: teamWaveAdmission({
      config,
      roster: deriveAgentRoster(config),
      canImplement: () => true,
      routedRole: (candidate) => routeTask(candidate),
      now: NOW,
    }),
  });

  await scheduler.run(PlanSchema.parse({ feature: 'f', tasks: [...TASKS] }), created.runId, '# SDD');

  return { store, runId: created.runId, waves };
}

/** Who the policy would assign each task in a wave to, in admission order. */
function assignees(wave: readonly string[]): Map<string, string> {
  const byId = new Map(TASKS.map((candidate) => [candidate.id, candidate]));
  const inFlight = new Map<string, number>();
  const out = new Map<string, string>();

  for (const id of wave) {
    const candidate = byId.get(id);
    if (candidate === undefined) continue;
    const assignment = resolveTaskAgent({
      task: candidate,
      routedRole: routeTask(candidate),
      config: TEAM,
      roster: deriveAgentRoster(TEAM),
      handoffs: [],
      inFlight,
      canImplement: () => true,
      now: NOW,
    });
    out.set(id, assignment.agentId);
    inFlight.set(assignment.agentId, (inFlight.get(assignment.agentId) ?? 0) + 1);
  }

  return out;
}

describe('eight tasks, four members, three constraints', () => {
  it('runs every one of them', async () => {
    // Narrowing delays; it never drops work. Everything else here is worthless if this
    // is not true.
    const { store, runId } = await run(8);
    const states = (await store.loadRun(runId)).tasks;

    expect(states).toHaveLength(8);
    expect(states.every((entry) => entry.state === 'completed')).toBe(true);
  });

  it('never puts two tasks that name a path in common in one wave', async () => {
    const { waves } = await run(8);

    for (const wave of waves) {
      for (const a of wave) {
        for (const b of wave) {
          if (a >= b) continue;
          const left = TASKS.find((t) => t.id === a);
          const right = TASKS.find((t) => t.id === b);
          expect(overlappingPaths(left?.files.likely ?? [], right?.files.likely ?? []), `${a}/${b}`).toEqual([]);
        }
      }
    }
  });

  it('never puts two writers into one exclusive area in one wave', async () => {
    // The constraint file overlap cannot see: 001 and 002 name no path in common.
    const rules = Object.values(TEAM.teams?.['core']?.members ?? {}).map((m) => m.ownership);
    const { waves } = await run(8);

    for (const wave of waves) {
      for (const a of wave) {
        for (const b of wave) {
          if (a >= b) continue;
          const left = TASKS.find((t) => t.id === a);
          const right = TASKS.find((t) => t.id === b);
          expect(
            exclusiveContention(rules, left?.files.likely ?? [], right?.files.likely ?? []),
            `${a}/${b}`,
          ).toEqual([]);
        }
      }
    }
  });

  it('never puts a member over its capacity in one wave', async () => {
    const capacities = new Map(
      Object.entries(TEAM.teams?.['core']?.members ?? {}).map(([id, m]) => [
        id,
        m.capacity.maxConcurrentTasks,
      ]),
    );
    const { waves } = await run(8);

    for (const wave of waves) {
      const held = new Map<string, number>();
      for (const [, agent] of assignees(wave)) {
        held.set(agent, (held.get(agent) ?? 0) + 1);
      }
      for (const [agent, count] of held) {
        // A task the team could not take falls back to the router's role, which has no
        // capacity — so only configured members are checked.
        const limit = capacities.get(agent);
        if (limit !== undefined) expect(count, `${agent} in ${wave.join(',')}`).toBeLessThanOrEqual(limit);
      }
    }
  });

  it('runs the plan as wide as the constraints allow, not one task at a time', async () => {
    // **The test that would fail if the constraint were simply "serialise everything".**
    // The team can hold six at once (1 + 2 + 2 + 1) and the plan's own contention is what
    // keeps the first wave below that — asserted as a number, because "more than one" is
    // satisfied by two and this plan permits more.
    const { waves } = await run(8);

    expect(waves[0]?.length).toBeGreaterThanOrEqual(4);
    expect(waves.length).toBeLessThanOrEqual(3);
  });

  it('forms the same waves twice', async () => {
    // The admission is greedy over an order the DAG fixes, so two runs of one plan
    // schedule identically. Without this, a resumed run could reroute for no reason.
    const first = await run(8);
    const second = await run(8);

    expect(first.waves).toEqual(second.waves);
  });

  it('fills the team exactly, and a lower limit narrows the window rather than the team', async () => {
    // **The maximum-safe-concurrency measurement.** The four members hold 1 + 2 + 2 + 1 =
    // six at once, and the first wave is six: the constraint is spending the whole team
    // and the plan's own contention is what keeps 002 and 005 out of it.
    const full = await run(8);
    expect(full.waves[0]).toEqual([
      'TASK-001',
      'TASK-003',
      'TASK-004',
      'TASK-006',
      'TASK-007',
      'TASK-008',
    ]);

    // At six the *scheduler's* window is the first six ready tasks, and 002 and 005 are
    // still refused inside it — so four run. The team constraint did not become tighter;
    // the window it was asked about became smaller, which is the scheduler's decision and
    // not this constraint's.
    const narrower = await run(6);
    expect(narrower.waves[0]).toEqual(['TASK-001', 'TASK-003', 'TASK-004', 'TASK-006']);
    expect(narrower.waves.flat().sort()).toEqual(full.waves.flat().sort());
  });

  it('narrows to the configured limit when the limit is the tighter of the two', async () => {
    // The scheduler's own ceiling still applies. A team constraint only ever removes
    // tasks from the window the scheduler already chose.
    const { waves } = await run(2);

    for (const wave of waves) expect(wave.length).toBeLessThanOrEqual(2);
  });

  it('records a reason for every task it held back', async () => {
    // A wave that narrowed without saying why is a run an operator cannot reason about.
    const { store, runId, waves } = await run(8);
    const events = await store.readEvents(runId);

    const deferrals = events.filter((event) =>
      ['wave_serialised_for_overlap', 'wave_deferred_for_capacity', 'wave_deferred_for_ownership'].includes(
        event.type,
      ),
    );

    // Eight tasks over N waves: every task after the first wave was held back at least
    // once, and each holding has a row.
    const heldBack = 8 - (waves[0]?.length ?? 0);
    expect(deferrals.length).toBeGreaterThanOrEqual(heldBack);
    for (const deferral of deferrals) {
      expect(typeof deferral.detail['task']).toBe('string');
    }
  });

  it('holds the second migration for ownership, not for capacity', async () => {
    // The recorded reason has to be the one a person can act on. Two migrations are not
    // "the team is full"; they are an area somebody said takes one writer.
    const { store, runId } = await run(8);
    const events = await store.readEvents(runId);

    const ownership = events.filter((event) => event.type === 'wave_deferred_for_ownership');
    expect(ownership.map((event) => event.detail['task'])).toContain('TASK-002');
    expect(ownership[0]?.detail['patterns']).toEqual(['src/db/**']);
  });

  it('holds the second writer of a shared file for overlap, not for ownership', async () => {
    // Overlap is unconditional and comes first, so a pair that shares a path keeps the
    // reason AD-43 gives even on a team run.
    const { store, runId } = await run(8);
    const events = await store.readEvents(runId);

    const overlap = events.filter((event) => event.type === 'wave_serialised_for_overlap');
    expect(overlap.map((event) => event.detail['task'])).toContain('TASK-005');
    expect(overlap.find((event) => event.detail['task'] === 'TASK-005')?.detail['paths']).toEqual([
      'src/server/shared.ts',
    ]);
  });

  it('is wider with no team than with one, and correct either way', async () => {
    // The measurement that says the constraint is doing something. A team narrows waves;
    // if the two were the same, nothing here would be under test.
    const legacy = GlobalConfigSchema.parse({
      runners: { claude: { type: 'claude-code-cli' } },
      roles: ROLES,
      collaboration: { enabled: true },
    });

    const withTeam = await run(8);
    const without = await run(8, legacy);

    expect(without.waves[0]?.length).toBeGreaterThan(withTeam.waves[0]?.length ?? 0);
    // And nothing is lost either way.
    const all = (waves: string[][]) => waves.flat().sort();
    expect(all(without.waves)).toEqual(all(withTeam.waves));
  });
});
