import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the planner is told, held to what the orchestrator will do with its answer.
 *
 * `core/acceptance.ts` fails a task whose tree did not change unless the plan declared
 * `expectsNoChange: true` — a decision made in the evidence run, where three tasks did
 * nothing and were recorded done. The field was in the schema, in the executor and in the
 * refusal message, and in **none of the three planning prompts**: the planner could not
 * declare what it had never been told existed, so every verification task it wrote was
 * refused on its first attempt, recovered, refused again, and escalated. `AF-2026-006`
 * stalled there for a day. A rule nobody is told is a rule nobody can follow.
 */
const PROMPTS = join(import.meta.dirname, '../../prompts');
const PLANNING_PROMPTS = ['planning.md', 'planning-simple.md', 'planning-trivial.md'];

describe('the planning prompts name every field acceptance will hold the plan to', () => {
  for (const name of PLANNING_PROMPTS) {
    it(`${name} tells the planner about expectsNoChange, and shows it in the output shape`, () => {
      const text = readFileSync(join(PROMPTS, name), 'utf8');
      // Explained, not merely listed: the planner has to know *when* to set it.
      expect(text).toMatch(/expectsNoChange/);
      expect(text).toMatch(/unchanged|change nothing|changing nothing/i);
      // And present in the JSON the prompt asks for, so the shape the planner copies has it.
      expect(text).toMatch(/"expectsNoChange": false/);
    });
  }

  it('spells the field exactly as the schema and the refusal do', () => {
    const schema = readFileSync(join(import.meta.dirname, '../../src/contracts/task.schema.ts'), 'utf8');
    const acceptance = readFileSync(join(import.meta.dirname, '../../src/core/acceptance.ts'), 'utf8');
    expect(schema).toMatch(/expectsNoChange: z\.boolean\(\)\.optional\(\)/);
    expect(acceptance).toMatch(/declare expectsNoChange: true in the plan/);
  });

  it('planning.md states the file-contention rule the checks enforce', () => {
    // The checks refuse two independent tasks that declare one file. Five of the seven
    // planning refusals on the machine this was written on were exactly that, and the
    // prompt did not mention it.
    const text = readFileSync(join(PROMPTS, 'planning.md'), 'utf8');
    expect(text).toMatch(/must not declare the same file/);
  });
});
