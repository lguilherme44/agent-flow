import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { PlanSchema, STAGE_EVENT_TYPES } from '../../src/contracts/index.js';
import { planHash } from '../../src/app/approval.js';
import { planFeature, revise } from '../../src/app/run-actions.js';
import { fakeRunActionDeps } from '../fakes/run-action-deps.js';
import { FINDINGS_SECTION_BEGIN } from '../../src/core/replan-input.js';
import { lastReplanReport } from '../../src/core/replan-report.js';
import type { ProcessSpawnOptions } from '../../src/ports/index.js';

/**
 * D14 — the planning stage receives the findings of the last review.
 *
 * Measured on AF-2026-004: the cross-provider plan review wrote nine anchored findings
 * and the replan that followed saw none of them, so the high-risk loop was refused three
 * times for the same reason and the operator pasted the findings in by hand. The
 * assertions below are on what the *planner process actually received on stdin* —
 * anything weaker would pass against a system that wrote the findings somewhere nobody
 * reads.
 */

const REAL_PROMPTS = join(import.meta.dirname, '../../prompts');

const PROJECT_CONFIG = `project:
  name: demo
  type: node
commands:
  test: npm test
`;

const SDD_TEXT = `# Software Design Document

## Context
x
## Problem
x
## Current Behavior
x
## Desired Behavior
x
## Functional Requirements
- FR-001: Generate recurring bookings.
- FR-002: Cancel one occurrence.
## Non-Functional Requirements
- NFR-001: Generation completes within 200ms.
## Architecture
x
## Components Affected
x
## Database Changes
x
## API Changes
x
## Frontend Changes
None. No user interface is involved.
## Domain Changes
x
## Contracts and Interfaces
x
## Security
x
## Observability
x
## Migration Strategy
x
## Testing Strategy
x
## Edge Cases
x
## Risks
x
## Alternatives Considered
x
## Acceptance Criteria
- A weekly rule produces the expected occurrences.
`;

const PLAN = {
  feature: 'recurring-bookings',
  tasks: [
    {
      id: 'TASK-001',
      title: 'Add recurrence types',
      description: 'Domain types for recurrence rules.',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['Types compile and are exported.'],
      validation: [],
    },
    {
      id: 'TASK-002',
      title: 'Add cancellation',
      description: 'Cancel a single occurrence.',
      complexity: 'normal',
      risk: 'medium',
      dependencies: ['TASK-001'],
      requirements: ['FR-002'],
      acceptanceCriteria: ['Cancelling one occurrence leaves the series intact.'],
      validation: [],
    },
  ],
};

/** The nine-finding shape of the measured run, kept to two so the assertions stay readable. */
const REJECTED_REVIEW = {
  verdict: 'FAIL',
  independence: 'cross-provider',
  reviewer: { runner: 'stub-reviewer', reasoning: 'high' },
  findings: [
    {
      severity: 'critical',
      type: 'correctness',
      description: 'TASK-002 cancels an occurrence without touching the series index.',
      suggestedAction: 'Add the index update to TASK-002.',
      file: 'src/domain/recurrence.ts',
      location: { line: 142 },
    },
    {
      severity: 'medium',
      type: 'test-gap',
      description: 'No task covers the weekly rule boundary.',
      suggestedAction: 'Add a covering task.',
      file: 'test/domain/recurrence.test.ts',
      location: { line: 7, endLine: 40 },
    },
  ],
};

const ANCHORS = ['src/domain/recurrence.ts:142', 'test/domain/recurrence.test.ts:7-40'];

const PASSING_REVIEW = {
  verdict: 'PASS',
  independence: 'cross-provider',
  reviewer: { runner: 'stub-reviewer', reasoning: 'high' },
  findings: [],
  summary: 'Sound plan, though TASK-001 could be named better.',
};

function envelope(payload: unknown): { exitCode: number; stdout: string } {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      is_error: false,
      subtype: 'success',
      result: typeof payload === 'string' ? payload : JSON.stringify(payload),
      ...(typeof payload === 'string' ? {} : { structured_output: payload }),
    }),
  };
}

/**
 * Seeds a run that has been planned once and had that plan refused, and returns the
 * process runner so the prompts can be read back.
 */
