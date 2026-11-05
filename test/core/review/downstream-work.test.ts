import { describe, it, expect } from 'vitest';
import {
  describeDownstream,
  failuresOwnedDownstream,
  type PlannedWork,
} from '../../../src/core/review/downstream-work.js';
import { failingPaths, failureRecords } from '../../../src/core/review/runner-output.js';

/**
 * Whose red is it.
 *
 * The case measured on 04/11/2026: TASK-001 adds a key to a list, `update-plan.dto.spec.ts`
 * iterates that list against a DTO whitelist, and the DTO belongs to TASK-002 — which
 * declares that very spec and depends on TASK-001. Five attempts across two prompts failed
 * on it, and nothing in the run said why.
 */

const PLAN: readonly PlannedWork[] = [
  {
    id: 'TASK-001',
    dependencies: [],
    files: {
      likely: [
        'api/src/modules/tenants/feature-flags.resolver.ts',
        'api/src/modules/tenants/feature-flags.resolver.spec.ts',
      ],
    },
  },
  {
    id: 'TASK-002',
    dependencies: ['TASK-001'],
    files: {
      likely: [
        'api/src/modules/plans/dto/update-plan.dto.ts',
        'api/src/modules/plans/dto/update-plan.dto.spec.ts',
      ],
    },
  },
  {
    id: 'TASK-003',
    dependencies: ['TASK-002'],
    files: { likely: ['api/src/modules/plans/connection.controller.spec.ts'] },
  },
];

const JEST_FAIL = [
  'FAIL src/modules/plans/dto/update-plan.dto.spec.ts',
  '  ● UpdatePlanDto.featureFlags › mantém toda chave de PLAN_FEATURE_FLAG_KEYS',
  '',
  'Tests:       1 failed, 3258 passed, 3275 total',
].join('\n');

describe('a failure that belongs to the next task', () => {
  it('names the task that owns the file, not the one being judged', () => {
    const owned = failuresOwnedDownstream({ taskId: 'TASK-001', tasks: PLAN, output: JEST_FAIL });

    expect(owned).toHaveLength(1);
    expect(owned[0]?.ownedBy).toBe('TASK-002');
    expect(owned[0]?.path).toContain('update-plan.dto.spec.ts');
  });

  it('reaches a task two hops away, because a plan routinely runs A to B to C', () => {
    const owned = failuresOwnedDownstream({
      taskId: 'TASK-001',
      tasks: PLAN,
      output: 'FAIL src/modules/plans/connection.controller.spec.ts',
    });

    expect(owned[0]?.ownedBy).toBe('TASK-003');
  });

  it('says it in one line, grouped by owner', () => {
    const line = describeDownstream(
      failuresOwnedDownstream({ taskId: 'TASK-001', tasks: PLAN, output: JEST_FAIL }),
    );

    expect(line).toContain('TASK-002');
    expect(line).toContain('update-plan.dto.spec.ts');
    expect(line).toContain('scoped to what it touches');
  });

  /**
   * The shape that killed the first version (measured 04/11/2026, second pass).
   *
   * In the Beahub plan TASK-002, TASK-003 and TASK-004 all depend on TASK-001 and on nothing
   * else: siblings. Asking "does TASK-002 depend on TASK-003" answers no, so a TASK-003
   * judged against a spec TASK-002 owns got no note at all — the exact silence this module
   * exists to break. The question was never about the graph; it is whether the work that
   * would make the file green is in the tree.
   */
  it('attributes to a SIBLING whose work has not landed', () => {
    const owned = failuresOwnedDownstream({
      taskId: 'TASK-003',
      tasks: PLAN,
      integrated: ['TASK-001'],
      output: JEST_FAIL,
    });

    expect(owned.map((f) => f.ownedBy)).toEqual(['TASK-002']);
  });
});


