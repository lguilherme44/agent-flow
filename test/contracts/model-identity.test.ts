import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  MODEL_ID_MAX,
  modelIdentity,
  recordedModel,
} from '../../src/contracts/model-identity.js';
import {
  TaskResultSchema,
  TaskAttemptResultSchema,
} from '../../src/contracts/index.js';

/**
 * The one place an absent model becomes a sentence, and the states it refuses to invent.
 *
 * Every case below is a claim about what the *product may say*, not about formatting. The
 * blank-string case in particular is a defect this file exists to hold shut: the persisted
 * schemas allow `model: ""`, a reader guarding on `=== undefined` calls it present, and
 * the screen would then show an empty cell that reads as a rendering fault rather than as
 * "nothing recorded a model".
 */

const ROOT = resolve(import.meta.dirname, '../..');

describe('modelIdentity', () => {
  it('names the model when a record has one', () => {
    expect(modelIdentity({ runner: 'claude', model: 'claude-opus-5' })).toEqual({
      kind: 'model',
      model: 'claude-opus-5',
    });
  });

  it('reports nothing when no record has one', () => {
    expect(modelIdentity({})).toEqual({ kind: 'not_reported' });
  });

  it('refuses to narrate a runner default from a runner and no model', () => {
    // **The state that was deleted, asserted as deleted.** An earlier draft returned a
    // third kind here — "the invocation pinned no model, so the CLI chose" — which reads
    // as a measurement of something nothing measured. A runner present with no model can
    // mean the record is a *plan* (`plannedExecution` resolves without the member), or
    // that `runners.<id>.model` pinned a model no artifact sees, or that the
    // openai-compatible adapter sent the literal string `'default'`.
    expect(modelIdentity({ runner: 'claude' })).toEqual({ kind: 'not_reported' });
    expect(modelIdentity({ runner: 'agy' })).toEqual({ kind: 'not_reported' });

    // And the runner never leaks into the verdict, whatever it is called. A runner id in
    // a model slot is the one substitution Issue #21 forbids by name.
    for (const runner of ['claude', 'codex', 'agy', 'openai-compatible', 'anything']) {
      const identity = modelIdentity({ runner });
      expect(identity.kind, runner).toBe('not_reported');
      expect(JSON.stringify(identity), runner).not.toContain(runner);
    }
  });

  it('treats a blank model as an absence, because the schema admits one', () => {
    expect(modelIdentity({ runner: 'claude', model: '' })).toEqual({ kind: 'not_reported' });
    expect(modelIdentity({ runner: 'claude', model: '   ' })).toEqual({ kind: 'not_reported' });
    expect(modelIdentity({ runner: 'claude', model: '\t\n' })).toEqual({ kind: 'not_reported' });
  });

  it('proves the schemas really do admit a blank model, so the case above is not imaginary', () => {
    // A test written against a state the contract forbids is a test of nothing. This is
    // the positive control for the one above: `model: ""` parses, and the reader's
    // `=== undefined` guard would then project it as present.
    const attempt = {
      run: 'AF-2026-001',
      task: 'TASK-001',
      attempt: 1,
      base: 'a'.repeat(40),
      branch: 'af/task-001',
      workspace: '.',
      runner: 'claude',
      model: '',
      reasoning: 'medium',
      startedAt: '2026-09-04T12:00:00.000Z',
      finishedAt: '2026-09-04T12:01:00.000Z',
      agentReport: { status: 'COMPLETED' },
      validation: { expectation: 'pass', passed: true },
      validationJudgement: 'unsatisfied',
    };

    // **Asserted as a success, not as "no issue mentioned model".** The weaker form goes
    // green when the whole shape is refused for some unrelated reason, which is a test
    // that passes by looking at nothing.
    const parsedAttempt = TaskAttemptResultSchema.safeParse(attempt);
    expect(
      parsedAttempt.success ? [] : parsedAttempt.error.issues,
      'the attempt fixture does not parse, so this control proves nothing',
    ).toEqual([]);
    if (parsedAttempt.success) expect(parsedAttempt.data.model).toBe('');

    const parsedResult = TaskResultSchema.safeParse({
      task: 'TASK-001',
      status: 'completed',
      runner: 'claude',
      model: '',
      reasoning: 'medium',
      startedAt: '2026-09-04T12:00:00.000Z',
      finishedAt: '2026-09-04T12:01:00.000Z',
      validation: { passed: true, commands: [] },
    });
    expect(
      parsedResult.success ? [] : parsedResult.error.issues,
      'the result fixture does not parse, so this control proves nothing',
    ).toEqual([]);
    if (parsedResult.success) expect(parsedResult.data.model).toBe('');

    // And the reader's guard really is `=== undefined`, which is what makes a blank
    // string reach a screen as a present-but-empty model.
    expect(parsedResult.success && parsedResult.data.model === undefined).toBe(false);
  });

  it('bounds a pathological id rather than letting it reach a 244px card', () => {
    const long = 'x'.repeat(MODEL_ID_MAX * 4);
    const identity = modelIdentity({ runner: 'claude', model: long });

    expect(identity.kind).toBe('model');
    if (identity.kind !== 'model') return;
    expect(identity.model.length).toBe(MODEL_ID_MAX);
    expect(identity.model.endsWith('…')).toBe(true);
  });

  it('leaves a plausible id untouched, so the bound is not itself a lie', () => {
    // The longest real ids in this repository's own fixtures and docs are well inside the
    // bound. A cap that trimmed one of these would be a different kind of dishonesty.
    for (const model of [
      'claude-opus-5',
      'claude-sonnet-5',
      'gpt-5.6-sol',
      'gemini-3.1-pro-high',
      'qwen3.6-35b-a3b',
      'qwen2.5-coder:7b',
    ]) {
      expect(modelIdentity({ model })).toEqual({ kind: 'model', model });
    }
  });

  it('is not itself a place a provider name lives', () => {
    // The module's whole reason for being in `src/contracts` is that the browser may not
    // decide a model question from a runner name. A provider name appearing *here* would
    // move the defect rather than remove it.
    const source = readFileSync(resolve(ROOT, 'src/contracts/model-identity.ts'), 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

    for (const needle of ['claude', 'codex', 'gemini', 'anthropic', 'opus', 'sonnet', 'qwen']) {
      expect(code.toLowerCase(), `names ${needle}`).not.toContain(needle);
    }
  });

  it('imports nothing, so the dashboard can hold it without bundling zod', () => {
    // `apps/web` has no `zod` dependency and its Vite config states that every import
    // through the `@contracts` alias is type-only. A component importing this leaf for a
    // *value* is only safe while the leaf has no imports of its own — one `import` here
    // and the browser bundle silently grows a schema library.
    const source = readFileSync(resolve(ROOT, 'src/contracts/model-identity.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});

describe('recordedModel', () => {
  it('gives the id when there is one and nothing when there is not', () => {
    expect(recordedModel({ runner: 'claude', model: 'claude-opus-5' })).toBe('claude-opus-5');
    expect(recordedModel({ runner: 'claude' })).toBeUndefined();
    expect(recordedModel({ runner: 'claude', model: '  ' })).toBeUndefined();
  });
});
