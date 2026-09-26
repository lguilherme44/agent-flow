import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { fakeRunActionDeps } from '../fakes/run-action-deps.js';
import { StateStore } from '../../src/app/state-store.js';
import { planHash } from '../../src/app/approval.js';
import type { ActionOutcome, ReviseResult, RunActionDeps } from '../../src/app/run-actions.js';
import {
  reviseModeOf,
  runReviseCommand,
  type ReviseCommandDeps,
} from '../../src/cli/feature.js';
import { runApproveCommand } from '../../src/cli/approve.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import type { GlobalOptions } from '../../src/cli/index.js';
import { PlanSchema } from '../../src/contracts/index.js';

/**
 * P7.5 at the command line — `revise --decision`, `revise --escalate` and
 * `approve --attach-findings` (FR-013 … FR-016, FR-021).
 *
 * The CLI decides one thing here, and it is the thing the use case cannot be asked: both
 * budget modes at once. Everything else it renders. So `revise` is exercised through a fake
 * use case — the replan itself is `revise-budget.test.ts`'s — and the assertions are on the
 * mode it was handed and on the words it printed. `approve` goes through the real use case,
 * because its refusal is the use case's and the output has to be the one a person sees.
 */

const globals: GlobalOptions = {
  cwd: '/repo',
  globalConfigPath: '/install/config.yaml',
  verbose: false,
  dryRun: false,
  json: false,
  strict: false,
};

const PROJECT_CONFIG = `project:
  name: demo
  type: node
commands:
  test: npm test
`;

const TASK_IDS = ['TASK-001', 'TASK-002', 'TASK-003'] as const;

const PLAN = PlanSchema.parse({
  feature: 'weekly-recurrence',
  tasks: TASK_IDS.map((id) => ({
    id,
    title: `${id} title`,
    description: `${id} description.`,
    complexity: 'trivial',
    risk: 'low',
    dependencies: [],
    requirements: ['FR-001'],
    acceptanceCriteria: ['It works.'],
    validation: ['test'],
  })),
});

/** Finding 0 cites TASK-001, finding 1 cites TASK-002, finding 2 cites no task (FR-017). */
const FINDINGS = [
  {
    severity: 'high',
    type: 'requirement',
    description: 'TASK-001 drops the end date of a series.',
    suggestedAction: 'Keep the end date through the parser.',
  },
  {
    severity: 'medium',
    type: 'test-gap',
    description: 'Nothing tests the weekday mask.',
    suggestedAction: 'Cover it in TASK-002.',
  },
  {
    severity: 'low',
    type: 'maintainability',
    description: 'The recurrence module has no error vocabulary.',
    suggestedAction: 'Name the errors once, in one place.',
  },
];

async function project(review: 'failed' | 'passed' = 'passed') {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();

  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('weekly recurrence');
  await store.writeArtifact(run.runId, 'plan', JSON.stringify(PLAN, null, 2));
  await store.writeArtifact(run.runId, 'sdd', '# SDD\n\nFR-001 — recurrence.\n');
  await store.writeArtifact(
    run.runId,
    'planReview',
    JSON.stringify({
      verdict: review === 'passed' ? 'PASS' : 'FAIL',
      independence: 'cross-provider',
      reviewer: { runner: 'codex', reasoning: 'high' },
      planHash: planHash(PLAN),
      findings: review === 'passed' ? [] : FINDINGS,
    }),
  );
  await store.updateRun(run.runId, (state) => ({
    ...state,
    status: 'waiting_for_approval',
    tasks: TASK_IDS.map((id) => ({ id, state: 'queued' as const, attempts: 0, infrastructureFailures: 0 })),
  }));

  const deps: RunActionDeps = fakeRunActionDeps({
    fs,
    clock,
    processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' }),
    projectDir: '/repo',
    globalConfigPath: '/install/config.yaml',
    promptsDir: '/install/prompts',
    host: new FakeHost(),
    owner: 'cli',
  });

  return { store, deps, runId: run.runId };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { stdout: () => out.join(''), stderr: () => err.join('') };
}

