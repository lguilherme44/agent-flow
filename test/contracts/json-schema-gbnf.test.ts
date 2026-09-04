import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { expandClassEscapes, toJsonSchema } from '../../src/contracts/json-schema.js';
import { PlanSchema } from '../../src/contracts/plan.schema.js';

/**
 * GBNF — the grammar llama.cpp compiles a `pattern` into — has character classes
 * but no class escapes. A `\d` that reaches it does not mean "any digit": the
 * grammar fails to compile and the request comes back
 * `400 Failed to initialize samplers: failed to parse grammar`, before any token
 * is sampled. Measured, not assumed: `scripts/probe-schema.sh` in the FlowCanvas
 * experiment reproduces it against a real server.
 */
describe('expandClassEscapes', () => {
  it('rewrites a digit escape outside a character class', () => {
    expect(expandClassEscapes('^TASK-\\d{3}$')).toBe('^TASK-[0-9]{3}$');
  });

  it('rewrites a word escape', () => {
    expect(expandClassEscapes('^\\w+$')).toBe('^[A-Za-z0-9_]+$');
  });

  it('keeps an alternation group intact around the rewrite', () => {
    expect(expandClassEscapes('^(FR|NFR|SEC)-\\d{3}$')).toBe('^(FR|NFR|SEC)-[0-9]{3}$');
  });

  it('negates outside a class', () => {
    expect(expandClassEscapes('^\\D+$')).toBe('^[^0-9]+$');
  });

  // The two cases a global `.replace(/\\d/g, '[0-9]')` gets wrong.

  it('drops the brackets inside a character class, because they do not nest', () => {
    expect(expandClassEscapes('[\\d-]')).toBe('[0-9-]');
    expect(expandClassEscapes('[a-z\\d_]')).toBe('[a-z0-9_]');
  });

  it('leaves an escaped backslash alone — `\\\\d` is a backslash, then a `d`', () => {
    expect(expandClassEscapes('^\\\\d$')).toBe('^\\\\d$');
  });

  it('leaves escapes that are not character classes untouched', () => {
    expect(expandClassEscapes('^a\\.b\\/c$')).toBe('^a\\.b\\/c$');
  });

  it('leaves a negated escape inside a class alone rather than rewriting it wrong', () => {
    // No bracket-expression equivalent exists. Failing visibly beats a silent
    // rewrite to a different language.
    expect(expandClassEscapes('[\\D]')).toBe('[\\D]');
  });

  it('passes through a pattern that has no escapes', () => {
    expect(expandClassEscapes('^[a-z0-9][a-z0-9-]*$')).toBe('^[a-z0-9][a-z0-9-]*$');
  });

  it('handles a trailing lone backslash without dropping it', () => {
    expect(expandClassEscapes('abc\\')).toBe('abc\\');
  });
});

describe('toJsonSchema', () => {
  it('rewrites patterns nested in properties, items and anyOf', () => {
    const schema = toJsonSchema(
      z.object({
        id: z.union([z.string().regex(/^TASK-\d{3}$/), z.string().regex(/^FIX-\d{3}$/)]),
        tags: z.array(z.string().regex(/^\w+$/)),
      }),
    );

    expect(JSON.stringify(schema)).not.toContain('\\\\d');
    expect(JSON.stringify(schema)).not.toContain('\\\\w');
  });

  it('leaves the real PlanSchema free of class escapes', () => {
    // The schema that actually failed in run AF-2026-001. Six of its nine
    // patterns used `\d`.
    const serialised = JSON.stringify(toJsonSchema(PlanSchema));
    expect(serialised).not.toContain('\\\\d');
    expect(serialised).not.toContain('\\\\w');
    // and the rewrite must still be there, not the pattern removed
    expect(serialised).toContain('[0-9]');
  });
});
