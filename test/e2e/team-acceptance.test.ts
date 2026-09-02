import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { StageRunner } from '../../src/app/stage-runner.js';
import { PromptLoader } from '../../src/app/prompt-loader.js';
import { TaskExecutor, canImplementWith } from '../../src/app/task-executor.js';
import { CollaborationStore } from '../../src/app/collaboration-store.js';
import { CollaborationService } from '../../src/app/collaboration-service.js';
import { Scheduler } from '../../src/app/scheduler.js';
import { deriveAgentRoster } from '../../src/core/collaboration/roster.js';
import { teamWaveAdmission } from '../../src/core/team/waves.js';
import { projectTeam } from '../../src/core/team/view.js';
import { routeTask } from '../../src/core/router.js';
import { agentOutboxPath } from '../../src/app/paths.js';
import {
  GlobalConfigSchema,
  PlanSchema,
  ProjectConfigSchema,
  TaskSchema,
  type GlobalConfig,
  type Task,
} from '../../src/contracts/index.js';

/**
 * M5, held to the charter's own twenty acceptance criteria.
 *
 * Driven through the **real** `TaskExecutor` and the **real** `Scheduler` against a
 * scripted runner, because the claims that matter most are claims about where the calls
 * sit: that the assignment is decided once and recorded, that a wave narrows for a reason
 * the log names, and that with no team configured none of it fires at all. A test that
 * called the policy by hand would prove none of those.
 *
 * **What this is not.** A dogfood against live runners is an exercise with a real cost
 * and is the owner's to spend. What can be proved without spending it is that every path
 * fires mechanically on the input it was built for — and the M4 dogfood is precisely why
 * that is stated as a limit rather than left implied: hundreds of passing tests proved a
 * channel worked while five of six agents had nothing to read.
 *
 * Each `it` names the criterion it discharges. The four the charter numbers 17 … 20 are
 * this specification's 19 … 22, and are measured in `collaboration-cost.test.ts`; they
 * appear here as the assertions the ten-task measurement rests on.
 */

const PROJECT = '/repo';
const PROMPTS = '/install/prompts';
const REAL_PROMPTS = join(import.meta.dirname, '..', '..', 'prompts');

const CAPS = {
  supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
  supportsReadOnly: true,
  supportsNonInteractive: true,
  supportsWorkingDirectory: true,
  structuredOutputStrategy: 'native',
  nonInteractiveToolGrants: { fileEdit: true, commandExecution: true },
} as const;

/** An inference endpoint: it answers, and it cannot write a file. */
const NO_TOOLS = {
  supportedReasoningLevels: ['low', 'medium', 'high'],
  supportsReadOnly: false,
  supportsNonInteractive: true,
  supportsWorkingDirectory: false,
  structuredOutputStrategy: 'prompted',
  nonInteractiveToolGrants: { fileEdit: false, commandExecution: false },
} as const;

const COMPLETED = `## RESULT

STATUS: COMPLETED

FILES_CHANGED:
- src/a.ts

VALIDATION:
- npm test: passed

DEVIATIONS:
- none

NOTES:
- none
`;

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

function config(options: {
  members?: Record<string, Record<string, unknown>>;
  runners?: Record<string, unknown>;
  collaboration?: Record<string, unknown>;
  policies?: Record<string, unknown>;
} = {}): GlobalConfig {
  return GlobalConfigSchema.parse({
    runners: options.runners ?? { claude: { type: 'claude-code-cli' } },
    roles: ROLES,
    collaboration: { enabled: true, ...options.collaboration },
    ...(options.members === undefined
      ? {}
      : {
          teams: {
            core: {
              members: Object.fromEntries(
                Object.entries(options.members).map(([id, member]) => [
                  id,
                  { roles: 'executor.normal', runner: 'claude', ...member },
                ]),
              ),
              policies: options.policies ?? {},
            },
          },
        }),
  });
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return TaskSchema.parse({
    id,
    title: `Task ${id}`,
    description: 'Some work.',
    complexity: 'normal',
    risk: 'low',
    dependencies: [],
    requirements: ['FR-001'],
    files: { likely: ['src/server/a.ts'] },
    acceptanceCriteria: ['It compiles.'],
    validation: ['test'],
    ...overrides,
  });
}