describe('what must NOT be attributed downstream', () => {
  it('keeps a failure in a file the task declares, even when a later task declares it too', () => {
    // The regression worth catching, and the only shape where the rule bites: a file both
    // tasks name is this task's to fix. Excusing it would be the defect this layer prevents.
    const shared: readonly PlannedWork[] = [
      PLAN[0] as PlannedWork,
      {
        id: 'TASK-002',
        dependencies: ['TASK-001'],
        // TASK-002 will touch the resolver spec too — it does not stop being TASK-001's.
        files: { likely: ['api/src/modules/tenants/feature-flags.resolver.spec.ts'] },
      },
    ];

    const owned = failuresOwnedDownstream({
      taskId: 'TASK-001',
      tasks: shared,
      output: 'FAIL src/modules/tenants/feature-flags.resolver.spec.ts',
    });

    expect(owned).toEqual([]);
  });

  it('keeps a failure in the task own file that no later task declares', () => {
    const owned = failuresOwnedDownstream({
      taskId: 'TASK-001',
      tasks: PLAN,
      output: 'FAIL src/modules/tenants/feature-flags.resolver.spec.ts',
    });

    expect(owned).toEqual([]);
  });

  it('keeps a failure nobody in the plan declared', () => {
    const owned = failuresOwnedDownstream({
      taskId: 'TASK-001',
      tasks: PLAN,
      output: 'FAIL src/modules/billing/billing.webhook.controller.spec.ts',
    });

    expect(owned).toEqual([]);
  });

  it('keeps a failure in the file of a task that already integrated', () => {
    // TASK-001's work is in the tree. A red in its file is this task's regression, and
    // handing it back would excuse exactly what is worth catching.
    const owned = failuresOwnedDownstream({
      taskId: 'TASK-003',
      tasks: PLAN,
      integrated: ['TASK-001'],
      output: 'FAIL src/modules/tenants/feature-flags.resolver.spec.ts',
    });

    expect(owned).toEqual([]);
  });

  it('says nothing when the suite is green', () => {
    const owned = failuresOwnedDownstream({
      taskId: 'TASK-001',
      tasks: PLAN,
      output: '✓ src/modules/plans/dto/update-plan.dto.spec.ts\nTests: 3275 passed',
    });

    expect(owned).toEqual([]);
    expect(describeDownstream(owned)).toBeUndefined();
  });

  it('says nothing when every other task has integrated', () => {
    const owned = failuresOwnedDownstream({
      taskId: 'TASK-003',
      tasks: PLAN,
      integrated: ['TASK-001', 'TASK-002'],
      output: JEST_FAIL,
    });

    expect(owned).toEqual([]);
  });
});

describe('o mesmo arquivo em duas grafias', () => {
  it('nomeia o spec uma vez so, mesmo que o runner o escreva de dois jeitos', () => {
    // Medido na TASK-003 (04/11/2026): o jest poe `FAIL src/x.spec.ts` no rotulo e
    // `at Object.<anonymous> (modules/x.spec.ts:59)` no stack. A nota saiu listando o
    // mesmo arquivo duas vezes porque a chave de deduplicacao era a string crua.
    const output = [
      'FAIL src/modules/plans/dto/update-plan.dto.spec.ts',
      '  ● whitelist keeps every key',
      '    at Object.<anonymous> (modules/plans/dto/update-plan.dto.spec.ts:59:40)',
    ].join('\n');

    const owned = failuresOwnedDownstream({ taskId: 'TASK-001', tasks: PLAN, output });

    expect(owned).toHaveLength(1);
    expect(owned[0]?.ownedBy).toBe('TASK-002');
  });

  it('mantem dois arquivos distintos do mesmo dono', () => {
    // O controle: deduplicar por arquivo nao pode virar deduplicar por dono.
    const output = [
      'FAIL src/modules/plans/dto/update-plan.dto.spec.ts',
      'FAIL src/modules/plans/dto/update-plan.dto.ts',
    ].join('\n');

    const owned = failuresOwnedDownstream({ taskId: 'TASK-001', tasks: PLAN, output });

    expect(owned).toHaveLength(2);
  });
});

describe('reading a runner output', () => {
  it('takes the path from a failure record and not from a passing line', () => {
    const output = [
      '✓ src/green.test.ts (4 tests)',
      'FAIL src/red.test.ts',
      '  ● it breaks',
    ].join('\n');

    expect(failingPaths(output)).toEqual(['src/red.test.ts']);
  });

  it('stops a record at the next one, so a pass below a FAIL is not swallowed', () => {
    const records = failureRecords(['FAIL a.test.ts', '✓ b.test.ts'].join('\n'));

    expect(records).toHaveLength(1);
    expect(records[0]).not.toContain('b.test.ts');
  });

  it('reads a TAP record, where the file sits under the mark', () => {
    const output = ['not ok 1 - doubles', '  ---', '  location: /repo/test/double.test.mjs:4:1'].join('\n');

    expect(failingPaths(output)).toContain('/repo/test/double.test.mjs');
  });

  it('reads through the colour a runner paints even into a pipe', () => {
    const esc = '\u001b';
    const output = `${esc}[31mFAIL${esc}[39m src/red.test.ts`;

    expect(failingPaths(output)).toEqual(['src/red.test.ts']);
  });

  it('is not fooled by a version, a host or a sentence with a dot', () => {
    const output = ['FAIL at v1.2 against example.com', '  Expected.Received mismatch'].join('\n');

    expect(failingPaths(output)).toEqual([]);
  });

  it('matches a plan path against the shorter one a rooted runner prints', () => {
    // The plan says `api/src/...`; jest run inside `api/` prints `src/...`.
    const owned = failuresOwnedDownstream({
      taskId: 'TASK-001',
      tasks: PLAN,
      output: 'FAIL src/modules/plans/dto/update-plan.dto.spec.ts',
    });

    expect(owned[0]?.ownedBy).toBe('TASK-002');
  });
});
