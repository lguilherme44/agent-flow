import { describe, expect, it } from 'vitest';
import { describe as say } from './sentence';

const at = '2026-09-04T14:31:21.212Z';

describe('describe', () => {
  it('says what a stage did, with how long it took', () => {
    expect(
      say({
        at,
        type: 'stage_completed',
        detail: { stage: 'architecture-impact', runner: 'r1', startedAt: '2026-09-04T00:00:56.185Z', finishedAt: '2026-09-04T00:04:37.560Z', repairs: 1 },
      }),
    ).toEqual({ title: 'architecture impact completed', detail: '3m 41s · r1 · 1 repair', tone: 'ok' });
  });

  it('reads a failure’s first problem rather than its code', () => {
    expect(say({ at, type: 'stage_failed', detail: { stage: 'planning', problems: ['two tasks declare one file'] } })).toMatchObject({
      title: 'planning failed',
      detail: 'two tasks declare one file',
      tone: 'bad',
    });
  });

  it('carries a task’s finishing status verbatim and tones it once', () => {
    expect(say({ at, type: 'task_finished', detail: { task: 'TASK-002', status: 'review_required', runner: 'r1' } })).toEqual({
      title: 'TASK-002 review required',
      detail: 'r1',
      tone: 'warn',
    });
  });

  it('marks a forced approval as forced', () => {
    expect(say({ at, type: 'run_approved', detail: { planHash: 'c9b3', taskCount: 11, forced: true } })).toEqual({
      title: 'Plan approved · forced',
      detail: '11 tasks · c9b3',
      tone: 'warn',
    });
  });

  it('never drops a line it does not know', () => {
    expect(say({ at, type: 'brand_new_thing', detail: { task: 'TASK-001', count: 3, note: 'x' } })).toEqual({
      title: 'brand new thing',
      detail: 'task: TASK-001 · count: 3 · note: x',
      tone: 'ghost',
    });
  });

  it('tells a forge failure from a forge success by its name', () => {
    expect(say({ at, type: 'forge_pr_created', detail: { number: 12, url: 'https://example.test/pr/12' } })).toMatchObject({
      title: 'Forge · pr created',
      tone: 'idle',
    });
    expect(say({ at, type: 'forge_publish_failed', detail: {} }).tone).toBe('bad');
  });
});
