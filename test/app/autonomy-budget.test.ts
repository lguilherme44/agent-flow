import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { StateStore } from '../../src/app/state-store.js';
import {
  recordAutonomousCall,
  recordCorrectiveRound,
  clearAutonomy,
  decideRunAutonomy,
} from '../../src/app/autonomy-budget.js';
import { GlobalConfigSchema } from '../../src/contracts/index.js';
import { DEFAULT_GLOBAL_CONFIG_YAML } from '../../src/config/defaults.js';
import { parse as parseYaml } from 'yaml';

/** The shipped defaults, so the suite measures the product rather than a literal. */
const RECOVERY = GlobalConfigSchema.parse(parseYaml(DEFAULT_GLOBAL_CONFIG_YAML)).recovery;

/**
 * C-22, the half nobody was keeping.
 *
 * `state.autonomy` holds the two run-level counters — corrective rounds used, and agent
 * calls made with no intervening human action. Both were **read and never written**.
 *
 * The consequences are not symmetric with the per-task budgets, which did work. Each task
 * bounded its own attempts, so no single task looped. What had no ceiling was the *run*:
 * `evaluateRound` compared `correctiveRoundsUsed` against `maxCorrectiveRounds` and always
 * saw 0, so a plan could produce corrective rounds indefinitely; and
 * `maxAutonomousModelCalls` — 24 by default, the whole point of which is that an unattended
 * run stops and asks — was never once compared against anything.
 *
 * C-22 says "any automatic recovery loop; when a budget in §6 is exhausted, the loop
 * terminates". Two of the three loops it names terminated only because a human was watching.
 */

const PROJECT = '/repo';

async function world() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const store = new StateStore({ fs, clock, projectDir: PROJECT });
  const run = await store.createRun('f');
  return { store, run };
}

describe('the run-level autonomy counters are actually kept', () => {
  it('counts an agent call made with no human action', async () => {
    const { store, run } = await world();

    await recordAutonomousCall(store, run.runId);
    await recordAutonomousCall(store, run.runId);

    expect((await store.loadRun(run.runId)).autonomy?.autonomousModelCalls).toBe(2);
  });

  it('counts a corrective round', async () => {
    const { store, run } = await world();

    await recordCorrectiveRound(store, run.runId);

    expect((await store.loadRun(run.runId)).autonomy?.correctiveRoundsUsed).toBe(1);
  });

  it('stamps when the grant began, and never re-stamps it', async () => {
    // `grantedAt` records when the envelope was first evaluated for this run. Moving it on
    // every increment would make "how long has this been running unattended" unanswerable.
    const { store, run } = await world();

    await recordAutonomousCall(store, run.runId);
    const first = (await store.loadRun(run.runId)).autonomy?.grantedAt;
    await recordAutonomousCall(store, run.runId);

    expect((await store.loadRun(run.runId)).autonomy?.grantedAt).toBe(first);
    expect(first).toBeDefined();
  });

  it('resets the unattended call count when a human acts', async () => {
    // The counter measures calls made *with no intervening human action*, which is the only
    // reading that makes a 24-call ceiling meaningful: a person who approved, revised or
    // retried has re-entered the loop, and the budget starts again from there.
    const { store, run } = await world();
    await recordAutonomousCall(store, run.runId);
    await recordAutonomousCall(store, run.runId);

    await clearAutonomy(store, run.runId);

    expect((await store.loadRun(run.runId)).autonomy?.autonomousModelCalls).toBe(0);
  });

  it('does not forget corrective rounds when a human acts', async () => {
    // The two counters answer different questions. Rounds already spent are spent — a human
    // approving the next one does not un-run the last one — while the unattended streak is
    // by definition broken by that approval.
    const { store, run } = await world();
    await recordCorrectiveRound(store, run.runId);
    await recordAutonomousCall(store, run.runId);

    await clearAutonomy(store, run.runId);

    const autonomy = (await store.loadRun(run.runId)).autonomy;
    expect(autonomy?.correctiveRoundsUsed).toBe(1);
    expect(autonomy?.autonomousModelCalls).toBe(0);
  });

  it('leaves a run that never went autonomous without the record at all', async () => {
    // Absent is not `{ correctiveRoundsUsed: 0 }`. A run that predates bounded corrective
    // autonomy never had the grant, and nothing may read one into it.
    const { store, run } = await world();

    expect((await store.loadRun(run.runId)).autonomy).toBeUndefined();
  });
});

/**
 * The enforcement, at the one place the machine decides to spend another call.
 */
describe('an unattended run stops when its budget is gone', () => {
  it('refuses to requeue once the run has spent its autonomous calls', async () => {
    const { store, run } = await world();

    // One under the ceiling: still allowed.
    const config = { ...RECOVERY, maxAutonomousModelCalls: 2 };
    for (let i = 0; i < 2; i += 1) await recordAutonomousCall(store, run.runId);

    const decision = decideRunAutonomy({
      counters: { autonomousModelCalls: 2, correctiveRoundsUsed: 0 },
      config,
    });

    expect(decision.mayProceedAutomatically).toBe(false);
    // C-22: never "something failed". One action, named.
    expect(decision.humanAction ?? '').not.toMatch(/inspect (the )?logs/i);
    expect((decision.humanAction ?? '').length).toBeGreaterThan(0);
  });

  it('allows the next call while the budget holds', async () => {
    const decision = decideRunAutonomy({
      counters: { autonomousModelCalls: 1, correctiveRoundsUsed: 0 },
      config: { ...RECOVERY, maxAutonomousModelCalls: 24 },
    });

    expect(decision.mayProceedAutomatically).toBe(true);
  });

  it('names the budget it exhausted, so the number is checkable', async () => {
    const decision = decideRunAutonomy({
      counters: { autonomousModelCalls: 24, correctiveRoundsUsed: 0 },
      config: { ...RECOVERY, maxAutonomousModelCalls: 24 },
    });

    expect(decision.exhaustedBudget).toBe('recovery.maxAutonomousModelCalls');
  });
});
