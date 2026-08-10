import { describe, it, expect } from 'vitest';
import {
  buildValidationRegistry,
  unknownValidationIds,
} from '../../src/core/validation-registry.js';
import { ProjectConfigSchema, TaskSchema } from '../../src/contracts/index.js';

const project = (overrides: Record<string, unknown> = {}) =>
  ProjectConfigSchema.parse({
    project: { name: 'x', type: 'node' },
    commands: { lint: 'npm run lint', test: 'npm test' },
    ...overrides,
  });

describe('the standard steps are referenceable by name', () => {
  it('exposes only the steps the project actually declares', () => {
    const registry = buildValidationRegistry(project());
    expect(registry.ids).toEqual(['lint', 'test']);
  });

  it('resolves an id to the configured command', () => {
    expect(buildValidationRegistry(project()).resolve('test')).toBe('npm test');
  });

  it('ignores a step configured as an empty string', () => {
    const registry = buildValidationRegistry(project({ commands: { test: '  ', lint: 'x' } }));
    expect(registry.ids).toEqual(['lint']);
  });

  it('is empty for a project with no configuration at all', () => {
    const registry = buildValidationRegistry(undefined);
    expect(registry.ids).toEqual([]);
    expect(registry.has('test')).toBe(false);
  });
});

describe('projects can declare extra ids', () => {
  it('adds them alongside the standard steps', () => {
    const registry = buildValidationRegistry(
      project({ validationCommands: { recurrence: 'npm test -- recurrence' } }),
    );

    expect(registry.ids).toEqual(['lint', 'recurrence', 'test']);
    expect(registry.resolve('recurrence')).toBe('npm test -- recurrence');
  });

  it('lets a project narrow a standard step under the same id', () => {
    const registry = buildValidationRegistry(
      project({ validationCommands: { test: 'npm test -- --changed' } }),
    );
    expect(registry.resolve('test')).toBe('npm test -- --changed');
  });
});

describe('unknownValidationIds', () => {
  const task = (id: string, validation: string[]) =>
    TaskSchema.parse({
      id,
      title: 't',
      description: 'd',
      complexity: 'normal',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['ok'],
      validation,
    });

  it('accepts ids the project declares', () => {
    const registry = buildValidationRegistry(project());
    expect(unknownValidationIds(registry, [task('TASK-001', ['test', 'lint'])])).toEqual([]);
  });

  it('names the task and the id that does not exist', () => {
    // A planner inventing a step would otherwise produce a task that validates
    // nothing while appearing to.
    const registry = buildValidationRegistry(project());
    expect(unknownValidationIds(registry, [task('TASK-002', ['e2e'])])).toEqual([
      { task: 'TASK-002', id: 'e2e' },
    ]);
  });

  it('reports every unknown id across every task', () => {
    const registry = buildValidationRegistry(project());
    const found = unknownValidationIds(registry, [
      task('TASK-001', ['test', 'smoke']),
      task('TASK-002', ['bench']),
    ]);

    expect(found).toHaveLength(2);
  });
});