async function rejectedRun(
  options: {
    review?: unknown | null;
    /** `undefined` binds the review to the seeded plan; `null` omits the field entirely. */
    planHash?: string | null;
  } = {},
) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const host = new FakeHost();

  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
  // The shipped prompts, so `{{featureRequest}}` is substituted exactly as it is in
  // production — a stub prompt would drop the very text this test is about.
  for (const file of readdirSync(REAL_PROMPTS)) {
    if (file.endsWith('.md')) {
      fs.seed(`/install/prompts/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
    }
  }

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('Add recurring bookings', () => ({
    isolationMode: 'none' as const,
    workflow: 'standard' as const,
  }));

  const parsed = PlanSchema.parse(PLAN);
  await store.writeArtifact(run.runId, 'request', 'Add recurring bookings\n');
  await store.writeArtifact(run.runId, 'sdd', SDD_TEXT);
  await store.writeArtifact(run.runId, 'architectureImpact', '# Impact\n\nThe booking module.\n');
  await store.writeArtifact(run.runId, 'plan', JSON.stringify(parsed, null, 2));
  const review = options.review === undefined ? REJECTED_REVIEW : options.review;
  if (review !== null) {
    const hash = options.planHash === undefined ? planHash(parsed) : options.planHash;
    await store.writeArtifact(
      run.runId,
      'planReview',
      JSON.stringify(
        { ...(review as object), ...(hash === null ? {} : { planHash: hash }) },
        null,
        2,
      ),
    );
  }
  await store.updateRun(run.runId, (state) => ({ ...state, status: 'plan_rejected' }));

  const processRunner = new FakeProcessRunner().always((opts: ProcessSpawnOptions) => {
    if (opts.args.includes('--version') || opts.command === 'git') {
      return { exitCode: 0, stdout: '1.0.0' };
    }
    const prompt = opts.stdin ?? '';
    if (prompt.includes('ROLE: PLANNING_AGENT')) return envelope(PLAN);
    if (prompt.includes('ROLE: PLAN_REVIEW_AGENT')) {
      return envelope({ verdict: 'PASS', summary: 'Fixed.', findings: [] });
    }
    // So a resume from `sdd` re-runs that stage and still produces a plan the checks
    // accept — otherwise the run fails for a reason that has nothing to do with D14.
    if (prompt.includes('ROLE: SDD_AGENT')) return envelope(SDD_TEXT);
    return envelope('# Architecture\n\nA Node service.\n');
  });

  const deps = fakeRunActionDeps({
    fs,
    clock,
    processRunner,
    projectDir: '/repo',
    globalConfigPath: '/install/config.yaml',
    promptsDir: '/install/prompts',
    host,
    owner: 'cli',
  });

  return { store, deps, runId: run.runId, processRunner };
}

/** What the planner process was handed on stdin, or nothing if it was never called. */
function plannerPrompt(processRunner: FakeProcessRunner): string | undefined {
  return processRunner.calls.find((call) => (call.stdin ?? '').includes('ROLE: PLANNING_AGENT'))
    ?.stdin;
}

/** Every prompt any stage was handed, joined — so "no stage saw this" is one assertion. */
function everyPrompt(processRunner: FakeProcessRunner): string {
  return processRunner.calls.map((call) => call.stdin ?? '').join('\n');
}

async function eventsOf(store: StateStore, runId: string) {
  return store.readEvents(runId);
}

async function forwardedEvent(store: StateStore, runId: string) {
  return (await eventsOf(store, runId)).find((e) => e.type === 'replan_findings_forwarded');
}

async function withheldEvent(store: StateStore, runId: string) {
  return (await eventsOf(store, runId)).find((e) => e.type === 'replan_findings_withheld');
}

describe('revise forwards the findings of a rejected plan review (D14)', () => {
  it('hands the planner every anchored finding', async () => {
    const { deps, runId, processRunner } = await rejectedRun();

    const outcome = await revise(deps, runId, 'split TASK-002');
    expect(outcome.ok).toBe(true);

    const prompt = plannerPrompt(processRunner);
    expect(prompt).toBeDefined();

    // POSITIVE CONTROL. Remove the forwarding in `revise` and these four assertions
    // fail: without the mechanism the planner input is the request plus the sentence
    // the human typed, and no anchor appears anywhere in it.
    for (const anchor of ANCHORS) expect(prompt).toContain(anchor);
    expect(prompt).toContain('TASK-002 cancels an occurrence without touching the series index.');
    expect(prompt).toContain(FINDINGS_SECTION_BEGIN);

    // And the human's own words are still there — the findings are added, not swapped in.
    expect(prompt).toContain('split TASK-002');
  });

  it('records how many findings the planner was given', async () => {
    const { store, deps, runId } = await rejectedRun();
    await revise(deps, runId, 'split TASK-002');

    const requested = (await eventsOf(store, runId)).find((e) => e.type === 'revision_requested');
    expect(requested?.detail['findingsForwarded']).toBe(2);
    expect(requested?.detail['findingsOmitted']).toBe(0);
  });

  /**
   * A finding against the SPECIFICATION had nowhere to go, and the cycle could not converge.
   *
   * Measured on a live run: a review rejected a plan because the SDD's contract table
   * mapped `image/*` to three extensions, which broke the use case the incident was about.
   * The revision told the planner to fix it, the planner did, and the next review rejected
   * the plan for *contradicting the SDD* — an artefact `revise` re-entered past. The only
   * way out was a fresh run with the decision written into its description: a full planning
   * pass to change one row of one table.
   */
  it('re-enters at planning by default, and actually re-runs the sdd when asked', async () => {
    // Asserted on the stages the pipeline STARTED, not on the event that records the
    // parameter. An earlier version of this test checked `revision_requested.detail.from`
    // and stayed green with `from: 'planning'` hardcoded back into the pipeline call —
    // it proved the intent was written down, not that anything acted on it.
    const stagesStartedAfter = async (
      store: StateStore,
      runId: string,
      marker: string,
    ): Promise<string[]> => {
      const events = await eventsOf(store, runId);
      const from = events.findIndex((e) => e.type === marker);
      return events
        .slice(from + 1)
        .filter((e) => e.type === 'stage_started')
        .map((e) => String(e.detail['stage']));
    };

    const byDefault = await rejectedRun();
    await revise(byDefault.deps, byDefault.runId, 'split TASK-002');
    const defaultStages = await stagesStartedAfter(
      byDefault.store,
      byDefault.runId,
      'revision_requested',
    );
    expect(defaultStages).toContain('planning');
    expect(defaultStages).not.toContain('sdd');

    // POSITIVE CONTROL: hardcode `from: 'planning'` back into `replan` and this fails —
    // the sdd never starts, however the caller asks.
    const fromSdd = await rejectedRun();
    await revise(fromSdd.deps, fromSdd.runId, 'the contract table is wrong', 'sdd');
    const sddStages = await stagesStartedAfter(fromSdd.store, fromSdd.runId, 'revision_requested');
    expect(sddStages).toContain('sdd');
    // And planning still runs after it: re-specifying without re-planning would leave the
    // plan bound to a specification it no longer matches, which is the defect inverted.
    expect(sddStages).toContain('planning');
  });

  it('adds nothing when the last review passed', async () => {
    // The guard is not a blanket paste. A PASS review's summary is an observation, and a
    // planner told to fix it would be fixing something nobody refused.
    const { deps, runId, processRunner } = await rejectedRun({ review: PASSING_REVIEW });

    await revise(deps, runId, 'split TASK-002');

    const prompt = plannerPrompt(processRunner);
    expect(prompt).toBeDefined();
    expect(prompt).not.toContain(FINDINGS_SECTION_BEGIN);
    expect(prompt).not.toContain('could be named better');
    expect(prompt).toContain('split TASK-002');
  });
});

describe('feature --from planning forwards them too (D14)', () => {
  it('hands the planner every anchored finding, with no human instruction', async () => {
    const { deps, runId, processRunner } = await rejectedRun();

    const outcome = await planFeature(deps, runId, 'Add recurring bookings', { from: 'planning' });
    expect(outcome.ok).toBe(true);

    const prompt = plannerPrompt(processRunner);
    for (const anchor of ANCHORS) expect(prompt).toContain(anchor);
    expect(prompt).toContain(FINDINGS_SECTION_BEGIN);
  });

  it('records the forwarding on the run', async () => {
    const { store, deps, runId } = await rejectedRun();
    await planFeature(deps, runId, 'Add recurring bookings', { from: 'planning' });

    const forwarded = (await eventsOf(store, runId)).find(
      (e) => e.type === 'replan_findings_forwarded',
    );
    expect(forwarded?.detail['findingsForwarded']).toBe(2);
    expect(forwarded?.detail['from']).toBe('planning');
  });

  it('adds nothing to a run that has never been reviewed', async () => {
    // The first `feature` of a run: there is no plan review artifact, so there is
    // nothing to forward and the planner sees exactly what it always saw.
    const { store, deps, runId, processRunner } = await rejectedRun({ review: null });

    const outcome = await planFeature(deps, runId, 'Add recurring bookings', { from: 'planning' });
    expect(outcome.ok).toBe(true);

    expect(plannerPrompt(processRunner)).not.toContain(FINDINGS_SECTION_BEGIN);
    expect(await forwardedEvent(store, runId)).toBeUndefined();
  });

  it('adds nothing when the operator retyped a different request', async () => {
    // `revise` reads the stored artifact; here the description is retyped on the command
    // line. Findings describe tasks that answered one question — a request that is no
    // longer that question invalidates them the way a changed plan does.
    const { store, deps, runId, processRunner } = await rejectedRun();

    const outcome = await planFeature(deps, runId, 'Add recurring bookings AND invoicing', {
      from: 'planning',
    });
    expect(outcome.ok).toBe(true);

    expect(everyPrompt(processRunner)).not.toContain(FINDINGS_SECTION_BEGIN);
    expect(await forwardedEvent(store, runId)).toBeUndefined();
  });

  it('adds nothing to a resume that re-runs the stages before planning', async () => {
    // `--from sdd` re-runs discovery, impact and the SDD over this text. A discovery
    // agent handed "address every one of them in the plan you return" is being told to
    // do something it neither can nor owns.
    const { store, deps, runId, processRunner } = await rejectedRun();

    const outcome = await planFeature(deps, runId, 'Add recurring bookings', { from: 'sdd' });
    expect(outcome.ok).toBe(true);

    expect(everyPrompt(processRunner)).not.toContain(FINDINGS_SECTION_BEGIN);
    expect(await forwardedEvent(store, runId)).toBeUndefined();
  });
});

describe('a review that no longer describes the plan is not quoted (D14)', () => {
  it('forwards nothing when the review is bound to a different plan', async () => {
    // The `approve --force` path: a FAIL review a person deliberately overruled, whose
    // findings a later replan would hand back as mandatory work. `approval.ts` calls this
    // `review_stale`; forwarding it is the same mistake pointed the other way.
    const { store, deps, runId, processRunner } = await rejectedRun({ planHash: 'deadbeef' });

    const outcome = await revise(deps, runId, 'split TASK-002');
    expect(outcome.ok).toBe(true);

    const prompt = plannerPrompt(processRunner);
    expect(prompt).not.toContain(FINDINGS_SECTION_BEGIN);
    for (const anchor of ANCHORS) expect(prompt).not.toContain(anchor);

    const requested = (await eventsOf(store, runId)).find((e) => e.type === 'revision_requested');
    expect(requested?.detail['findingsForwarded']).toBe(0);
  });

  it('forwards nothing when the review carries no plan hash at all', async () => {
    // `feature --skip-review` writes no new artifact, so the previous plan's findings sit
    // there anchored at lines the current plan never had. An absent hash is treated as a
    // mismatch for the reason `approval.ts` gives: nothing connects such a review to the
    // plan in hand.
    const { store, deps, runId, processRunner } = await rejectedRun({ planHash: null });

    await planFeature(deps, runId, 'Add recurring bookings', { from: 'planning' });

    expect(everyPrompt(processRunner)).not.toContain(FINDINGS_SECTION_BEGIN);
    expect(await forwardedEvent(store, runId)).toBeUndefined();
  });

  it('POSITIVE CONTROL: the same run with a matching hash does forward', async () => {
    // The three tests above would all pass against a build that forwarded nothing ever.
    // This is the one that fails if the guard is turned into a refusal.
    const { store, deps, runId, processRunner } = await rejectedRun();

    await planFeature(deps, runId, 'Add recurring bookings', { from: 'planning' });

    for (const anchor of ANCHORS) expect(plannerPrompt(processRunner)).toContain(anchor);
    expect((await forwardedEvent(store, runId))?.detail['findingsForwarded']).toBe(2);
    // And the run says "forwarded" without also saying "withheld" — the two are answers
    // to the same question and must never both be on the record for one replan.
    expect(await withheldEvent(store, runId)).toBeUndefined();
  });
});

describe('a guard that withholds findings says so on the run (D14)', () => {
  // `plan.md`: *o produto sabe e não conta*. Each guard is correct; each was invisible.
  // The operator can see the findings in `reviews/plan-review.json` and had no way to
  // tell a replan that forwarded them from one that did not.

  it('names stale_review when the review is bound to a different plan', async () => {
    const { store, deps, runId } = await rejectedRun({ planHash: 'deadbeef' });

    await revise(deps, runId, 'split TASK-002');

    const withheld = await withheldEvent(store, runId);
    expect(withheld?.detail['reason']).toBe('stale_review');
    expect(withheld?.detail['findings']).toBe(2);
  });

  it('names unverifiable_review when the review carries no plan hash', async () => {
    const { store, deps, runId } = await rejectedRun({ planHash: null });

    await planFeature(deps, runId, 'Add recurring bookings', { from: 'planning' });

    const withheld = await withheldEvent(store, runId);
    expect(withheld?.detail['reason']).toBe('unverifiable_review');
    expect(withheld?.detail['findings']).toBe(2);
  });

  it('names request_changed when the operator retyped a different request', async () => {
    const { store, deps, runId } = await rejectedRun();

    await planFeature(deps, runId, 'Add recurring bookings AND invoicing', { from: 'planning' });

    const withheld = await withheldEvent(store, runId);
    expect(withheld?.detail['reason']).toBe('request_changed');
    expect(withheld?.detail['findings']).toBe(2);
  });

  it('names stage_before_planning when the resume re-runs earlier stages', async () => {
    // The caller's own gate wins over the artifact's freshness: with `--from sdd` the
    // review here is perfectly fresh, and "those stages run before planning" is still
    // the answer to the operator's question.
    const { store, deps, runId } = await rejectedRun();

    await planFeature(deps, runId, 'Add recurring bookings', { from: 'sdd' });

    const withheld = await withheldEvent(store, runId);
    expect(withheld?.detail['reason']).toBe('stage_before_planning');
    expect(withheld?.detail['findings']).toBe(2);
  });

  it('stays silent when there was nothing to withhold', async () => {
    // A PASS review and a run with no review are not withholdings. An event here would
    // be noise about a non-event, and a log that cries wolf is one nobody reads.
    const passing = await rejectedRun({ review: PASSING_REVIEW });
    await revise(passing.deps, passing.runId, 'split TASK-002');
    expect(await withheldEvent(passing.store, passing.runId)).toBeUndefined();

    const unreviewed = await rejectedRun({ review: null });
    await revise(unreviewed.deps, unreviewed.runId, 'split TASK-002');
    expect(await withheldEvent(unreviewed.store, unreviewed.runId)).toBeUndefined();
  });
});

describe('what the use case writes is what status reads back (D14)', () => {
  // The seam between the two halves of this defect. `status` renders
  // `lastReplanReport`'s answer, and the only way that line can be wrong while both
  // unit suites pass is if the writer and the reader disagree about the event — which
  // is exactly the drift a projection tested only against hand-built events invites.

  it('reads a revise that forwarded, which writes no replan_findings_forwarded event', async () => {
    const { store, deps, runId } = await rejectedRun();
    await revise(deps, runId, 'split TASK-002');

    expect(lastReplanReport(await store.readEvents(runId))).toEqual({
      kind: 'forwarded',
      findings: 2,
    });
  });

  it('reads a --from planning that forwarded', async () => {
    const { store, deps, runId } = await rejectedRun();
    await planFeature(deps, runId, 'Add recurring bookings', { from: 'planning' });

    expect(lastReplanReport(await store.readEvents(runId))).toEqual({
      kind: 'forwarded',
      findings: 2,
    });
  });

  it('reads each withholding with the reason the use case wrote', async () => {
    const stale = await rejectedRun({ planHash: 'deadbeef' });
    await revise(stale.deps, stale.runId, 'split TASK-002');
    expect(lastReplanReport(await stale.store.readEvents(stale.runId))).toEqual({
      kind: 'withheld',
      findings: 2,
      reason: 'stale_review',
    });

    const changed = await rejectedRun();
    await planFeature(changed.deps, changed.runId, 'Something else entirely', {
      from: 'planning',
    });
    expect(lastReplanReport(await changed.store.readEvents(changed.runId))).toEqual({
      kind: 'withheld',
      findings: 2,
      reason: 'request_changed',
    });
  });

  it('says nothing about a run that never replanned', async () => {
    const { store, runId } = await rejectedRun();
    expect(lastReplanReport(await store.readEvents(runId))).toBeUndefined();
  });
});

describe('the event is declared where vocabulary lives, not coined at the call site', () => {
  it('declares both replan events, and something emits each', () => {
    expect(STAGE_EVENT_TYPES).toContain('replan_findings_forwarded');
    expect(STAGE_EVENT_TYPES).toContain('replan_findings_withheld');

    const emitted = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.endsWith('.ts')) continue;
        for (const match of readFileSync(path, 'utf8').matchAll(
          /appendEvent\(\s*[^,]+,\s*'([a-z][a-z_]+)'/g,
        )) {
          emitted.add(match[1] ?? '');
        }
      }
    };
    walk(join(import.meta.dirname, '../../src'));

    expect(emitted.has('replan_findings_forwarded')).toBe(true);
    expect(emitted.has('replan_findings_withheld')).toBe(true);
  });
});
