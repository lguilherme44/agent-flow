import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { review } from '../../src/app/run-actions.js';
import { fakeRunActionDeps } from '../fakes/run-action-deps.js';
import { SECOND_PERSON_OBSERVING } from '../fakes/second-person.js';


const PLAN = {
  feature: 'sample web app',
  tasks: [
    {
      id: 'TASK-001',
      title: 'Build login flow',
      description: 'Implement login page and form.',
      complexity: 'normal',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['User can log in.'],
      validation: ['test'],
    },
  ],
};

const PROMPTS = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
  'verification',
  'e2e',
  'final-review',
];

async function setupProject(options: {
  e2eEnabled: boolean;
  e2eVerdict?: 'PASS' | 'FAIL' | 'NOT_RUN';
  e2eFindings?: unknown[];
  e2eSummary?: string;
  /**
   * The task's `validation`. The default lists a `test` gate no task runs, so the run is
   * never done for that reason; `[]` leaves e2e as the only condition that can be unmet.
   */
  planValidation?: string[];
  /** What the final reviewer (and only it) returns. */
  finalReview?: { verdict: 'PASS' | 'FAIL'; findings: unknown[] };
}) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const host = new FakeHost();

  fs.seed(
    '/install/config.yaml',
    `runners:\n  agy:\n    type: agy-cli\n    enabled: true\n    dangerouslySkipPermissions: true\nroles:\n  e2e:\n    enabled: ${String(options.e2eEnabled)}\n    runner: agy\n    effort: high\n`,
  );

  for (const name of PROMPTS) {
    const required = name === 'e2e' ? ['sdd', 'changedFiles', 'agentsMd'] : [];
    fs.seed(
      `/install/prompts/${name}.md`,
      `---\npermissions: write\noutputFormat: json\nrequiredVars: [${required.join(', ')}]\n---\n\n# ${name}\n`,
    );
  }

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('test e2e flow', () => ({
    isolationMode: 'none' as const,
  }));

  await store.writeArtifact(run.runId, 'sdd', '# SDD\n\nFR-001 — Login feature specification.\n');
  const plan =
    options.planValidation === undefined
      ? PLAN
      : { ...PLAN, tasks: PLAN.tasks.map((task) => ({ ...task, validation: options.planValidation })) };
  await store.writeArtifact(run.runId, 'plan', JSON.stringify(plan));
  await store.updateRun(run.runId, (state) => ({
    ...state,
    approved: true,
    approvedAt: '2026-08-09T20:00:00.000Z',
    tasks: [
      {
        id: 'TASK-001',
        state: 'completed',
        attempts: 1,
        infrastructureFailures: 0,
      },
    ],
  }));

  const e2eResponse = {
    verdict: options.e2eVerdict ?? 'PASS',
    summary: options.e2eSummary ?? 'E2E browser tests executed with agent-browser.',
    findings: options.e2eFindings ?? [],
  };

  const defaultReviewResponse = {
    verdict: 'PASS',
    summary: 'All good.',
    findings: [],
  };

  const runner = new FakeProcessRunner().always((opts) => {
    // The e2e prompt's own heading, read from stdin where the runner sends the prompt — not
    // the word "e2e" anywhere in the args: other stages' invocations can carry it, and a
    // NOT_RUN handed to verification is a schema error there.
    if (opts.stdin?.includes('# e2e') === true) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          is_error: false,
          status: 'SUCCESS',
          result: JSON.stringify(e2eResponse),
          structured_output: e2eResponse,
        }),
      };
    }
    if (options.finalReview !== undefined && opts.stdin?.includes('# final-review') === true) {
      const finalResponse = { summary: 'Final review.', ...options.finalReview };
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          is_error: false,
          status: 'SUCCESS',
          result: JSON.stringify(finalResponse),
          structured_output: finalResponse,
        }),
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        is_error: false,
        status: 'SUCCESS',
        result: JSON.stringify(defaultReviewResponse),
        structured_output: defaultReviewResponse,
      }),
    };
  });

  const deps = fakeRunActionDeps({
    fs,
    clock,
    processRunner: runner,
    projectDir: '/repo',
    globalConfigPath: '/install/config.yaml',
    promptsDir: '/install/prompts',
    host,
    owner: 'cli',
  });

  return { fs, store, deps, runId: run.runId };
}

