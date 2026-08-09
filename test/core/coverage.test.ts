import { describe, it, expect } from 'vitest';
import { checkCoverage } from '../../src/core/coverage.js';

type Task = { id: string; requirements: string[] };

const task = (id: string, requirements: string[]): Task => ({ id, requirements });

describe('coverage of functional requirements (§41)', () => {
  it('passes when every functional requirement has a task', () => {
    const result = checkCoverage({ declared: ['FR-001', 'FR-002'] }, [
      task('TASK-001', ['FR-001']),
      task('TASK-002', ['FR-002']),
    ]);

    expect(result.ok).toBe(true);
    expect(result.uncoveredRequirements).toEqual([]);
  });

  it('names requirements that no task implements', () => {
    // The exact check the spec asks the reviewer to perform — done as code, so
    // it costs nothing and cannot be talked out of.
    const result = checkCoverage({ declared: ['FR-001', 'FR-004'] }, [
      task('TASK-001', ['FR-001']),
    ]);

    expect(result.ok).toBe(false);
    expect(result.uncoveredRequirements).toEqual(['FR-004']);
  });

  it('counts a requirement covered by several tasks once', () => {
    const result = checkCoverage({ declared: ['FR-001'] }, [
      task('TASK-001', ['FR-001']),
      task('TASK-002', ['FR-001']),
    ]);
    expect(result.ok).toBe(true);
  });

  it('fails an empty plan against a non-empty SDD', () => {
    const result = checkCoverage({ declared: ['FR-001'] }, []);
    expect(result.uncoveredRequirements).toEqual(['FR-001']);
  });
});

describe('non-functional and security requirements', () => {
  it('accepts a task citing an NFR the SDD defines', () => {
    // Found end-to-end: a real plan cited NFR-003 and SEC-001, both defined in
    // the SDD, and was rejected as referencing undefined requirements. Coverage
    // and existence are different questions and were being answered by one set.
    const result = checkCoverage({ declared: ['FR-001', 'NFR-003', 'SEC-001'] }, [
      task('TASK-001', ['FR-001', 'NFR-003', 'SEC-001']),
    ]);

    expect(result.ok).toBe(true);
    expect(result.unknownRequirements).toEqual([]);
  });

  it('does not demand a dedicated task per NFR', () => {
    // "Responses stay under 200ms" is cross-cutting. Requiring a task for it
    // would push planners into inventing filler work to satisfy the check.
    const result = checkCoverage({ declared: ['FR-001', 'NFR-001', 'SEC-001'] }, [
      task('TASK-001', ['FR-001']),
    ]);

    expect(result.ok).toBe(true);
    expect(result.uncoveredRequirements).toEqual([]);
  });

  it('still rejects a citation of an NFR that does not exist', () => {
    const result = checkCoverage({ declared: ['FR-001', 'NFR-001'] }, [
      task('TASK-001', ['FR-001', 'NFR-099']),
    ]);

    expect(result.ok).toBe(false);
    expect(result.unknownRequirements).toEqual([{ task: 'TASK-001', requirement: 'NFR-099' }]);
  });

  it('honours an explicit mustBeCovered set', () => {
    const result = checkCoverage(
      { declared: ['FR-001', 'SEC-001'], mustBeCovered: ['FR-001', 'SEC-001'] },
      [task('TASK-001', ['FR-001'])],
    );
    expect(result.uncoveredRequirements).toEqual(['SEC-001']);
  });
});

describe('hallucinated requirements', () => {
  it('names tasks referring to requirements that do not exist', () => {
    const result = checkCoverage({ declared: ['FR-001'] }, [
      task('TASK-001', ['FR-001']),
      task('TASK-002', ['FR-099']),
    ]);

    expect(result.unknownRequirements).toEqual([{ task: 'TASK-002', requirement: 'FR-099' }]);
  });

  it('reports both kinds of gap together', () => {
    const result = checkCoverage({ declared: ['FR-001', 'FR-002'] }, [
      task('TASK-001', ['FR-003']),
    ]);

    expect(result.uncoveredRequirements).toEqual(['FR-001', 'FR-002']);
    expect(result.unknownRequirements).toHaveLength(1);
  });

  it('produces a message naming the orphans', () => {
    const result = checkCoverage({ declared: ['FR-004'] }, [task('TASK-001', ['FR-009'])]);
    expect(result.problems.join(' ')).toContain('FR-004');
    expect(result.problems.join(' ')).toContain('FR-009');
    expect(result.problems.join(' ')).toContain('TASK-001');
  });
});