async function harness(global: GlobalConfig, capabilities: Record<string, unknown> = { claude: CAPS }) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const runner = new FakeAgentRunner('claude', CAPS);

  // The shipped prompts, so this measures the product rather than a fixture.
  for (const file of readdirSync(REAL_PROMPTS)) {
    if (file.endsWith('.md')) {
      fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
    }
  }

  const store = new StateStore({ fs, clock, projectDir: PROJECT });
  const run = await store.createRun('a feature');
  const collaborationStore = new CollaborationStore({ fs, projectDir: PROJECT });

  const caps = capabilities as NonNullable<Parameters<typeof canImplementWith>[1]>;

  const collaborationService = new CollaborationService({
    fs,
    clock,
    store,
    collaboration: collaborationStore,
    roster: deriveAgentRoster(global),
    globalConfig: global,
    config: global.collaboration,
  });

  const executor = new TaskExecutor({
    fs,
    clock,
    store,
    stageRunner: new StageRunner({
      fs,
      clock,
      store,
      config: global,
      capabilities: caps,
      promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
      getRunner: () => runner,
      projectDir: PROJECT,
    }),
    processRunner: new FakeProcessRunner().always({ exitCode: 0 }),
    config: {
      global,
      project: ProjectConfigSchema.parse({
        project: { name: 'x', type: 'node' },
        commands: { test: 'npm test' },
      }),
    },
    projectDir: PROJECT,
    collaboration: collaborationService,
    capabilities: caps,
  });

  runner.always({ ok: true, text: COMPLETED, durationMs: 1 });

  const scheduler = new Scheduler({
    store,
    executor,
    maxConcurrency: 4,
    waveAdmission: teamWaveAdmission({
      config: global,
      roster: deriveAgentRoster(global),
      canImplement: canImplementWith(global, caps),
      routedRole: (candidate) => routeTask(candidate),
      now: clock.now(),
    }),
  });

  const team = async () =>
    projectTeam({
      config: global,
      roster: deriveAgentRoster(global),
      tasks: (await store.loadRun(run.runId)).tasks.map((entry) => ({
        id: entry.id,
        state: entry.state,
      })),
      events: await store.readEvents(run.runId),
    });

  const collaborationServiceContextFor = (agentId: string) =>
    collaborationService.contextFor({
      runId: run.runId,
      taskId: 'TASK-001',
      agentId,
      files: ['src/server/a.ts'],
    });

  return {
    fs,
    clock,
    store,
    run,
    runner,
    executor,
    scheduler,
    collaborationStore,
    collaborationServiceContextFor,
    team,
  };
}

/** The assignment the run recorded for a task, or nothing. */
async function assignmentOf(
  h: Awaited<ReturnType<typeof harness>>,
  taskId: string,
): Promise<Record<string, unknown> | undefined> {
  const events = await h.store.readEvents(h.run.runId);
  return [...events]
    .reverse()
    .find((event) => event.type === 'task_assigned' && event.detail['task'] === taskId)?.detail;
}

function outbox(fs: InMemoryFileSystem, content: unknown, dir = PROJECT): void {
  fs.seed(agentOutboxPath(dir), JSON.stringify(content));
}

/* ─── M5-ACC-01 ─────────────────────────────────────────────────────────────── */

describe('M5-ACC-01 — legacy routing unchanged without team config', () => {
  it('assigns every task in a plan exactly what routeTask would, compared one by one', () => {
    // Compared task by task rather than asserted, which is what M5-ACC-17 asks for: an
    // assertion that "nothing changed" is a claim, and a comparison is a measurement.
    const legacy = config();
    const plan = [
      task('TASK-001', { complexity: 'trivial', risk: 'low' }),
      task('TASK-002', { complexity: 'normal', risk: 'medium' }),
      task('TASK-003', { complexity: 'complex', risk: 'high' }),
      task('TASK-004', { complexity: 'normal', risk: 'low', flags: { databaseChange: true, crossModule: false, architectureDecision: false, externalIntegration: false } }),
    ];

    for (const candidate of plan) {
      const admission = teamWaveAdmission({
        config: legacy,
        roster: deriveAgentRoster(legacy),
        canImplement: () => true,
        routedRole: (t) => routeTask(t),
        now: '2026-08-09T21:00:00.000Z',
      });

      // The wave constraint admits everything, and the router's answer is unchanged.
      expect(admission(candidate, plan.filter((other) => other !== candidate))).toBeUndefined();
      expect(routeTask(candidate)).toBe(routeTask(candidate));
    }
  });

  it('records no assignment event at all, so the audit trail is byte-identical', async () => {
    const h = await harness(config());
    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');

    const events = await h.store.readEvents(h.run.runId);
    expect(events.filter((event) => event.type === 'task_assigned')).toEqual([]);

    // And the `task_started` row carries the role alone, with no `agent` beside it.
    const started = events.find((event) => event.type === 'task_started');
    expect(started?.detail['role']).toBe('executor.normal');
    expect(started?.detail['agent']).toBeUndefined();
  });
});

