import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeDownstream,
  failuresOwnedDownstream,
} from '../../../src/core/review/downstream-work.js';

/**
 * The rule against the run that produced it, not against a fixture.
 *
 * A fixture written by whoever wrote the rule inherits the rule's assumptions: both can be
 * wrong together and the green is mutual. That is exactly how the `doctor` gate note passed
 * its unit tests and did nothing in production — it compared for equality because the fixture
 * I typed had equal strings, and no real config ever does.
 *
 * So these two files are copies, byte for byte: `plan.json` as Agent Flow wrote it for the
 * Beahub run AF-2026-001, and the jest output of the attempt that failed five times.
 */

const here = join(import.meta.dirname, 'fixtures', 'af-2026-001');
const plan = JSON.parse(readFileSync(join(here, 'plan.json'), 'utf8')) as {
  tasks: { id: string; dependencies: string[]; files: { likely: string[] } }[];
};
const output = readFileSync(join(here, 'task-001-failing-output.txt'), 'utf8');

describe('the real run AF-2026-001', () => {
  it('attributes the failure that reprieved TASK-001 five times to TASK-002', () => {
    const owned = failuresOwnedDownstream({ taskId: 'TASK-001', tasks: plan.tasks, output });

    expect(owned.map((f) => f.ownedBy)).toContain('TASK-002');
    expect(owned.some((f) => f.path.includes('update-plan.dto.spec.ts'))).toBe(true);
  });

  it('says it in a line that names the owner and the file', () => {
    const line = describeDownstream(
      failuresOwnedDownstream({ taskId: 'TASK-001', tasks: plan.tasks, output }),
    );

    expect(line).toBeDefined();
    expect(line).toContain('TASK-002');
    expect(line).toContain('update-plan.dto.spec.ts');
  });

  it('stays silent for the task that owns the file', () => {
    // Judging TASK-002, that spec is its own work: nothing to hand downstream.
    const owned = failuresOwnedDownstream({ taskId: 'TASK-002', tasks: plan.tasks, output });

    expect(owned).toEqual([]);
  });
});
