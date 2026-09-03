import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RunEventSchema,
  RunStateSchema,
  PlanSchema,
  type RunEvent,
  type RunState,
  type TaskState,
} from '../../src/contracts/index.js';
import {
  RUNTIME_STATUSES,
  isResumable,
  projectProgress,
  projectRun,
} from '../../src/core/run-projection.js';
import { isCompleteEscalation } from '../../src/core/recovery-policy.js';

/**
 * The projection, against the run whose observability defects it exists to fix.
 *
 * Every one of those defects was a missing projection rather than a missing state, so the
 * decisive tests here are the ones that read the *real* AF-2026-002 state and event log and
 * assert the projection now answers what the CLI and the dashboard got wrong: `Resume`
 * offered with nothing runnable, `plan_rejected` shown while a revision ran, and one
 * progress number that hit 100% with verification pending and then fell.
 */

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'legacy-artifacts');

function evidenceState(): RunState {
  return RunStateSchema.parse(JSON.parse(readFileSync(join(FIXTURES, 'state.json'), 'utf8')));
}

function evidenceEvents(): RunEvent[] {
  return readFileSync(join(FIXTURES, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => RunEventSchema.parse(JSON.parse(line)));
}

function evidenceNodes(): { id: string; dependencies: string[] }[] {
  const plan = PlanSchema.parse(JSON.parse(readFileSync(join(FIXTURES, 'plan.json'), 'utf8')));
  return plan.tasks.map((task) => ({ id: task.id, dependencies: [...task.dependencies] }));
}

const state = (overrides: Partial<RunState> = {}): RunState =>
  RunStateSchema.parse({
    runId: 'AF-2026-003',
    feature: 'a feature',
    stage: 'implementation',
    status: 'running',
    createdAt: '2026-08-17T13:00:00.000Z',
    updatedAt: '2026-08-17T13:00:00.000Z',
    ...overrides,
  });

const task = (id: string, taskState: TaskState, extra: Record<string, unknown> = {}) => ({
  id,
  state: taskState,
  attempts: 1,
  // AD-37's second counter. Supplied by the helper rather than by each case: none of
  // these tests is about the counter, and the projection reads neither.
  infrastructureFailures: 0,
  ...extra,
});

const event = (type: string, at = '2026-08-17T14:00:00.000Z'): RunEvent =>
  RunEventSchema.parse({ at, type, detail: {} });

describe('C-19 — Resume is offered only when work exists', () => {
  it('is not resumable when the only incomplete task is held at review', () => {
    // The evidence run took and released the execution lock three times with nothing
    // runnable, because nothing distinguished "held at a gate" from "resumable". The DAG
    // admits only `queued` and `ready`, so `review_required` yields no ready task.
    const input = {
      state: state({ tasks: [task('TASK-001', 'completed'), task('TASK-002', 'review_required')] }),
      nodes: [
        { id: 'TASK-001', dependencies: [] },
        { id: 'TASK-002', dependencies: ['TASK-001'] },
      ],
    };

    expect(isResumable(input)).toBe(false);

    const projection = projectRun(input);
    expect(projection.resumable).toBe(false);
    expect(projection.status).toBe('blocked_on_human');
    expect(projection.gate?.gate).toBe('task_review');
    expect(projection.gate?.tasks).toEqual(['TASK-002']);
  });

  it('names the one action that clears the gate', () => {
    const projection = projectRun({
      state: state({ tasks: [task('TASK-001', 'review_required')] }),
      nodes: [{ id: 'TASK-001', dependencies: [] }],
    });

    expect(projection.gate?.action).toMatch(/TASK-001/);
    expect(projection.gate?.action).not.toMatch(/inspect logs/i);
  });

  it('is resumable when a queued task has all its dependencies completed', () => {
    expect(
      isResumable({
        state: state({ tasks: [task('TASK-001', 'completed'), task('TASK-002', 'queued')] }),
        nodes: [
          { id: 'TASK-001', dependencies: [] },
          { id: 'TASK-002', dependencies: ['TASK-001'] },
        ],
      }),
    ).toBe(true);
  });

  it.each(['running', 'interrupted'] as const)(
    'is resumable when a %s task is what a killed coordinator left',
    (crashed) => {
      // The regression this exists for. C-19 answers "is there executable work" by asking
      // the DAG, and the DAG admits only `queued` and `ready` — so a wave graph with three
      // tasks integrated and the fourth in flight looked exactly like a run with nothing
      // to do. `agent-flow run`, the documented way to resume a crashed run, then refused
      // before taking the execution lock, which is *before* the recovery that reconciles
      // those tasks. Every attempt after a crash answered the same.
      expect(
        isResumable({
          state: state({
            status: 'approved',
            tasks: [
              task('TASK-001', 'completed'),
              task('TASK-002', 'completed'),
              task('TASK-003', crashed),
            ],
          }),
          nodes: [
            { id: 'TASK-001', dependencies: [] },
            { id: 'TASK-002', dependencies: [] },
            { id: 'TASK-003', dependencies: ['TASK-001', 'TASK-002'] },
          ],
        }),
      ).toBe(true);
    },
  );

  it('offers Resume rather than a gate for a crashed run', () => {
    // The projection the CLI headline and the dashboard both read. A crashed run that
    // reports `blocked_on_human` sends a person looking for a gate that does not exist.
    const projection = projectRun({
      state: state({ status: 'approved', tasks: [task('TASK-001', 'running')] }),
      nodes: [{ id: 'TASK-001', dependencies: [] }],
    });

    expect(projection.resumable).toBe(true);
    expect(projection.gate).toBeUndefined();
    expect(projection.status).not.toBe('blocked_on_human');
  });

  it('still refuses a finished run, whatever its tasks say', () => {
    // The crash branch must not outrank a terminal status: a `completed` run with a stale
    // `running` entry is finished, and offering Resume would send a person to a command
    // that refuses.
    for (const status of ['completed', 'failed'] as const) {
      expect(
        isResumable({
          state: state({ status, tasks: [task('TASK-001', 'running')] }),
          nodes: [{ id: 'TASK-001', dependencies: [] }],
        }),
        status,
      ).toBe(false);
    }
  });

  it('is not resumable when a queued task is still waiting on a failed dependency', () => {
    expect(
      isResumable({
        state: state({ tasks: [task('TASK-001', 'failed'), task('TASK-002', 'queued')] }),
        nodes: [
          { id: 'TASK-001', dependencies: [] },
          { id: 'TASK-002', dependencies: ['TASK-001'] },
        ],
      }),
    ).toBe(false);
  });

  it('is resumable before a plan exists, because planning is the work', () => {
    expect(isResumable({ state: state({ stage: 'discovery', tasks: [] }) })).toBe(true);
  });

  it('is not resumable when the plan graph cannot be built', () => {
    // Not an exception either: a plan whose DAG is invalid cannot be scheduled, and
    // reporting it as resumable would send a person to a command that will refuse.
    expect(
      isResumable({
        state: state({ tasks: [task('TASK-001', 'queued')] }),
        nodes: [{ id: 'TASK-001', dependencies: ['TASK-404'] }],
      }),
    ).toBe(false);
  });

  it('is never resumable once the run is terminal or waiting for approval', () => {
    for (const status of ['completed', 'failed', 'waiting_for_approval'] as const) {
      expect(isResumable({ state: state({ status }) }), status).toBe(false);
    }
  });
});

describe('C-20 — a superseded review is not presented as current', () => {
  it('marks a review superseded once a later stage started', () => {
    // `plan_rejected` persisted while revision 2 was already running, and the headline
    // showed the rejection. The rejection was real and historical; the run was not sitting
    // on it.
    const projection = projectRun({
      state: state({ status: 'plan_rejected', stage: 'planning' }),
      events: [event('stage_started', '2026-08-17T14:30:00.000Z')],
      reviewWrittenAt: '2026-08-17T14:00:00.000Z',
    });

    expect(projection.reviewFreshness).toBe('superseded');
  });

  it('keeps a review current when nothing started after it', () => {
    expect(
      projectRun({
        state: state(),
        events: [event('stage_started', '2026-08-17T13:30:00.000Z')],
        reviewWrittenAt: '2026-08-17T14:00:00.000Z',
      }).reviewFreshness,
    ).toBe('current');
  });

  it('reports absent rather than stale when no review exists', () => {
    expect(projectRun({ state: state() }).reviewFreshness).toBe('absent');
  });

  it('does not report plan_rejected as the headline while a revision is in flight', () => {
    const revising = projectRun({
      state: state({ status: 'plan_rejected', stage: 'planning' }),
      events: [event('revision_requested', '2026-08-17T14:30:00.000Z')],
    });
    expect(revising.status).toBe('planning');

    const settled = projectRun({
      state: state({ status: 'plan_rejected', stage: 'plan-review' }),
      events: [
        event('revision_requested', '2026-08-17T14:00:00.000Z'),
        event('revision_completed', '2026-08-17T14:30:00.000Z'),
      ],
    });
    expect(settled.status).toBe('plan_rejected_revisable');
  });
});

describe('C-21 — three progress axes, and none of them falls', () => {
  it('reports workflow, implementation and corrective progress separately', () => {
    const progress = projectProgress(
      state({
        stage: 'verification',
        tasks: [
          task('TASK-001', 'completed'),
          task('TASK-002', 'completed'),
          task('FIX-001', 'queued'),
        ],
      }),
    );

    expect(progress.implementation).toEqual({ done: 2, total: 2 });
    expect(progress.corrective).toEqual({ done: 0, total: 1 });
    expect(progress.workflow.done).toBeLessThan(progress.workflow.total);
  });

  it('does not report implementation at 100% as the run being finished', () => {
    // The evidence run showed overall progress at 100% with verification pending. Three
    // axes make that impossible to say: implementation is complete and the workflow is not.
    const progress = projectProgress(
      state({ stage: 'verification', tasks: [task('TASK-001', 'completed')] }),
    );

    expect(progress.implementation.done).toBe(progress.implementation.total);
    expect(progress.workflow.done).toBeLessThan(progress.workflow.total);
  });

  it('does not let appended corrective tasks make implementation progress fall', () => {
    // The defect verbatim: progress read 100%, three corrective tasks were appended, and
    // it dropped to 67%. Implementation counts *planned* tasks, so appending cannot move it.
    const before = projectProgress(
      state({ tasks: [task('TASK-001', 'completed'), task('TASK-002', 'completed')] }),
    );
    const after = projectProgress(
      state({
        tasks: [
          task('TASK-001', 'completed'),
          task('TASK-002', 'completed'),
          task('FIX-001', 'queued'),
          task('FIX-002', 'queued'),
          task('FIX-003', 'queued'),
        ],
      }),
    );

    expect(after.implementation).toEqual(before.implementation);
    expect(after.corrective).toEqual({ done: 0, total: 3 });
  });

  it('leaves corrective progress absent when there is no corrective work', () => {
    // `undefined` rather than `0/0`: rendering 0% would suggest something is pending.
    expect(projectProgress(state({ tasks: [task('TASK-001', 'completed')] })).corrective)
      .toBeUndefined();
  });

  it('never reports a workflow axis beyond its total', () => {
    for (const stage of ['discovery', 'planning', 'implementation', 'final-review'] as const) {
      const progress = projectProgress(state({ stage }));
      expect(progress.workflow.done).toBeLessThanOrEqual(progress.workflow.total);
      expect(progress.workflow.done).toBeGreaterThan(0);
    }
  });
});

describe('runtime status overrides a persisted status that has moved on', () => {
  it('does not report APPROVED during implementation', () => {
    // The persisted status is a record of the last gate reached, not of what is happening.
    const projection = projectRun({
      state: state({ status: 'approved', stage: 'implementation', tasks: [task('TASK-001', 'running')] }),
      nodes: [{ id: 'TASK-001', dependencies: [] }],
    });

    expect(projection.status).toBe('implementing');
  });

  it('reports the approval gate while the run waits for one', () => {
    const projection = projectRun({ state: state({ status: 'waiting_for_approval', stage: 'plan-review' }) });

    expect(projection.status).toBe('awaiting_human_approval');
    expect(projection.gate?.gate).toBe('approval');
    expect(projection.gate?.action).toMatch(/approve/);
  });

  it('reports recovering while a recovery step is in flight', () => {
    const projection = projectRun({
      state: state({ tasks: [task('TASK-001', 'failed')] }),
      nodes: [{ id: 'TASK-001', dependencies: [] }],
      events: [event('recovery_started', '2026-08-17T15:00:00.000Z')],
    });

    expect(projection.status).toBe('recovering');
  });

  it('stops reporting recovering once the step completed', () => {
    const projection = projectRun({
      state: state({ tasks: [task('TASK-001', 'queued')] }),
      nodes: [{ id: 'TASK-001', dependencies: [] }],
      events: [
        event('recovery_started', '2026-08-17T15:00:00.000Z'),
        event('recovery_step_completed', '2026-08-17T15:01:00.000Z'),
      ],
    });

    expect(projection.status).toBe('implementing');
  });

  it('reports auto_recovery_exhausted until something is requeued', () => {
    const exhausted = projectRun({
      state: state({ tasks: [task('TASK-001', 'failed')] }),
      nodes: [{ id: 'TASK-001', dependencies: [] }],
      events: [event('recovery_exhausted', '2026-08-17T15:00:00.000Z')],
    });
    expect(exhausted.status).toBe('auto_recovery_exhausted');

    const resumed = projectRun({
      state: state({ tasks: [task('TASK-001', 'queued')] }),
      nodes: [{ id: 'TASK-001', dependencies: [] }],
      events: [
        event('recovery_exhausted', '2026-08-17T15:00:00.000Z'),
        event('task_requeued', '2026-08-17T15:05:00.000Z'),
      ],
    });
    expect(resumed.status).toBe('implementing');
  });

  it('reports correcting while a corrective round has unfinished work', () => {
    const projection = projectRun({
      state: state({ tasks: [task('TASK-001', 'completed'), task('FIX-001', 'queued')] }),
      nodes: [
        { id: 'TASK-001', dependencies: [] },
        { id: 'FIX-001', dependencies: [] },
      ],
      events: [event('corrective_plan_created', '2026-08-17T17:00:00.000Z')],
    });

    expect(projection.status).toBe('correcting');
  });

  it('reports final acceptance once every task is done and nothing is runnable', () => {
    const projection = projectRun({
      state: state({ stage: 'implementation', tasks: [task('TASK-001', 'completed')] }),
      nodes: [{ id: 'TASK-001', dependencies: [] }],
    });

    expect(projection.status).toBe('blocked_on_human');
    expect(projection.gate?.gate).toBe('final_acceptance');
  });

  it('reports the agent-blocked gate distinctly from a review gate', () => {
    // Two very different reasons a task sits idle, and conflating them is what made
    // dependency-derived blocks unrecoverable in the first place.
    const projection = projectRun({
      state: state({ tasks: [task('TASK-001', 'blocked', { blockReason: 'agent' })] }),
      nodes: [{ id: 'TASK-001', dependencies: [] }],
    });

    expect(projection.gate?.gate).toBe('agent_blocked');
    expect(projection.gate?.action).toMatch(/blocking/);
  });

  it('reports terminal states from the persisted status', () => {
    expect(projectRun({ state: state({ status: 'completed' }) }).status).toBe('complete');
    expect(projectRun({ state: state({ status: 'failed' }) }).status).toBe('failed');
  });

  it('only ever returns a declared runtime status', () => {
    const inputs = [
      state({ status: 'completed' }),
      state({ status: 'failed' }),
      state({ status: 'waiting_for_approval' }),
      state({ status: 'plan_rejected' }),
      state({ status: 'running', stage: 'discovery' }),
      state({ status: 'running', stage: 'verification' }),
      state({ status: 'running', stage: 'final-review' }),
    ];

    for (const candidate of inputs) {
      expect(RUNTIME_STATUSES).toContain(projectRun({ state: candidate }).status);
    }
  });
});

describe('the evidence run, projected', () => {
  it('reads the real state, plan and event log', () => {
    const projection = projectRun({
      state: evidenceState(),
      nodes: evidenceNodes(),
      events: evidenceEvents(),
    });

    expect(RUNTIME_STATUSES).toContain(projection.status);
    expect(typeof projection.resumable).toBe('boolean');
  });

  it('counts its six planned tasks, and reports no corrective progress', () => {
    // Measured rather than assumed, and the measurement is the interesting part: the
    // corrective round generated FIX-001..003 into `plan.json` and the plan was **rejected**,
    // so those three never entered `state.tasks`. A run with a rejected corrective plan has
    // no corrective *progress* — only a corrective plan — and the axis says so by being
    // absent rather than by reading 0 of 3.
    const progress = projectProgress(evidenceState());

    expect(progress.implementation).toEqual({ done: 6, total: 6 });
    expect(progress.corrective).toBeUndefined();
  });

  it('offers no Resume for its rejected plan, though the DAG would call three tasks ready', () => {
    // The evidence run's end state, and a trap the projection had to be taught. Its plan
    // holds nine tasks; its state holds six. The three FIX tasks have no dependencies and no
    // recorded state, so the DAG defaults them to `queued` and finds them ready — and a
    // resumability answer taken from the graph alone would offer `Resume` on a plan a human
    // rejected.
    const nodes = evidenceNodes();
    const tracked = new Set(evidenceState().tasks.map((entry) => entry.id));

    expect(nodes.length).toBe(9);
    expect(nodes.filter((node) => !tracked.has(node.id)).map((node) => node.id)).toEqual([
      'FIX-001',
      'FIX-002',
      'FIX-003',
    ]);
    expect(evidenceState().status).toBe('plan_rejected');

    expect(isResumable({ state: evidenceState(), nodes })).toBe(false);
  });

  it('reports the rejected plan as revisable rather than as the run being stuck', () => {
    const projection = projectRun({
      state: evidenceState(),
      nodes: evidenceNodes(),
      events: evidenceEvents(),
    });

    expect(projection.status).toBe('plan_rejected_revisable');
    expect(projection.resumable).toBe(false);
  });
});

describe('purity', () => {
  it('persists nothing and derives everything (I-26)', () => {
    // The decision's whole point: a runtime status written to disk would be an opinion a
    // crash mid-write could leave behind. Asserted as determinism over one input.
    const input = { state: evidenceState(), nodes: evidenceNodes(), events: evidenceEvents() };
    expect(projectRun(input)).toEqual(projectRun(input));
  });

  it('does not mutate the state it was given', () => {
    const original = evidenceState();
    const snapshot = JSON.stringify(original);

    projectRun({ state: original, nodes: evidenceNodes(), events: evidenceEvents() });
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

/**
 * C-22 — bounded termination, and what termination has to say for itself.
 *
 * The projection already reported `auto_recovery_exhausted` and stopped there. A status is
 * not the contract: C-22 requires the projection to carry the class, the counts, redacted
 * evidence, every repair attempted with why each failed, and **one** specific human action,
 * precisely so no surface can render "something failed, inspect logs".
 *
 * A status alone is that sentence with better spelling. Everything a person needs in order
 * to act was already in the event log, and every surface had to reassemble it — which is
 * how three of them disagreed about what had been tried.
 */
describe('C-22 — an exhausted run says what happened and what to do', () => {
  const exhaustedRun = (detail: Record<string, unknown> = {}) => ({
    state: state({ tasks: [task('TASK-001', 'review_required')] }),
    nodes: [{ id: 'TASK-001', dependencies: [] }],
    events: [
      RunEventSchema.parse({
        at: '2026-08-17T14:00:00.000Z',
        type: 'recovery_started',
        detail: { task: 'TASK-001', failureClass: 'validation_unsatisfied', step: 'work_retry' },
      }),
      RunEventSchema.parse({
        at: '2026-08-17T14:01:00.000Z',
        type: 'recovery_step_completed',
        detail: { task: 'TASK-001', step: 'work_retry', outcome: 'requeued' },
      }),
      RunEventSchema.parse({
        at: '2026-08-17T14:02:00.000Z',
        type: 'recovery_exhausted',
        detail: {
          task: 'TASK-001',
          failureClass: 'validation_unsatisfied',
          reason: 'the attempt budget is exhausted',
          humanAction: 'Read attempt-3.failed.json for TASK-001 and fix `npm test` by hand',
          counts: { attempts: 3, modelCalls: 3, identicalFailures: 2 },
          evidence: ['npm test → exit 1', 'AssertionError: expected 2, got 3'],
          ...detail,
        },
      }),
    ],
  });

  it('carries the class, the counts and the evidence, not just a status', () => {
    const projected = projectRun(exhaustedRun());

    expect(projected.status).toBe('auto_recovery_exhausted');
    expect(projected.escalation?.failureClass).toBe('validation_unsatisfied');
    expect(projected.escalation?.counts).toEqual({
      attempts: 3,
      modelCalls: 3,
      identicalFailures: 2,
    });
    expect(projected.escalation?.evidence).toEqual([
      'npm test → exit 1',
      'AssertionError: expected 2, got 3',
    ]);
  });

  it('lists every repair attempted and how each one ended', () => {
    // "What was already tried" is the first question anybody asks, and answering it from
    // the event log was left to each surface — which is how they disagreed.
    const projected = projectRun(exhaustedRun());

    expect(projected.escalation?.attemptedRepairs).toEqual([
      { step: 'work_retry', outcome: 'requeued' },
    ]);
  });

  it('records a repair that was started and never completed as unresolved', () => {
    // A crash between `recovery_started` and `recovery_step_completed` leaves a step with
    // no outcome. Omitting it would under-report what the run did.
    const run = exhaustedRun();
    const projected = projectRun({
      ...run,
      events: [
        run.events[0]!,
        RunEventSchema.parse({
          at: '2026-08-17T14:01:30.000Z',
          type: 'recovery_started',
          detail: { task: 'TASK-001', failureClass: 'validation_unsatisfied', step: 'env_repair' },
        }),
        run.events[2]!,
      ],
    });

    expect(projected.escalation?.attemptedRepairs).toContainEqual({
      step: 'env_repair',
      outcome: 'did not complete',
    });
  });

  it('carries exactly one human action, and it names something to do', () => {
    const projected = projectRun(exhaustedRun());

    expect(projected.escalation?.humanAction).toContain('TASK-001');
    expect(projected.escalation?.humanAction).not.toMatch(/inspect (the )?logs/i);
  });

  it('never produces an escalation that fails its own completeness check', () => {
    // The predicate both surfaces are held to. An escalation the projection itself would
    // call incomplete is the "something failed" sentence with extra fields.
    const projected = projectRun(exhaustedRun());

    expect(projected.escalation).toBeDefined();
    expect(isCompleteEscalation(projected.escalation!)).toBe(true);
  });

  it('substitutes nothing when the event carried no counts', () => {
    // An older run predating the enrichment. Reporting `attempts: 0` would be a number
    // nobody measured, and a person would act on it.
    const run = exhaustedRun();
    const projected = projectRun({
      ...run,
      events: [
        run.events[0]!,
        run.events[1]!,
        RunEventSchema.parse({
          at: '2026-08-17T14:02:00.000Z',
          type: 'recovery_exhausted',
          detail: {
            task: 'TASK-001',
            failureClass: 'validation_unsatisfied',
            humanAction: 'Read the failed attempt for TASK-001',
          },
        }),
      ],
    });

    expect(projected.escalation?.counts).toEqual({});
    expect(projected.escalation?.evidence).toEqual([]);
  });

  it('reports no escalation on a run that never exhausted anything', () => {
    expect(projectRun({ state: state(), nodes: [] }).escalation).toBeUndefined();
  });
});

describe('a running task outranks a stage that has not caught up (M8 dogfood)', () => {
  /**
   * Measured on AF-2026-005, live. `task_started` and
   * `stage_started {"stage":"implementation"}` were both in the log at 16:41:15;
   * `state.stage` reached `implementation` at 16:42:13. For that minute the dashboard
   * reported `planning` while an agent was working, on the one screen somebody watches
   * while a run starts.
   */
  it('reports implementing while the stage still says plan-review', () => {
    const projection = projectRun({
      state: state({
        stage: 'plan-review',
        status: 'approved',
        tasks: [task('TASK-001', 'running'), task('TASK-002', 'queued')],
      }),
    });

    expect(projection.status).toBe('implementing');
  });

  it('leaves a stage after implementation alone', () => {
    // Deliberately narrow. A task left `running` by a crash must not make a run in
    // verification claim to be implementing — there the stale task is the story, and
    // `isResumable` already tells that one.
    for (const stage of ['verification', 'final-review'] as const) {
      const projection = projectRun({
        state: state({ stage, status: 'approved', tasks: [task('TASK-001', 'running')] }),
      });

      expect(projection.status, stage).not.toBe('implementing');
    }
  });

  it('still reports planning when nothing is running', () => {
    const projection = projectRun({
      state: state({
        stage: 'plan-review',
        status: 'approved',
        tasks: [task('TASK-001', 'queued')],
      }),
    });

    expect(projection.status).toBe('planning');
  });
});