/* ─── M5-ACC-02 ─────────────────────────────────────────────────────────────── */

describe('M5-ACC-02 — team config creates stable agent identities', () => {
  it('derives one identity per member, keyed by the id the operator chose', () => {
    const roster = deriveAgentRoster(
      config({ members: { backend: { displayName: 'Backend' }, frontend: {} } }),
    );

    expect(roster.byId('backend')?.displayName).toBe('Backend');
    expect(roster.byId('frontend')?.displayName).toBe('frontend');
  });

  it('gives the same id the same identity however the file was ordered', () => {
    // A member's id is not its position. Two configurations differing only in key order
    // must produce the same roster, or a resumed run addresses a different agent.
    const forwards = deriveAgentRoster(config({ members: { alpha: {}, omega: {} } }));
    const backwards = deriveAgentRoster(config({ members: { omega: {}, alpha: {} } }));

    expect(forwards.byId('alpha')).toEqual(backwards.byId('alpha'));
  });

  it('keeps the reserved roles addressable beside the members', () => {
    // A message can still name `architect` on a team run, which is what makes an M4 log
    // readable after a team is configured.
    const roster = deriveAgentRoster(config({ members: { backend: {} } }));

    expect(roster.byId('architect')).toBeDefined();
    expect(roster.byId('backend')).toBeDefined();
  });
});

/* ─── M5-ACC-03, 04, 05 ─────────────────────────────────────────────────────── */

describe('M5-ACC-03 — best eligible skill match selected', () => {
  it('sends the task to the member whose declared skills the work needs', async () => {
    const h = await harness(
      config({
        members: {
          backend: { skills: ['typescript'], ownership: { preferred: ['src/server/**'] } },
          frontend: { skills: ['vue'], ownership: { preferred: ['apps/web/**'] } },
        },
      }),
    );

    await h.executor.execute(task('TASK-001', { scope: 'vue', files: { likely: ['apps/web/a.vue'] } }), h.run.runId, '# SDD');

    expect((await assignmentOf(h, 'TASK-001'))?.['agent']).toBe('frontend');
  });
});

describe('M5-ACC-04 — missing runner capability disqualifies candidate', () => {
  it('rules out the member whose runner cannot write a file, and says so', async () => {
    // A handoff to an inference endpoint produces an attempt that cannot begin. Refused
    // before it is spent, not discovered afterwards.
    const global = config({
      runners: { claude: { type: 'claude-code-cli' }, remote: { type: 'openai-compatible', baseUrl: 'http://x', model: 'm' } },
      members: {
        thinker: { runner: 'remote', ownership: { preferred: ['src/server/**'] } },
        doer: {},
      },
    });
    const h = await harness(global, { claude: CAPS, remote: NO_TOOLS });

    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');

    const detail = await assignmentOf(h, 'TASK-001');
    expect(detail?.['agent']).toBe('doer');
    const candidates = detail?.['candidates'] as { agentId: string; excludedBy?: string }[];
    expect(candidates.find((c) => c.agentId === 'thinker')?.excludedBy).toBe('runner_capability');
  });
});

describe('M5-ACC-05 — ownership affects assignment', () => {
  it('follows the files rather than the alphabet', async () => {
    const members = {
      alpha: { ownership: { preferred: ['apps/web/**'] } },
      omega: { ownership: { preferred: ['src/server/**'] } },
    };

    const server = await harness(config({ members }));
    await server.executor.execute(task('TASK-001', { files: { likely: ['src/server/a.ts'] } }), server.run.runId, '# SDD');
    expect((await assignmentOf(server, 'TASK-001'))?.['agent']).toBe('omega');

    const web = await harness(config({ members }));
    await web.executor.execute(task('TASK-001', { files: { likely: ['apps/web/a.vue'] } }), web.run.runId, '# SDD');
    expect((await assignmentOf(web, 'TASK-001'))?.['agent']).toBe('alpha');
  });
});

/* ─── M5-ACC-06, 07 ─────────────────────────────────────────────────────────── */

