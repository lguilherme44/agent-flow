import { describe, it, expect } from 'vitest';
import { evaluateEnvelope, evaluateRound } from '../../src/core/corrective-envelope.js';

/**
 * AD-46 and C-18 (AR-05b) — what approval already authorised.
 *
 * `runCorrectiveRound` cleared `approved` unconditionally, for a good reason: the human
 * approved a set of tasks and a corrective round is a different set. AD-46's claim is that
 * "different set" is *measurable*, and that a fix which touches only files this run has
 * already changed, cites only requirements the SDD already declares, adds no contract and
 * adds no validation id is not a different agreement — it is the same agreement, executed
 * correctly.
 *
 * **The envelope can only ever narrow what a human approved.** It never widens anything,
 * it is decided by set arithmetic rather than by judgement, and every evaluation is
 * persisted so a run can always show why it did not ask.
 */

const base = {
  touchedFiles: ['src/cli/index.ts', 'test/cli/cli.test.ts', 'README.md'],
  declaredRequirements: ['FR-001', 'FR-002', 'NFR-004'],
  declaredValidationIds: ['test', 'lint'],
  contractPaths: ['src/contracts/'],
};

const task = (overrides: Record<string, unknown> = {}) => ({
  id: 'FIX-001',
  files: ['test/cli/cli.test.ts'],
  requirements: ['FR-002'],
  validation: ['test'],
  ...overrides,
});

describe('one corrective task against the envelope (AD-46)', () => {
  it('admits a fix confined to files this run already changed', () => {
    const verdict = evaluateEnvelope(task(), base);

    expect(verdict.inside).toBe(true);
    expect(verdict.reason).toMatch(/already|touched|inside/i);
  });

  it('refuses a fix that reaches a file the run never touched', () => {
    const verdict = evaluateEnvelope(task({ files: ['src/brand-new.ts'] }), base);

    expect(verdict.inside).toBe(false);
    expect(verdict.failed).toBe('files');
    expect(verdict.detail).toContain('src/brand-new.ts');
  });

  it('refuses a fix citing a requirement the SDD never declared', () => {
    const verdict = evaluateEnvelope(task({ requirements: ['FR-999'] }), base);

    expect(verdict.inside).toBe(false);
    expect(verdict.failed).toBe('requirements');
    expect(verdict.detail).toContain('FR-999');
  });

  it('refuses a fix that introduces a contract file', () => {
    // Condition 3 is its own rule rather than a special case of condition 1: a contract is
    // the shape everything else agrees on, and adding one is a change to the agreement
    // however small the diff.
    const verdict = evaluateEnvelope(
      task({ files: ['src/contracts/new.schema.ts'] }),
      base,
    );

    expect(verdict.inside).toBe(false);
    expect(verdict.failed).toBe('contract');
  });

  it('admits a change to a contract file the run already touched', () => {
    // "Introduces no *new* file under a contract path". Editing one the run already
    // changed is inside the same agreement.
    const verdict = evaluateEnvelope(task({ files: ['src/contracts/task.schema.ts'] }), {
      ...base,
      touchedFiles: [...base.touchedFiles, 'src/contracts/task.schema.ts'],
    });

    expect(verdict.inside).toBe(true);
  });

  it('refuses a fix that declares a validation id the project does not have', () => {
    const verdict = evaluateEnvelope(task({ validation: ['e2e'] }), base);

    expect(verdict.inside).toBe(false);
    expect(verdict.failed).toBe('validation');
    expect(verdict.detail).toContain('e2e');
  });

  it('admits a task that declares no files, because it claims nothing', () => {
    // An empty `files.likely` is "the plan did not say". It cannot be outside a set it
    // makes no claim about, and the AD-38 scope assertion is what judges it afterwards.
    expect(evaluateEnvelope(task({ files: [] }), base).inside).toBe(true);
  });

  it('reports the first condition that failed, not a list', () => {
    // One reason, so the escalation names one thing to look at. Conditions are ordered
    // most-structural first: a contract addition is a bigger fact than a stray file.
    const verdict = evaluateEnvelope(
      task({ files: ['src/contracts/new.schema.ts'], requirements: ['FR-999'] }),
      base,
    );

    expect(verdict.failed).toBe('contract');
  });

  it('records a reason whichever way it goes, because the evaluation is persisted', () => {
    for (const candidate of [task(), task({ files: ['nowhere.ts'] })]) {
      expect(evaluateEnvelope(candidate, base).reason.length).toBeGreaterThan(0);
    }
  });
});

describe('the round as a whole (C-18, I-25)', () => {
  const budget = { correctiveRoundsUsed: 0, maxCorrectiveRounds: 2 };

  it('proceeds without clearing approval when every task is inside', () => {
    const round = evaluateRound([task(), task({ id: 'FIX-002' })], base, budget);

    expect(round.mayProceed).toBe(true);
    expect(round.clearsApproval).toBe(false);
    expect(round.evaluations).toHaveLength(2);
  });

  it('puts the whole round back through approval when one task is outside', () => {
    // Not just the offending task: AD-46 says any failure puts the *round* back, because
    // the tasks were generated together against one set of findings.
    const round = evaluateRound(
      [task(), task({ id: 'FIX-002', files: ['src/elsewhere.ts'] })],
      base,
      budget,
    );

    expect(round.mayProceed).toBe(false);
    expect(round.clearsApproval).toBe(true);
    expect(round.outside?.id).toBe('FIX-002');
    expect(round.outside?.failed).toBe('files');
  });

  it('names which task and which condition, so the report is actionable', () => {
    const round = evaluateRound([task({ requirements: ['FR-404'] })], base, budget);

    expect(round.reason).toContain('FIX-001');
    expect(round.reason).toContain('FR-404');
  });

  it('stops when the corrective budget is exhausted, whatever the envelope says', () => {
    // The budget is condition 5 and it applies to the round rather than to a task. An
    // envelope full of inside-tasks does not buy another round.
    const round = evaluateRound([task()], base, {
      correctiveRoundsUsed: 2,
      maxCorrectiveRounds: 2,
    });

    expect(round.mayProceed).toBe(false);
    expect(round.exhausted).toBe(true);
    expect(round.humanAction).toBeDefined();
  });

  it('persists an evaluation per task, including the ones that passed', () => {
    // "The envelope evaluation is persisted per task with the reason it passed" — C-18.
    // A record of only the refusals cannot answer "why did this not ask me".
    const round = evaluateRound([task(), task({ id: 'FIX-002' })], base, budget);

    expect(round.evaluations.map((entry) => entry.id)).toEqual(['FIX-001', 'FIX-002']);
    expect(round.evaluations.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it('clears approval for an empty round rather than proceeding on nothing', () => {
    // Defensive: a round with no tasks has nothing to authorise, and "every task is
    // inside" is vacuously true of an empty set — which is exactly the shape that turns a
    // guard into a bypass.
    const round = evaluateRound([], base, budget);

    expect(round.mayProceed).toBe(false);
  });
});
