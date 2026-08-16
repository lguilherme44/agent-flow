import { describe, it, expect } from 'vitest';
import { routeTask, explainRouting, DEFAULT_ROUTING_POLICY } from '../../src/core/router.js';
import { TaskSchema, type Task } from '../../src/contracts/index.js';

function task(overrides: Record<string, unknown> = {}): Task {
  return TaskSchema.parse({
    id: 'TASK-001',
    title: 'Do something',
    description: 'Something worth doing.',
    complexity: 'normal',
    risk: 'low',
    dependencies: [],
    requirements: ['FR-001'],
    acceptanceCriteria: ['It works.'],
    validation: [],
    ...overrides,
  });
}

describe('the truth table (§15)', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['trivial + low risk', { complexity: 'trivial', risk: 'low' }, 'executor.trivial'],
    ['trivial + medium risk', { complexity: 'trivial', risk: 'medium' }, 'executor.normal'],
    ['trivial + high risk', { complexity: 'trivial', risk: 'high' }, 'executor.complex'],
    ['normal + low risk', { complexity: 'normal', risk: 'low' }, 'executor.normal'],
    ['normal + medium risk', { complexity: 'normal', risk: 'medium' }, 'executor.normal'],
    ['normal + high risk', { complexity: 'normal', risk: 'high' }, 'executor.complex'],
    ['complex + low risk', { complexity: 'complex', risk: 'low' }, 'executor.complex'],
    ['complex + high risk', { complexity: 'complex', risk: 'high' }, 'executor.complex'],
  ];

  for (const [label, overrides, expected] of cases) {
    it(`routes ${label} to ${expected}`, () => {
      expect(routeTask(task(overrides))).toBe(expected);
    });
  }
});

describe('flags outrank complexity', () => {
  // A task the planner called trivial can still be the one that changes an
  // interface everything depends on. Complexity describes the writing; flags
  // describe the blast radius.
  const forcing = ['architectureDecision', 'crossModule', 'externalIntegration'] as const;

  for (const flag of forcing) {
    it(`routes a trivial task to complex when ${flag} is set`, () => {
      expect(routeTask(task({ complexity: 'trivial', risk: 'low', flags: { [flag]: true } }))).toBe(
        'executor.complex',
      );
    });
  }

  it('does not escalate on databaseChange alone', () => {
    // A migration is normal work in most repositories; the SDD decides whether
    // it is risky, and that arrives as `risk`.
    expect(
      routeTask(task({ complexity: 'normal', risk: 'low', flags: { databaseChange: true } })),
    ).toBe('executor.normal');
  });
});

describe('determinism', () => {
  it('returns the same role for the same task, every time', () => {
    // Reruns and resumes must not reshuffle which model does what — the audit
    // trail depends on the routing being reproducible.
    const subject = task({ complexity: 'normal', risk: 'medium' });
    const results = Array.from({ length: 20 }, () => routeTask(subject));
    expect(new Set(results).size).toBe(1);
  });

  it('ignores everything except classification', () => {
    const a = task({ id: 'TASK-001', title: 'One', complexity: 'normal', risk: 'low' });
    const b = task({ id: 'TASK-099', title: 'Another', complexity: 'normal', risk: 'low' });
    expect(routeTask(a)).toBe(routeTask(b));
  });
});

describe('configurable thresholds (§15)', () => {
  it('can escalate at medium risk instead of high', () => {
    const strict = { ...DEFAULT_ROUTING_POLICY, complexAtRisk: 'medium' as const };
    expect(routeTask(task({ complexity: 'normal', risk: 'medium' }), strict)).toBe(
      'executor.complex',
    );
  });

  it('can stop treating databaseChange-free trivia as risk-sensitive', () => {
    const relaxed = { ...DEFAULT_ROUTING_POLICY, trivialRequiresLowRisk: false };
    expect(routeTask(task({ complexity: 'trivial', risk: 'medium' }), relaxed)).toBe(
      'executor.trivial',
    );
  });

  it('can add a flag to the forcing set', () => {
    const policy = { ...DEFAULT_ROUTING_POLICY, complexFlags: ['databaseChange'] as const };
    expect(
      routeTask(task({ complexity: 'trivial', risk: 'low', flags: { databaseChange: true } }), policy),
    ).toBe('executor.complex');
  });
});

describe('explainRouting', () => {
  it('names the flag that forced the decision', () => {
    const explanation = explainRouting(
      task({ complexity: 'trivial', risk: 'low', flags: { crossModule: true } }),
    );
    expect(explanation).toContain('crossModule');
  });

  it('names risk when risk was the cause', () => {
    expect(explainRouting(task({ complexity: 'normal', risk: 'high' }))).toContain('high');
  });

  it('explains a trivial task held back by its risk', () => {
    expect(explainRouting(task({ complexity: 'trivial', risk: 'medium' }))).toMatch(
      /trivial but risk/i,
    );
  });

  it('falls back to complexity', () => {
    expect(explainRouting(task({ complexity: 'normal', risk: 'low' }))).toContain('normal');
    expect(explainRouting(task({ complexity: 'complex', risk: 'low' }))).toBe('complexity is complex');
  });
});