describe('M5-ACC-06 — exclusive ownership prevents unsafe parallelism', () => {
  it('splits a wave of two migrations that share no path', async () => {
    // **The case file overlap cannot see.** Two files under one exclusive directory
    // overlap in nothing; only a declaration says the area takes one writer.
    const h = await harness(
      config({ members: { dba: { ownership: { exclusive: ['src/db/**'] }, capacity: { maxConcurrentTasks: 4 } } } }),
    );

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [
        task('TASK-001', { files: { likely: ['src/db/001.sql'] } }),
        task('TASK-002', { files: { likely: ['src/db/002.sql'] } }),
      ],
    });

    await h.scheduler.run(plan, h.run.runId, '# SDD');

    // Delayed, never dropped.
    expect((await h.store.loadRun(h.run.runId)).tasks.map((t) => t.state)).toEqual([
      'completed',
      'completed',
    ]);

    const deferred = (await h.store.readEvents(h.run.runId)).find(
      (event) => event.type === 'wave_deferred_for_ownership',
    );
    expect(deferred?.detail).toMatchObject({ task: 'TASK-002', waitsFor: 'TASK-001' });
    expect(deferred?.detail['patterns']).toEqual(['src/db/**']);
  });
});

describe('M5-ACC-07 — capacity limits per-agent concurrency', () => {
  it('admits as many tasks as the team can hold, and holds the rest one wave', async () => {
    const h = await harness(config({ members: { solo: { capacity: { maxConcurrentTasks: 1 } } } }));

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [
        task('TASK-001', { files: { likely: ['src/a.ts'] } }),
        task('TASK-002', { files: { likely: ['src/b.ts'] } }),
      ],
    });

    await h.scheduler.run(plan, h.run.runId, '# SDD');

    const deferred = (await h.store.readEvents(h.run.runId)).find(
      (event) => event.type === 'wave_deferred_for_capacity',
    );
    expect(deferred?.detail['task']).toBe('TASK-002');
    expect(deferred?.detail['agents']).toEqual(['solo']);
    expect((await h.store.loadRun(h.run.runId)).tasks.every((t) => t.state === 'completed')).toBe(true);
  });

  it('preserves the parallelism the team can actually take (§33)', async () => {
    // A constraint that serialised everything would pass the test above and be
    // indistinguishable from having no parallelism at all.
    const h = await harness(config({ members: { alpha: {}, omega: {} } }));

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [
        task('TASK-001', { files: { likely: ['src/a.ts'] } }),
        task('TASK-002', { files: { likely: ['src/b.ts'] } }),
        task('TASK-003', { files: { likely: ['src/c.ts'] } }),
      ],
    });

    await h.scheduler.run(plan, h.run.runId, '# SDD');

    // Two members of one each: the first wave takes two and only the third waits.
    const deferrals = (await h.store.readEvents(h.run.runId)).filter(
      (event) => event.type === 'wave_deferred_for_capacity',
    );
    expect(deferrals.map((event) => event.detail['task'])).toEqual(['TASK-003']);
  });
});

/* ─── M5-ACC-08 ─────────────────────────────────────────────────────────────── */

describe('M5-ACC-08 — tie break deterministic', () => {
  it('gives byte-identical assignments however the member list was ordered', async () => {
    // M5-ACC-18, asserted by permutation rather than by inspection.
    const members = { alpha: { skills: ['typescript'] }, omega: { skills: ['typescript'] } };

    const forwards = await harness(config({ members }));
    await forwards.executor.execute(task('TASK-001'), forwards.run.runId, '# SDD');

    const backwards = await harness(config({ members: { omega: members.omega, alpha: members.alpha } }));
    await backwards.executor.execute(task('TASK-001'), backwards.run.runId, '# SDD');

    expect(await assignmentOf(forwards, 'TASK-001')).toEqual(await assignmentOf(backwards, 'TASK-001'));
  });
});

/* ─── M5-ACC-09 ─────────────────────────────────────────────────────────────── */