/** A `revise` use case that answers with `value`, and remembers how it was called. */
function reviseSeams(deps: RunActionDeps, value: ReviseResult) {
  const revise = vi.fn(
    async (): Promise<ActionOutcome<ReviseResult>> => ({ ok: true, value, warnings: [] }),
  );
  const seams: ReviseCommandDeps = {
    io: {
      readFile: () => undefined,
      readStdin: async () => '',
      openEditor: async () => '',
    },
    revise: revise as unknown as ReviseCommandDeps['revise'],
    actionDeps: () => deps,
  };
  return { seams, revise };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('revise --decision and --escalate (FR-013, FR-014, FR-021)', () => {
  it('passes the decision mode and says the count did not move, as N of M', async () => {
    const { deps, runId } = await project();
    const output = capture();
    const { seams, revise } = reviseSeams(deps, {
      runId,
      taskCount: 3,
      approvalCleared: false,
      mode: 'decision',
      revisionCount: 2,
      maxAllowed: 2,
    });

    const code = await runReviseCommand(
      { argument: 'Keep the v1 endpoint.', decision: true },
      globals,
      seams,
    );

    expect(code).toBe(ExitCode.OK);
    expect(revise).toHaveBeenCalledWith(deps, runId, 'Keep the v1 endpoint.', 'planning', 'decision');
    expect(output.stdout()).toContain('Revision count unchanged: 2 of 2.');
  });

  it('passes the escalation mode and names the class it moved from and to', async () => {
    const { deps, runId } = await project();
    const output = capture();
    const { seams, revise } = reviseSeams(deps, {
      runId,
      taskCount: 3,
      approvalCleared: false,
      mode: 'escalation',
      revisionCount: 1,
      maxAllowed: 2,
      fromWorkflow: 'simple',
      toWorkflow: 'standard',
    });

    const code = await runReviseCommand(
      { argument: 'This touches the public contract.', escalate: true },
      globals,
      seams,
    );

    expect(code).toBe(ExitCode.OK);
    expect(revise).toHaveBeenCalledWith(
      deps,
      runId,
      'This touches the public contract.',
      'planning',
      'escalation',
    );
    expect(output.stdout()).toContain('simple → standard');
  });

  it('keeps a plain revision as it was: mode `revision`, and no budget line', async () => {
    const { deps, runId } = await project();
    const output = capture();
    const { seams, revise } = reviseSeams(deps, { runId, taskCount: 3, approvalCleared: false });

    await runReviseCommand({ argument: 'Split TASK-002.' }, globals, seams);

    expect(revise).toHaveBeenCalledWith(deps, runId, 'Split TASK-002.', 'planning', 'revision');
    // Positive control for the two above: the line comes from the mode, not from the command.
    expect(output.stdout()).not.toContain('Revision count unchanged');
    expect(output.stdout()).not.toContain('→');
  });

  it('refuses --decision with --escalate as invalid_input, before the use case is called (FR-015)', async () => {
    const { deps, runId } = await project();
    const output = capture();
    const { seams, revise } = reviseSeams(deps, { runId, taskCount: 3, approvalCleared: false });

    const code = await runReviseCommand(
      { argument: 'Either.', decision: true, escalate: true },
      globals,
      seams,
    );

    expect(code).toBe(ExitCode.GATE_NOT_SATISFIED);
    expect(revise).not.toHaveBeenCalled();
    expect(output.stderr()).toContain('--decision and --escalate');

    const chosen = reviseModeOf({ decision: true, escalate: true });
    expect(chosen.ok).toBe(false);
    if (!chosen.ok) expect(chosen.error.code).toBe('invalid_input');
  });

  it('reads each flag alone as its own mode', () => {
    expect(reviseModeOf({})).toEqual({ ok: true, mode: 'revision' });
    expect(reviseModeOf({ decision: true })).toEqual({ ok: true, mode: 'decision' });
    expect(reviseModeOf({ escalate: true })).toEqual({ ok: true, mode: 'escalation' });
  });
});

describe('approve --attach-findings (FR-016, FR-021)', () => {
  it('prints how many findings were attached and how many tasks they reached', async () => {
    const { store, deps, runId } = await project('failed');
    const output = capture();

    const code = await runApproveCommand({ attachFindings: true }, globals, () => deps);

    expect(code).toBe(ExitCode.OK);
    // Three findings; finding 2 cites no task, so it reaches all three.
    expect(output.stdout()).toContain('3 finding(s), reaching 3 task(s)');
    // An attachment is forced, but "--force was given" would be a false sentence.
    expect(output.stdout()).not.toContain('because --force was given');
    expect((await store.loadRun(runId)).amendments?.map((entry) => entry.kind)).toEqual([
      'attached_findings',
    ]);
  });

  it('renders the findings_not_attachable refusal over a review that passed', async () => {
    const { store, deps, runId } = await project('passed');
    const before = await store.loadRun(runId);
    const output = capture();

    const code = await runApproveCommand({ attachFindings: true }, globals, () => deps);

    expect(code).toBe(ExitCode.GATE_NOT_SATISFIED);
    expect(output.stderr()).toContain('there is no failed review of this plan to hand over');
    expect(output.stderr()).toContain('The plan review on file passed this plan.');
    expect(output.stdout()).not.toContain('Approved');
    expect(await store.loadRun(runId)).toEqual(before);
  });

  it('positive control: plain approve over the same passing review is approved', async () => {
    const { deps } = await project('passed');
    const output = capture();

    const code = await runApproveCommand({}, globals, () => deps);

    expect(code).toBe(ExitCode.OK);
    expect(output.stdout()).toContain('Approved');
    expect(output.stdout()).not.toContain('finding(s)');
  });
});