describe('E2E testing stage with agent-browser and agy provider', () => {
  it('executes e2e stage with agy when e2e is enabled', async () => {
    const { store, deps, runId } = await setupProject({ e2eEnabled: true });

    const stagesObserved: string[] = [];
    const outcome = await review(deps, runId, {
      onStage: (stage) => stagesObserved.push(stage),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(stagesObserved).toContain('e2e');
    expect(outcome.value.e2eReview).toBeDefined();
    expect(outcome.value.e2eReview?.reviewer.runner).toBe('agy');
    expect(outcome.value.e2eReview?.verdict).toBe('PASS');

    // Artifact reviews/e2e.json should be written
    const e2eArtifact = await store.readArtifact(runId, 'e2e');
    expect(e2eArtifact).not.toBeNull();
    const parsed = JSON.parse(e2eArtifact!);
    expect(parsed.verdict).toBe('PASS');
    expect(parsed.summary).toContain('agent-browser');
  });

  it('skips e2e stage when e2e is disabled', async () => {
    const { store, deps, runId } = await setupProject({ e2eEnabled: false });

    const stagesObserved: string[] = [];
    const outcome = await review(deps, runId, {
      onStage: (stage) => stagesObserved.push(stage),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(stagesObserved).not.toContain('e2e');
    expect(outcome.value.e2eReview).toBeUndefined();

    // Artifact reviews/e2e.json should not exist
    const e2eArtifact = await store.readArtifact(runId, 'e2e');
    expect(e2eArtifact).toBeNull();
  });

  it('fails Definition of Done when e2e finds blocking issues', async () => {
    const { deps, runId } = await setupProject({
      e2eEnabled: true,
      e2eVerdict: 'FAIL',
      e2eFindings: [
        {
          severity: 'critical',
          type: 'e2e_failure',
          file: 'src/login.ts',
          description: 'Login button fails to submit credentials in browser',
          suggestedAction: 'Fix submit handler event listener',
        },
      ],
    });

    const outcome = await review(deps, runId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.e2eReview?.verdict).toBe('FAIL');
    expect(outcome.value.done.done).toBe(false);
    expect(outcome.value.done.missing).toContain('no blocking review finding is open');
    const blockingCondition = outcome.value.done.conditions.find(
      (c) => c.name === 'no blocking review finding is open',
    );
    expect(blockingCondition?.detail).toContain('still open: unidentified finding');
  });

  it('completes the run when e2e ran and passed', async () => {
    const { deps, runId } = await setupProject({ e2eEnabled: true });

    const outcome = await review(deps, runId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The fixture's plan lists a `test` gate no task runs, so the run itself is not done;
    // what this pins is that e2e is not the reason.
    const condition = outcome.value.done.conditions.find(
      (c) => c.name === 'e2e exercised the change and passed',
    );
    expect(condition?.met).toBe(true);
    expect(outcome.value.done.missing).not.toContain('e2e exercised the change and passed');
  });
});

describe('an e2e that could not run is never a pass (pilot 75559)', () => {
  const missingDevice = {
    severity: 'info',
    type: 'e2e_failure',
    file: 'lib/cart_page.dart',
    description: 'The change only shows inside the iOS app WebView; no device or simulator was available.',
    suggestedAction: 'Exercise it on an iOS simulator or device.',
  };
  const mediumFinding = {
    severity: 'medium',
    type: 'maintainability',
    file: 'lib/cart_page.dart',
    description: 'The header widget duplicates the total formatting.',
    suggestedAction: 'Reuse the shared formatter.',
  };

  it('ends NOT DONE and names what was missing', async () => {
    const { store, deps, runId } = await setupProject({
      e2eEnabled: true,
      e2eVerdict: 'NOT_RUN',
      e2eSummary: 'NOT RUN: native iOS WebView, not reachable by agent-browser.',
      e2eFindings: [missingDevice],
    });

    const outcome = await review(deps, runId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.done.done).toBe(false);
    expect(outcome.value.done.missing).toContain('e2e exercised the change and passed');
    const condition = outcome.value.done.conditions.find(
      (c) => c.name === 'e2e exercised the change and passed',
    );
    expect(condition?.detail).toContain('did not run');
    expect(condition?.detail).toContain('native iOS WebView');
    expect(outcome.value.e2eNotRun?.reason).toContain('native iOS WebView');

    const run = await store.loadRun(runId);
    expect(run.status).not.toBe('completed');

    const artifact = JSON.parse((await store.readArtifact(runId, 'e2e'))!);
    expect(artifact.verdict).toBe('NOT_RUN');
  });

  /**
   * The finding is `high` and the final review carries a `medium`, both above the corrective
   * threshold, so a test that passes here passes because no round ran — not because nothing
   * was severe enough. The version this replaces used an `info` finding and accepted an
   * absent round as `nothing_actionable`, so it held whether the round ran or not.
   */
  it('does not run a corrective round when e2e NOT_RUN is the only thing unmet', async () => {
    const { store, deps, runId } = await setupProject({
      e2eEnabled: true,
      e2eVerdict: 'NOT_RUN',
      e2eSummary: 'NOT RUN: native iOS WebView, not reachable by agent-browser.',
      e2eFindings: [{ ...missingDevice, severity: 'high' }],
      planValidation: [],
      finalReview: { verdict: 'PASS', findings: [mediumFinding] },
    });
    const planBefore = await store.readArtifact(runId, 'plan');

    const outcome = await review(deps, runId, { fix: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // Precondition: e2e is the one condition unmet, so this exercises that case only.
    expect(outcome.value.done.missing).toEqual(['e2e exercised the change and passed']);
    expect(outcome.value.corrective).toBeUndefined();
    expect(outcome.value.awaitingObservation).toBe(true);

    const run = await store.loadRun(runId);
    expect(run.approved).toBe(true);
    expect(run.tasks.map((task) => task.id)).toEqual(['TASK-001']);
    expect(await store.readArtifact(runId, 'plan')).toBe(planBefore);
  });

  it('still runs the corrective round when something else is unmet too', async () => {
    // The default plan lists a `test` gate no task ran: a real failure beside the NOT_RUN.
    const { deps, runId } = await setupProject({
      e2eEnabled: true,
      e2eVerdict: 'NOT_RUN',
      e2eSummary: 'NOT RUN: native iOS WebView.',
      e2eFindings: [missingDevice],
      finalReview: { verdict: 'PASS', findings: [mediumFinding] },
    });

    const outcome = await review(deps, runId, { fix: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.done.missing).toContain('required gates ran and passed');
    // The round ran. What it produced is beside the point here (this fixture's `test` gate is
    // not declared, so the corrected plan does not validate); that it was attempted is.
    expect(outcome.value.corrective).toBeDefined();
    expect(outcome.value.awaitingObservation).toBeUndefined();
  });

  it('reads a PASS whose summary says NOT RUN as the NOT_RUN it is', async () => {
    // A model that ignores the prompt's third verdict and answers the old way.
    const { store, deps, runId } = await setupProject({
      e2eEnabled: true,
      e2eVerdict: 'PASS',
      e2eSummary: '  NOT RUN: the app only runs inside the iOS WebView.',
      planValidation: [],
    });

    const outcome = await review(deps, runId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.e2eReview).toBeUndefined();
    expect(outcome.value.e2eNotRun?.reason).toBe('the app only runs inside the iOS WebView.');
    expect(outcome.value.done.done).toBe(false);
    expect(outcome.value.done.missing).toEqual(['e2e exercised the change and passed']);
    expect(JSON.parse((await store.readArtifact(runId, 'e2e'))!).verdict).toBe('NOT_RUN');
  });

  it('keeps a PASS whose summary merely mentions "not run" a PASS', async () => {
    const { deps, runId } = await setupProject({
      e2eEnabled: true,
      e2eVerdict: 'PASS',
      e2eSummary: 'Exercised the cart; the stale banner did not run its animation twice.',
      planValidation: [],
    });

    const outcome = await review(deps, runId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.e2eReview?.verdict).toBe('PASS');
    expect(outcome.value.done.done).toBe(true);
  });

  it('refuses a NOT_RUN that does not say what was missing', async () => {
    const { deps, runId } = await setupProject({
      e2eEnabled: true,
      e2eVerdict: 'NOT_RUN',
      e2eFindings: [],
    });

    // Same contract as a FAIL without findings: the stage never accepts it.
    await expect(review(deps, runId)).rejects.toThrow(/must be accompanied by at least one finding/);
  });

  it('completes the run on a human attestation, and records who said what', async () => {
    const { store, deps, runId } = await setupProject({
      e2eEnabled: true,
      e2eVerdict: 'NOT_RUN',
      e2eSummary: 'NOT RUN: native iOS WebView, not reachable by agent-browser.',
      e2eFindings: [missingDevice],
      planValidation: [],
    });

    const outcome = await review(deps, runId, {
      e2eObservation: {
        by: '  Luis  ',
        words: '  Opened the cart on an iPhone 15; the header shows the new total.  ',
      },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.done.done).toBe(true);
    const condition = outcome.value.done.conditions.find(
      (c) => c.name === 'e2e exercised the change and passed',
    );
    // The observer by name, and the channel beside it: `keyboard` is also what an AI
    // driving the CLI records as, so the channel alone cannot say a person saw it.
    expect(condition?.detail).toBe(
      'not run by agent-flow; observed by Luis (recorded via keyboard): "Opened the cart on an iPhone 15; the header shows the new total."',
    );

    const run = await store.loadRun(runId);
    expect(run.status).toBe('completed');
    const recorded = run.amendments?.filter((entry) => entry.kind === 'e2e_observation') ?? [];
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      kind: 'e2e_observation',
      actor: { kind: 'keyboard' },
      observedBy: 'Luis',
      text: 'Opened the cart on an iPhone 15; the header shows the new total.',
    });
    // Sequential mode: no commit names the tree, so the attestation carries no head.
    expect(recorded[0]?.integrationHead).toBeUndefined();
  });

  it('does not let an attestation outlive the review it was given to, in sequential mode', async () => {
    // Nothing names the working tree a later review reads; it may hold different code.
    const { deps, runId } = await setupProject({
      e2eEnabled: true,
      e2eVerdict: 'NOT_RUN',
      e2eSummary: 'NOT RUN: iOS only.',
      e2eFindings: [missingDevice],
      planValidation: [],
    });

    const first = await review(deps, runId, {
      e2eObservation: { by: 'Luis', words: 'Saw it on the device.' },
    });
    expect(first.ok && first.value.done.done).toBe(true);

    const second = await review(deps, runId);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.done.done).toBe(false);
    expect(second.value.done.missing).toEqual(['e2e exercised the change and passed']);
  });

  it('never lets an attestation override an e2e FAIL', async () => {
    const { deps, runId } = await setupProject({
      e2eEnabled: true,
      e2eVerdict: 'FAIL',
      e2eFindings: [{ ...mediumFinding, type: 'e2e_failure' }],
      planValidation: [],
    });

    const outcome = await review(deps, runId, {
      e2eObservation: { by: 'Luis', words: 'Works on my phone.' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.done.done).toBe(false);
    expect(outcome.value.done.missing).toContain('e2e exercised the change and passed');
  });

  it('refuses an empty attestation before touching the run', async () => {
    const { store, deps, runId } = await setupProject({ e2eEnabled: true, planValidation: [] });
    const eventsBefore = (await store.readEvents(runId)).length;

    const outcome = await review(deps, runId, { e2eObservation: { by: 'Luis', words: '   ' } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('invalid_input');
    expect((await store.readEvents(runId)).length).toBe(eventsBefore);
  });

  it('refuses an attestation longer than an answer may be', async () => {
    const { deps, runId } = await setupProject({ e2eEnabled: true, planValidation: [] });
    const outcome = await review(deps, runId, {
      e2eObservation: { by: 'Luis', words: 'x'.repeat(4_001) },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('invalid_input');
  });

  it('refuses an attestation that does not name who observed it, before touching the run', async () => {
    // The record's actor is the channel. An AI driving the CLI is `keyboard` too, so
    // without a name the record cannot tell a person's observation from its own.
    const { store, deps, runId } = await setupProject({ e2eEnabled: true, planValidation: [] });
    const eventsBefore = (await store.readEvents(runId)).length;

    for (const by of ['', '   ', 'x'.repeat(121)]) {
      const outcome = await review(deps, runId, { e2eObservation: { by, words: 'Saw it.' } });
      expect(outcome.ok, JSON.stringify(by)).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe('invalid_input');
      expect(outcome.error.message).toMatch(/name/i);
    }
    expect((await store.readEvents(runId)).length).toBe(eventsBefore);
  });

  it('refuses a tested build when no commit names the tree under review', async () => {
    const { store, deps, runId } = await setupProject({
      e2eEnabled: true,
      e2eVerdict: 'NOT_RUN',
      e2eSummary: 'NOT RUN: iOS only.',
      e2eFindings: [missingDevice],
      planValidation: [],
    });

    const outcome = await review(deps, runId, {
      e2eObservation: { by: 'Luis', words: 'Saw it.', head: 'abcdef0' },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('invalid_input');
    expect(outcome.error.message).toContain('abcdef0');
    expect((await store.loadRun(runId)).amendments).toBeUndefined();
  });

  it('asks the reader to get the human, never to observe it themselves', async () => {
    const { deps, runId } = await setupProject({
      e2eEnabled: true,
      e2eVerdict: 'NOT_RUN',
      e2eSummary: 'NOT RUN: iOS only.',
      e2eFindings: [missingDevice],
      planValidation: [],
    });

    const outcome = await review(deps, runId, { fix: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const detail = outcome.value.done.conditions.find(
      (c) => c.name === 'e2e exercised the change and passed',
    )?.detail;
    expect(detail).toMatch(/\bhuman\b/);
    expect(detail).not.toMatch(SECOND_PERSON_OBSERVING);
  });

  it('refuses an attestation when e2e is disabled: there is nothing for it to stand in for', async () => {
    const { store, deps, runId } = await setupProject({ e2eEnabled: false, planValidation: [] });
    const outcome = await review(deps, runId, { e2eObservation: { by: 'Luis', words: 'Saw it.' } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('invalid_input');
    expect((await store.loadRun(runId)).amendments).toBeUndefined();
  });

  it('keeps a FAIL with only medium findings from completing the run', async () => {
    const { deps, runId } = await setupProject({
      e2eEnabled: true,
      e2eVerdict: 'FAIL',
      e2eFindings: [
        {
          severity: 'medium',
          type: 'visual_defect',
          file: 'src/cart.vue',
          description: 'The total overlaps the button on a 375px screen.',
          suggestedAction: 'Wrap the footer.',
        },
      ],
    });

    const outcome = await review(deps, runId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.done.done).toBe(false);
    expect(outcome.value.done.missing).toContain('e2e exercised the change and passed');
  });
});