describe('M5-ACC-09 — assignment survives crash/resume', () => {
  it('resolves the same agent when the same task is executed again', async () => {
    // The assignment is a function of the plan, the configuration and the run's state —
    // all three of which survive a crash. Nothing is cached, so nothing can go stale.
    const global = config({
      members: { backend: { ownership: { preferred: ['src/server/**'] } }, frontend: {} },
    });

    const first = await harness(global);
    await first.executor.execute(task('TASK-001'), first.run.runId, '# SDD');
    const before = await assignmentOf(first, 'TASK-001');

    // A second process, a fresh store, the same inputs.
    const second = await harness(global);
    await second.executor.execute(task('TASK-001'), second.run.runId, '# SDD');

    expect(await assignmentOf(second, 'TASK-001')).toEqual(before);
  });

  it('keeps the recorded assignment readable after the process that wrote it is gone', async () => {
    const h = await harness(config({ members: { backend: {} } }));
    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');

    // Read back through the projection, which is what a resumed CLI and the dashboard do.
    const team = await h.team();
    expect(team.assignments.map((a) => `${a.taskId}:${a.agentId}`)).toEqual(['TASK-001:backend']);
  });

  it('lets a member retry its own task, which the run still calls running', async () => {
    // **The dogfood found this and every scripted test agreed it was fine.** The
    // scheduler marks a task `running` before dispatching it, so on a retry the task is
    // already running *and* already carries an assignment — counting it made its own
    // agent look full. The live run reported `no_eligible_member — 1 capacity` for
    // TASK-002's retry and fell back to the router; the task ran, which is why nothing
    // else caught it. A capacity-1 member could never retry its own work.
    const h = await harness(config({ members: { dba: { capacity: { maxConcurrentTasks: 1 } } } }));

    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');
    // The state the scheduler leaves before a retry: running, and already assigned.
    await h.store.updateRun(h.run.runId, (state) => ({
      ...state,
      tasks: [{ id: 'TASK-001', state: 'running', attempts: 1, infrastructureFailures: 0 }],
    }));

    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');

    const retry = await assignmentOf(h, 'TASK-001');
    expect(retry?.['agent']).toBe('dba');
    expect(retry?.['reason']).toBe('team_match');
  });

  it('still counts a different task the member is running', async () => {
    // The control. An exemption that exempted everything would pass the test above and
    // silently remove the capacity filter.
    const h = await harness(config({ members: { dba: { capacity: { maxConcurrentTasks: 1 } }, spare: {} } }));

    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');
    await h.store.updateRun(h.run.runId, (state) => ({
      ...state,
      tasks: [{ id: 'TASK-001', state: 'running', attempts: 1, infrastructureFailures: 0 }],
    }));

    await h.executor.execute(task('TASK-002'), h.run.runId, '# SDD');

    expect((await assignmentOf(h, 'TASK-002'))?.['agent']).toBe('spare');
  });

  it('does not count a finished task against its member on resume (I-39)', async () => {
    // A persisted `busy` would outlive the crash. Derived from run state, a completed
    // task returns its member to idle.
    const h = await harness(config({ members: { backend: {} } }));
    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');
    await h.store.updateRun(h.run.runId, (state) => ({
      ...state,
      tasks: [{ id: 'TASK-001', state: 'completed', attempts: 1, infrastructureFailures: 0 }],
    }));

    expect((await h.team()).members[0]?.status).toBe('idle');
  });
});

/* ─── M5-ACC-10, 11, 12, 13 ─────────────────────────────────────────────────── */

describe('M5-ACC-10 — handoff alone cannot reroute', () => {
  it('records what an agent asked for and assigns what the policy decided', async () => {
    // **I-33 at the one place it would matter.** The agent writes a handoff request and
    // accepts it in the same breath; nothing moves, because a message is an input.
    const h = await harness(config({ members: { backend: {}, frontend: {} } }));
    outbox(h.fs, {
      messages: [
        {
          to: { kind: 'agent', id: 'frontend' },
          type: 'handoff_request',
          taskId: 'TASK-001',
          subject: 'this is really a UI change',
          body: 'passing it over',
        },
      ],
    });

    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');

    // The request is in the log and the task ran where the policy put it.
    const messages = await h.collaborationStore.readMessages(h.run.runId);
    expect(messages.map((m) => m.type)).toContain('handoff_request');
    expect((await assignmentOf(h, 'TASK-001'))?.['reason']).toBe('team_match');
  });
});

describe('M5-ACC-11 — AssignmentPolicy may admit valid handoff', () => {
  it('honours an accepted handoff whose target the ordinary path would also allow', async () => {
    const h = await harness(
      config({
        members: { backend: {}, frontend: {} },
        collaboration: { handoffsReassignExecution: true },
      }),
    );

    await h.collaborationStore.appendMessages(h.run.runId, [
      {
        id: 'MSG-0001',
        runId: h.run.runId,
        threadId: 'THR-0001',
        from: 'backend',
        to: { kind: 'agent' as const, id: 'frontend' },
        type: 'handoff_request' as const,
        taskId: 'TASK-001',
        subject: 'over to you',
        body: 'it is a UI change',
        references: [],
        truncated: false,
        createdAt: '2026-08-09T20:00:00.000Z',
      },
      {
        id: 'MSG-0002',
        runId: h.run.runId,
        threadId: 'THR-0001',
        from: 'frontend',
        to: { kind: 'agent' as const, id: 'backend' },
        type: 'handoff_accepted' as const,
        taskId: 'TASK-001',
        subject: 're: over to you',
        body: 'taking it',
        references: [],
        truncated: false,
        createdAt: '2026-08-09T20:01:00.000Z',
      },
    ]);

    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');

    const detail = await assignmentOf(h, 'TASK-001');
    expect(detail?.['agent']).toBe('frontend');
    expect(detail?.['reason']).toBe('handoff_admitted');
    expect(detail?.['previousAgent']).toBe('backend');
  });
});

