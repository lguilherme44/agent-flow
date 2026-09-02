import { describe, it, expect } from 'vitest';
import { deriveTaskRequirements } from '../../../src/core/team/requirements.js';
import { TaskSchema, type SkillId, type Task } from '../../../src/contracts/index.js';

/**
 * What a task needs, before any member is considered (M5-05, §14–§15).
 *
 * **The plan already answered most of this and is not asked twice.** `complexity`, `risk`
 * and `files.likely` are carried through untouched; a model classifying them again would
 * be a second answer to a settled question, and the second answer is the one that
 * eventually disagrees with the plan a person approved.
 *
 * Skills are the exception, inferred from three sources in a fixed order, and
 * `skillSources` is the field that makes the inference auditable: an operator reading it
 * can tell what they configured from what was guessed.
 */

function task(overrides: Partial<Task> = {}): Task {
  return TaskSchema.parse({
    id: 'TASK-003',
    title: 'Wire the endpoint',
    description: 'Some work.',
    complexity: 'complex',
    risk: 'high',
    dependencies: [],
    requirements: ['FR-001'],
    files: { likely: ['src/server/routes/run.ts'] },
    acceptanceCriteria: ['It compiles.'],
    validation: ['test'],
    ...overrides,
  });
}

const AREAS = new Map<string, readonly SkillId[]>([
  ['src/server/**', ['typescript', 'node'] as SkillId[]],
  ['apps/web/**', ['vue'] as SkillId[]],
]);

describe('what the plan already said', () => {
  it('carries complexity, risk and files through without reinterpreting them', () => {
    const derived = deriveTaskRequirements({ task: task(), role: 'executor.complex' });

    expect(derived.taskId).toBe('TASK-003');
    expect(derived.role).toBe('executor.complex');
    expect(derived.complexity).toBe('complex');
    expect(derived.risk).toBe('high');
    expect(derived.files).toEqual(['src/server/routes/run.ts']);
  });

  it('carries the router’s role rather than deciding one', () => {
    // One router, and this is not it.
    const derived = deriveTaskRequirements({ task: task(), role: 'executor.trivial' });
    expect(derived.role).toBe('executor.trivial');
  });
});

describe('skills from the planner’s own label', () => {
  it('reads scope, the field that has been on every task since MVP 1', () => {
    const derived = deriveTaskRequirements({ task: task({ scope: 'backend' }), role: 'executor.normal' });

    expect(derived.skills).toEqual(['backend']);
    expect(derived.skillSources['backend']).toBe('scope');
  });

  it('normalises what the operator wrote', () => {
    const derived = deriveTaskRequirements({ task: task({ scope: 'TypeScript' }), role: 'executor.normal' });
    expect(derived.skills).toEqual(['typescript']);
  });

  it('asks for nothing when the task has no scope', () => {
    const derived = deriveTaskRequirements({ task: task(), role: 'executor.normal' });
    expect(derived.skills).toEqual([]);
  });
});

describe('skills from where the work lands', () => {
  it('infers the owning area’s skills for a file inside it', () => {
    // **The inference that makes an ownership map worth more than a routing preference.**
    const derived = deriveTaskRequirements({
      task: task(),
      role: 'executor.normal',
      areaSkills: AREAS,
    });

    expect(derived.skills).toEqual(['typescript', 'node']);
    expect(derived.skillSources['typescript']).toBe('ownership');
  });

  it('infers nothing from an area the task does not touch', () => {
    // The guard this whole file exists for: without it, every task asks for every skill
    // any member declared, every candidate matches the same fraction, and the ranking
    // silently stops depending on where the work actually lands.
    const derived = deriveTaskRequirements({
      task: task({ files: { likely: ['docs/readme.md'] } }),
      role: 'executor.normal',
      areaSkills: AREAS,
    });

    expect(derived.skills).toEqual([]);
  });

  it('asks for both areas’ skills when a task spans two', () => {
    const derived = deriveTaskRequirements({
      task: task({ files: { likely: ['src/server/a.ts', 'apps/web/b.vue'] } }),
      role: 'executor.normal',
      areaSkills: AREAS,
    });

    expect([...derived.skills].sort()).toEqual(['node', 'typescript', 'vue']);
  });

  it('does not let a sibling directory match by prefix', () => {
    const derived = deriveTaskRequirements({
      task: task({ files: { likely: ['src/serverless.ts'] } }),
      role: 'executor.normal',
      areaSkills: AREAS,
    });

    expect(derived.skills).toEqual([]);
  });
});

describe('the advisory source fills gaps and never overrules (§15)', () => {
  it('adds a skill nothing else implied', () => {
    const derived = deriveTaskRequirements({
      task: task(),
      role: 'executor.normal',
      advisorySkills: ['sql'],
    });

    expect(derived.skills).toEqual(['sql']);
    expect(derived.skillSources['sql']).toBe('advisory');
  });

  it('leaves a skill the plan stated attributed to the plan', () => {
    // First source wins, and the order is scope → ownership → advisory. An operator
    // reading `skillSources` can tell configuration from guesswork by reading one field.
    const derived = deriveTaskRequirements({
      task: task({ scope: 'typescript' }),
      role: 'executor.normal',
      areaSkills: AREAS,
      advisorySkills: ['typescript'],
    });

    expect(derived.skills.filter((skill) => skill === 'typescript')).toHaveLength(1);
    expect(derived.skillSources['typescript']).toBe('scope');
  });

  it('leaves an area-implied skill attributed to the area', () => {
    const derived = deriveTaskRequirements({
      task: task(),
      role: 'executor.normal',
      areaSkills: AREAS,
      advisorySkills: ['typescript'],
    });

    expect(derived.skillSources['typescript']).toBe('ownership');
  });

  it('costs nothing when the utility model produced nothing', () => {
    // §15: a failure of the advisory model is an empty list, never a blocked assignment.
    const withNone = deriveTaskRequirements({
      task: task({ scope: 'backend' }),
      role: 'executor.normal',
      advisorySkills: [],
    });
    const without = deriveTaskRequirements({ task: task({ scope: 'backend' }), role: 'executor.normal' });

    expect(withNone).toEqual(without);
  });
});

describe('the result is deterministic', () => {
  it('gives the same answer for the same task twice', () => {
    const ask = (): unknown =>
      deriveTaskRequirements({
        task: task({ scope: 'backend' }),
        role: 'executor.normal',
        areaSkills: AREAS,
        advisorySkills: ['sql'],
      });

    expect(ask()).toEqual(ask());
  });

  it('orders skills by source, not by whichever map iterated first', () => {
    const derived = deriveTaskRequirements({
      task: task({ scope: 'backend' }),
      role: 'executor.normal',
      areaSkills: AREAS,
      advisorySkills: ['sql'],
    });

    expect(derived.skills).toEqual(['backend', 'typescript', 'node', 'sql']);
  });
});
