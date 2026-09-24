import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FailedAttemptSchema,
  RunUsageSchema,
  TaskAttemptResultSchema,
  TaskResultSchema,
  TelemetryEntrySchema,
} from '../../src/contracts/index.js';

/**
 * Turns and permission denials on the persisted usage record (P1.2, FR-005).
 *
 * `RunUsageSchema` is the one mirror that feeds `result.json`, both attempt artifacts and
 * the telemetry projection, and it is a plain `z.object` — so before this change a runner
 * that reported turns would have had them stripped on every write, silently. These tests
 * pin the two new fields, the strip that keeps `tool_input` out, and the old records that
 * must still read.
 */

const CANARY = 'TOOL-INPUT-CANARY-7f3a';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'legacy-artifacts');

const read = (relative: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, relative), 'utf8'));

describe('RunUsageSchema carries turns and permission denials (FR-005)', () => {
  it('keeps both fields and drops a denial input it was handed (AC-005, SEC-001)', () => {
    const parsed = RunUsageSchema.parse({
      turns: 2,
      permissionDenials: { count: 1, tools: ['Write'], tool_input: { content: CANARY } },
    });

    expect(parsed).toEqual({ turns: 2, permissionDenials: { count: 1, tools: ['Write'] } });
    expect(JSON.stringify(parsed)).not.toContain(CANARY);
  });

  it('is not strict: an unknown key inside permissionDenials is dropped, not rejected', () => {
    // Rejecting would drop a whole telemetry row (D10) and the count with it. The positive
    // control is the input itself: the key is there going in, and gone coming out.
    const input = { permissionDenials: { count: 0, tools: [], tool_use_id: 'toolu_1' } };
    expect(input.permissionDenials).toHaveProperty('tool_use_id');

    const result = RunUsageSchema.safeParse(input);

    expect(result.success).toBe(true);
    expect(result.data?.permissionDenials).not.toHaveProperty('tool_use_id');
  });

  it('accepts zero turns and an empty denial list, which are reports and not absences', () => {
    expect(RunUsageSchema.parse({ turns: 0, permissionDenials: { count: 0, tools: [] } })).toEqual({
      turns: 0,
      permissionDenials: { count: 0, tools: [] },
    });
  });

  it('ties no refinement between count and the tool names', () => {
    // A denial without a tool name is counted and not named (SDD design decision).
    expect(RunUsageSchema.safeParse({ permissionDenials: { count: 3, tools: ['Write'] } }).success).toBe(
      true,
    );
    expect(RunUsageSchema.safeParse({ permissionDenials: { count: 0, tools: ['Write'] } }).success).toBe(
      true,
    );
  });

  it.each([
    ['negative turns', { turns: -1 }],
    ['fractional turns', { turns: 1.5 }],
    ['a negative denial count', { permissionDenials: { count: -1, tools: [] } }],
    ['an empty tool name', { permissionDenials: { count: 1, tools: [''] } }],
  ])('rejects %s', (_label, usage) => {
    expect(RunUsageSchema.safeParse(usage).success).toBe(false);
  });

  it('survives the telemetry projection, which is where unknown keys used to be stripped', () => {
    const entry = TelemetryEntrySchema.parse({
      runId: 'AF-2026-001',
      kind: 'stage',
      stage: 'sdd',
      role: 'sdd',
      runner: 'claude',
      reasoning: 'high',
      startedAt: '2026-09-24T10:00:00.000Z',
      finishedAt: '2026-09-24T10:01:00.000Z',
      durationMs: 60000,
      status: 'completed',
      usage: { turns: 3, permissionDenials: { count: 2, tools: ['Write', 'Bash'] } },
    });

    expect(entry.usage).toEqual({ turns: 3, permissionDenials: { count: 2, tools: ['Write', 'Bash'] } });
  });
});

describe('records written before the change still read (NFR-002)', () => {
  const PRE_CHANGE_USAGE = {
    model: 'claude-opus-4-1',
    inputTokens: 2,
    outputTokens: 2709,
    cacheReadTokens: 31810,
    cacheWriteTokens: 0,
    costUsd: 0.41,
  };

  it('parses a usage record with neither new field to exactly its input', () => {
    expect(RunUsageSchema.parse(PRE_CHANGE_USAGE)).toEqual(PRE_CHANGE_USAGE);
  });

  it('reads a legacy result.json and attempt-<n>.json that carry no usage at all', () => {
    const result = read('tasks/TASK-001/result.json');
    const attempt = read('tasks/TASK-002/attempt-2.json');
    // Guards the assertions below: a fixture that already carried usage would prove nothing.
    expect(result).not.toHaveProperty('usage');
    expect(attempt).not.toHaveProperty('usage');

    expect(TaskResultSchema.parse(result).usage).toBeUndefined();
    expect(TaskAttemptResultSchema.parse(attempt).usage).toBeUndefined();
  });

  it('reads a pre-change result.json and attempt-<n>.json whose usage has tokens only', () => {
    const result = { ...(read('tasks/TASK-001/result.json') as object), usage: PRE_CHANGE_USAGE };
    const attempt = { ...(read('tasks/TASK-002/attempt-2.json') as object), usage: PRE_CHANGE_USAGE };

    expect(TaskResultSchema.parse(result).usage).toEqual(PRE_CHANGE_USAGE);
    expect(TaskAttemptResultSchema.parse(attempt).usage).toEqual(PRE_CHANGE_USAGE);
  });

  it('reads an attempt-<n>.failed.json with no usage key, as every one written so far has', () => {
    // No fixture exists for this artifact, so the shape `writeFailedAttempt` wrote before
    // this change is restated here: the same keys, and no `usage`.
    const failed = {
      run: 'AF-2026-002',
      task: 'TASK-002',
      attempt: 1,
      base: 'a'.repeat(40),
      branch: 'agent-flow/AF-2026-002-6c0e2b1f9a8d7c6b/TASK-002/attempt-1',
      workspace: 'agent-flow-ae32bc7780d0/AF-2026-002-6c0e2b1f9a8d7c6b/TASK-002/attempt-1',
      runner: 'agy',
      reasoning: 'medium',
      reasoningClamped: false,
      startedAt: '2026-08-17T14:47:20.075Z',
      finishedAt: '2026-08-17T14:48:41.000Z',
      failureClass: 'runner_execution_failed',
      runnerErrorCode: 'execution_failed',
      rawExcerpt: 'the process exited unexpectedly',
      repairAttempts: 1,
      consumedAttempt: true,
    };

    const parsed = FailedAttemptSchema.parse(failed);
    expect(parsed).not.toHaveProperty('usage');
  });
});