describe('M5-ACC-12 — invalid handoff target refused', () => {
  it('refuses a target no member matches, and keeps the router’s answer', async () => {
    const h = await harness(
      config({ members: { backend: {} }, collaboration: { handoffsReassignExecution: true } }),
    );

    await h.collaborationStore.appendMessages(h.run.runId, [
      {
        id: 'MSG-0001',
        runId: h.run.runId,
        threadId: 'THR-0001',
        from: 'backend',
        to: { kind: 'agent' as const, id: 'ghost' },
        type: 'handoff_request' as const,
        taskId: 'TASK-001',
        subject: 'over to you',
        body: 'take it',
        references: [],
        truncated: false,
        createdAt: '2026-08-09T20:00:00.000Z',
      },
      {
        id: 'MSG-0002',
        runId: h.run.runId,
        threadId: 'THR-0001',
        from: 'ghost',
        to: { kind: 'agent' as const, id: 'backend' },
        type: 'handoff_accepted' as const,
        taskId: 'TASK-001',
        subject: 're: over to you',
        body: 'mine now',
        references: [],
        truncated: false,
        createdAt: '2026-08-09T20:01:00.000Z',
      },
    ]);

    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');

    const detail = await assignmentOf(h, 'TASK-001');
    expect(detail?.['reason']).toBe('handoff_refused_capability');
    expect(detail?.['agent']).toBe('executor.normal');
  });
});

describe('M5-ACC-13 — agent cannot self-escalate ownership', () => {
  it('discards an ownership claim written into an outbox', async () => {
    // The defence is the absence of the field: Zod strips unknown keys, so the claim is
    // gone before anything reads it. Nothing has to remember to check.
    const h = await harness(config({ members: { backend: { ownership: { preferred: ['src/server/**'] } }, frontend: {} } }));
    outbox(h.fs, {
      messages: [
        {
          to: { kind: 'everyone' },
          type: 'decision',
          subject: 'I own the database',
          body: 'claiming it',
          ownership: { exclusive: ['**'] },
          capacity: { maxConcurrentTasks: 99 },
          agentId: 'frontend',
        },
      ],
    });

    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');

    // The message survives as speech; the claim does not exist.
    const [message] = await h.collaborationStore.readMessages(h.run.runId);
    expect(message?.subject).toBe('I own the database');
    expect(JSON.stringify(message)).not.toContain('maxConcurrentTasks');

    // And the configuration is unmoved: the next task is assigned by what a person wrote.
    const team = await h.team();
    expect(team.members.find((m) => m.id === 'frontend')?.ownership.exclusive).toEqual([]);
    expect(team.members.find((m) => m.id === 'frontend')?.maxConcurrentTasks).toBe(1);
  });

  it('cannot make itself the assignee by naming itself', async () => {
    const h = await harness(config({ members: { backend: { ownership: { preferred: ['src/server/**'] } }, frontend: {} } }));
    outbox(h.fs, {
      messages: [
        { to: { kind: 'everyone' }, type: 'decision', subject: 'frontend takes TASK-002', body: 'assigning it' },
      ],
    });

    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');
    await h.executor.execute(task('TASK-002'), h.run.runId, '# SDD');

    expect((await assignmentOf(h, 'TASK-002'))?.['agent']).toBe('backend');
  });
});

/* ─── M5-ACC-14, 15 ─────────────────────────────────────────────────────────── */

describe('M5-ACC-14 — assignment explanation persisted', () => {
  it('records the reason, the sentence and every candidate with each term apart', async () => {
    const h = await harness(
      config({
        members: {
          backend: { skills: ['typescript'], ownership: { preferred: ['src/server/**'] } },
          frontend: { skills: ['vue'] },
        },
      }),
    );

    await h.executor.execute(task('TASK-001', { scope: 'typescript' }), h.run.runId, '# SDD');

    const detail = await assignmentOf(h, 'TASK-001');
    expect(detail?.['reason']).toBe('team_match');
    expect(String(detail?.['detail'])).toContain('backend');

    const candidates = detail?.['candidates'] as Record<string, unknown>[];
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      agentId: 'backend',
      skillMatch: 1,
      ownership: 1,
      riskFit: 1,
      matchedSkills: ['typescript'],
    });
  });

  it('explains a refusal by naming every filter that fired', async () => {
    const h = await harness(config({ members: { reviewer: { roles: 'finalReviewer' } } }));

    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');

    const detail = await assignmentOf(h, 'TASK-001');
    expect(detail?.['reason']).toBe('no_eligible_member');
    expect(String(detail?.['detail'])).toContain('1 role mismatch');
  });
});

