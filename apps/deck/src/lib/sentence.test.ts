import { describe, expect, it } from 'vitest';
import { describe as say } from './sentence';
import { en, ptBR } from './i18n';

const at = '2026-09-04T14:31:21.212Z';

describe('describe', () => {
  it('says what a stage did, with how long it took', () => {
    expect(
      say({
        at,
        type: 'stage_completed',
        detail: { stage: 'architecture-impact', runner: 'r1', startedAt: '2026-09-04T00:00:56.185Z', finishedAt: '2026-09-04T00:04:37.560Z', repairs: 1 },
      }, en),
    ).toEqual({ title: 'architecture impact completed', detail: '3m 41s · r1 · 1 repair', tone: 'ok' });
  });

  it('reads a failure’s first problem rather than its code', () => {
    expect(say({ at, type: 'stage_failed', detail: { stage: 'planning', problems: ['two tasks declare one file'] } }, en)).toMatchObject({
      title: 'planning failed',
      detail: 'two tasks declare one file',
      tone: 'bad',
    });
  });

  it('carries a task’s finishing status verbatim and tones it once', () => {
    expect(say({ at, type: 'task_finished', detail: { task: 'TASK-002', status: 'review_required', runner: 'r1' } }, en)).toEqual({
      title: 'TASK-002 review required',
      detail: 'r1',
      tone: 'warn',
    });
  });

  it('marks a forced approval as forced', () => {
    expect(say({ at, type: 'run_approved', detail: { planHash: 'c9b3', taskCount: 11, forced: true } }, en)).toEqual({
      title: 'Plan approved · forced',
      detail: '11 tasks · c9b3',
      tone: 'warn',
    });
  });

  it('never drops a line it does not know', () => {
    expect(say({ at, type: 'brand_new_thing', detail: { task: 'TASK-001', count: 3, note: 'x' } }, en)).toEqual({
      title: 'brand new thing',
      detail: 'task: TASK-001 · count: 3 · note: x',
      tone: 'ghost',
    });
  });

  it('agrees with the noun it names, which a template could not', () => {
    /*
      `tarefa` is feminine and `estágio` is masculine, so `TASK-004 concluída` and
      `implementação concluído` are two different sentences. This is the assertion that
      keeps the dictionary's sentences functions rather than `${task} ${status}` fed from
      a word table that has to pick one gender for a chip.
    */
    expect(say({ at, type: 'task_finished', detail: { task: 'TASK-004', status: 'completed' } }, ptBR).title).toBe('TASK-004 concluída');
    expect(say({ at, type: 'task_finished', detail: { task: 'TASK-004', status: 'interrupted' } }, ptBR).title).toBe('TASK-004 interrompida');
    expect(say({ at, type: 'stage_completed', detail: { stage: 'implementation' } }, ptBR).title).toBe('implementação concluído');

    // The tone is the same answer in both languages: it is not language.
    expect(say({ at, type: 'task_finished', detail: { task: 'TASK-004', status: 'failed' } }, ptBR).tone).toBe(
      say({ at, type: 'task_finished', detail: { task: 'TASK-004', status: 'failed' } }, en).tone,
    );
  });

  it('renders a line it has never seen in whichever language it can', () => {
    // The fallback is the old behaviour — separators to spaces — so a status the table
    // has not learned reads as English rather than as nothing.
    expect(say({ at, type: 'brand_new_thing', detail: {} }, ptBR).title).toBe('brand new thing');
  });

  it('tells a forge failure from a forge success by its name', () => {
    expect(say({ at, type: 'forge_pr_created', detail: { number: 12, url: 'https://example.test/pr/12' } }, en)).toMatchObject({
      title: 'Forge · pr created',
      tone: 'idle',
    });
    expect(say({ at, type: 'forge_publish_failed', detail: {} }, en).tone).toBe('bad');
  });
});