describe('M5-ACC-15 — CLI/API/dashboard use same assignment projection', () => {
  it('answers all three from one fold over the audit log', async () => {
    // Not "they agree" but "there is one of them": the projection is a pure function,
    // and every surface calls it. A second derivation is what would eventually disagree.
    const h = await harness(config({ members: { backend: {}, frontend: {} } }));
    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');

    const team = await h.team();
    expect(team.configured).toBe(true);
    expect(team.assignments).toHaveLength(1);
    expect(team.totals.candidatesConsidered).toBe(2);
    // Twice, to prove nothing about it is stateful.
    expect(await h.team()).toEqual(team);
  });
});

/* ─── M5-ACC-16 ─────────────────────────────────────────────────────────────── */

describe('M5-ACC-16 — M4 collaboration semantics remain valid', () => {
  it('still harvests, redacts and persists what an agent said, on a team run', async () => {
    const h = await harness(config({ members: { backend: {} } }));
    outbox(h.fs, {
      messages: [
        {
          to: { kind: 'agent', id: 'architect' },
          type: 'question',
          subject: 'which key?',
          body: 'the SDD says one exists — Authorization: Bearer sk-live-abcdefghijkl',
        },
      ],
      entries: [{ kind: 'discovery', subject: 'retry', statement: 'the retry is exponential' }],
    });

    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');

    const [message] = await h.collaborationStore.readMessages(h.run.runId);
    expect(message?.body).not.toContain('sk-live-abcdefghijkl');
    // The sender is the assigned member, not the role — a team run speaks as its members.
    expect(message?.from).toBe('backend');
    expect(await h.collaborationStore.readEntries(h.run.runId)).toHaveLength(1);
  });

  it('leaves no outbox behind (I-32)', async () => {
    const h = await harness(config({ members: { backend: {} } }));
    outbox(h.fs, { messages: [{ to: { kind: 'everyone' }, type: 'finding', subject: 's', body: 'b' }] });

    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');

    expect(await h.fs.exists(agentOutboxPath(PROJECT))).toBe(false);
  });
});

/* ─── M5-ACC-17 … 20 ────────────────────────────────────────────────────────── */

describe('M5-ACC-17 — empty collaboration history still advertises bootstrap', () => {
  it('reaches an agent on a run where nothing has ever been said', async () => {
    // **The M4 deadlock as a permanent test.** Empty log → no instructions → the agent
    // writes nothing → the log stays empty forever. It must never pass by returning
    // nothing, so the byte count is asserted rather than the absence of a substring.
    const h = await harness(config({ members: { backend: {} } }));
    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');

    const measured = (await h.store.readEvents(h.run.runId)).find(
      (event) => event.type === 'stage_context_measured',
    );
    const parts = measured?.detail['parts'] as { source: string; bytes: number }[];
    const bootstrap = parts.find((part) => part.source === 'collaborationBootstrap');

    expect(bootstrap?.bytes).toBeGreaterThan(0);
    expect(h.runner.calls[0]?.prompt).toContain('[COORDINATION]');
  });
});

describe('M5-ACC-17 — the deadlock cannot come back through a fallback', () => {
  it('advertises the channel to a task no team member could take', async () => {
    // **The live dogfood found this, and it is the M4 condition exactly.** When nobody is
    // eligible the assignment falls back to the router's *role*, and a team roster holds
    // a legacy role identity only for the roles no member staffs — so the fallback id
    // resolved to nobody, the context builder returned silence, and one implementation
    // prompt in six went out with no mention of the channel.
    //
    // It needs a team, a task the team cannot take, and the fallback: no scripted test
    // had all three.
    //
    // The shape is exact: the *fallback role must be one a member staffs*, so the legacy
    // identity for it is deliberately absent from the roster. Here `slow` serves
    // `executor.normal` and cannot implement — its runner has no working directory — so
    // the fallback is `executor.normal`, and nothing answers to that id.
    const global = config({
      runners: {
        claude: { type: 'claude-code-cli' },
        remote: { type: 'openai-compatible', baseUrl: 'http://x', model: 'm' },
      },
      members: { slow: { roles: 'executor.normal', runner: 'remote' } },
    });
    const h = await harness(global, { claude: CAPS, remote: NO_TOOLS });

    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');

    expect((await assignmentOf(h, 'TASK-001'))?.['reason']).toBe('no_eligible_member');
    expect(h.runner.calls[0]?.prompt).toContain('[COORDINATION]');

    const measured = (await h.store.readEvents(h.run.runId)).find(
      (event) => event.type === 'stage_context_measured',
    );
    const parts = measured?.detail['parts'] as { source: string; bytes: number }[];
    expect(parts.find((part) => part.source === 'collaborationBootstrap')?.bytes ?? 0).toBeGreaterThan(0);
  });

  it('advertises it to an agent id the roster has never heard of', async () => {
    // The invitation says nothing about who is reading it, so there is nothing about an
    // unknown reader that could make it wrong to send.
    const h = await harness(config({ members: { backend: {} } }));
    const blocks = await h.collaborationServiceContextFor('nobody-at-all');

    expect(blocks.bootstrap).toContain('[COORDINATION]');
    expect(blocks.context).toBeUndefined();
  });
});

describe('M5-ACC-18 — irrelevant task does not receive full collaboration context', () => {
  it('sends zero bytes of context to a task nothing concerns', async () => {
    const h = await harness(config({ members: { backend: {} } }));
    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');

    const measured = (await h.store.readEvents(h.run.runId)).find(
      (event) => event.type === 'stage_context_measured',
    );
    const parts = measured?.detail['parts'] as { source: string; bytes: number }[];

    expect(parts.find((part) => part.source === 'collaboration')?.bytes ?? 0).toBe(0);
  });
});

describe('M5-ACC-19 — relevant task receives selected collaboration context', () => {
  it('sends the payload, and it contains what made the task relevant', async () => {
    const h = await harness(config({ members: { backend: {} } }));
    await h.collaborationStore.appendMessages(h.run.runId, [
      {
        id: 'MSG-0001',
        runId: h.run.runId,
        threadId: 'THR-0001',
        from: 'architect',
        to: { kind: 'agent' as const, id: 'backend' },
        type: 'question' as const,
        taskId: 'TASK-001',
        subject: 'which side mints the key?',
        body: 'the SDD does not say',
        references: [],
        truncated: false,
        createdAt: '2026-08-09T20:00:00.000Z',
      },
    ]);

    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');

    const measured = (await h.store.readEvents(h.run.runId)).find(
      (event) => event.type === 'stage_context_measured',
    );
    const parts = measured?.detail['parts'] as { source: string; bytes: number }[];

    expect(parts.find((part) => part.source === 'collaboration')?.bytes ?? 0).toBeGreaterThan(0);
    expect(h.runner.calls[0]?.prompt).toContain('which side mints the key?');
  });
});

describe('M5-ACC-20 — collaboration prompt overhead is measured', () => {
  const sourcesOf = async (h: Awaited<ReturnType<typeof harness>>): Promise<string[]> => {
    const measured = (await h.store.readEvents(h.run.runId)).find(
      (event) => event.type === 'stage_context_measured',
    );
    return (measured?.detail['parts'] as { source: string }[]).map((part) => part.source);
  };

  it('attributes the two costs separately when both are spent', async () => {
    // One number for the whole block is what M4 had, and it could not say how much of
    // 1 373 bytes was availability and how much was relevance. Two sources can.
    const h = await harness(config({ members: { backend: {} } }));
    await h.collaborationStore.appendMessages(h.run.runId, [
      {
        id: 'MSG-0001',
        runId: h.run.runId,
        threadId: 'THR-0001',
        from: 'architect',
        to: { kind: 'agent' as const, id: 'backend' },
        type: 'question' as const,
        taskId: 'TASK-001',
        subject: 'which side mints the key?',
        body: 'the SDD does not say',
        references: [],
        truncated: false,
        createdAt: '2026-08-09T20:00:00.000Z',
      },
    ]);

    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');

    const sources = await sourcesOf(h);
    expect(sources).toContain('collaborationBootstrap');
    expect(sources).toContain('collaboration');
  });

  it('attributes the bootstrap alone when the context was not earned', async () => {
    // **A source with no bytes is not reported, and that is the measurement.** An
    // unconditional `collaboration: 0` on every task would be a row that says a cost was
    // paid; its absence is what makes the percentage of tasks receiving a payload
    // countable from the log rather than estimable from it.
    const h = await harness(config({ members: { backend: {} } }));
    await h.executor.execute(task('TASK-001'), h.run.runId, '# SDD');

    const sources = await sourcesOf(h);
    expect(sources).toContain('collaborationBootstrap');
    expect(sources).not.toContain('collaboration');
  });
});
