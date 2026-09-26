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

  it('does not call one provider, recorded by an older run, a degradation', () => {
    // Runs from before 23/09/2026 logged `single_provider`; one provider is a choice.
    const legacy = { at, type: 'degradation_detected', detail: { kind: 'single_provider', reason: 'plan review on the same provider' } };
    expect(say(legacy, ptBR)).toEqual({ title: 'Um provedor para todos os papéis', tone: 'ghost' });
    // A real loss still reads as one.
    const fallback = { at, type: 'degradation_detected', detail: { kind: 'reasoning_clamped', reason: 'high → medium' } };
    expect(say(fallback, en).tone).toBe('warn');
  });

  it('reads a failure’s first problem rather than its code', () => {
    expect(say({ at, type: 'stage_failed', detail: { stage: 'planning', problems: ['two tasks declare one file'] } }, en)).toMatchObject({
      title: 'planning failed',
      detail: 'two tasks declare one file',
      tone: 'bad',
    });
  });

  it('puts a killed stage’s duration beside the limit it was killed at', () => {
    // `timeout` alone was the whole sentence, and it is the one failure where the two
    // numbers *are* the explanation: 15m against a 900s budget is a tight budget, 20s
    // against the same budget is a runner that died on contact.
    expect(
      say(
        {
          at,
          type: 'stage_failed',
          detail: { stage: 'discovery', errorCode: 'timeout', durationMs: 900_004, timeoutSeconds: 900 },
        },
        en,
      ),
    ).toEqual({ title: 'discovery failed', detail: 'timeout · 15m / 900s', tone: 'bad' });
  });

  it('says nothing about a budget the line did not carry', () => {
    // Positive control: the pair appears because the event carried it, never because the
    // renderer defaulted one. A fabricated `0ms / 0s` would be worse than silence.
    expect(
      say({ at, type: 'stage_failed', detail: { stage: 'planning', errorCode: 'invalid_output' } }, en),
    ).toEqual({ title: 'planning failed', detail: 'invalid_output', tone: 'bad' });
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

/**
 * P7.5 — a decision and an escalation are not revisions, and the feed must not number them.
 *
 * Both write `revision_requested` with `attemptedRevision` set to the count that did *not*
 * move. Read through the plain sentence, a decision at the ceiling of a standard run came out
 * as "Revision 2 requested" — a revision nobody asked for — and the obvious `+1` fix would
 * have said "3 of 2".
 */
describe('decisions and escalations in the feed', () => {
  const decision = {
    at,
    type: 'revision_requested',
    detail: { instruction: 'Keep the v1 endpoint.', from: 'planning', kind: 'decision', attemptedRevision: 2, maxAllowed: 2 },
  };

  it('says a decision was sent, with the count it left unchanged', () => {
    for (const [dict, sentence, count] of [
      [en, 'Decision sent to the planner', '2 of 2'],
      [ptBR, 'Decisão enviada ao planejador', '2 de 2'],
    ] as const) {
      const { title } = say(decision, dict);
      expect(title).toContain(sentence);
      expect(title).toContain(count);
      expect(title).not.toContain('Revision 2 requested');
      expect(title).not.toContain('Revisão 2 pedida');
      expect(title).not.toContain('3 of 2');
      expect(title).not.toContain('3 de 2');
    }
    expect(say(decision, en).title).toBe('Decision sent to the planner (revisions used: 2 of 2)');
    expect(say(decision, ptBR).title).toBe('Decisão enviada ao planejador (revisões usadas: 2 de 2)');
    expect(say(decision, en).detail).toBe('Keep the v1 endpoint.');
  });

  it('says a decision’s completion without numbering a revision', () => {
    const completed = { at, type: 'revision_completed', detail: { instruction: 'x', revisionCount: 2, kind: 'decision' } };
    expect(say(completed, en).title).toBe('Plan updated with the decision (revisions used: 2)');
    expect(say(completed, en).title).not.toContain('Revision');
  });

  it('names both classes of an escalation, and the new class’s ceiling', () => {
    const escalation = {
      at,
      type: 'revision_requested',
      detail: { instruction: 'Needs an SDD.', kind: 'escalation', attemptedRevision: 1, maxAllowed: 2, fromWorkflow: 'simple', toWorkflow: 'standard' },
    };
    expect(say(escalation, en).title).toBe('Escalated simple → standard (up to 2 revisions)');
    expect(say(escalation, ptBR).title).toContain(`${ptBR.words.simple} → ${ptBR.words.standard}`);

    const completed = { at, type: 'revision_completed', detail: { revisionCount: 1, kind: 'escalation', fromWorkflow: 'simple', toWorkflow: 'high-risk' } };
    // The class reached, which the classifier may have raised past the one asked for.
    expect(say(completed, en).title).toBe('Escalation completed simple → high risk');
  });

  it('reads a revision without a kind exactly as it always did', () => {
    // The positive control: every plain revise, and every run before this, carries no `kind`.
    const plain = { at, type: 'revision_requested', detail: { instruction: 'split the file', attemptedRevision: 2, maxAllowed: 2 } };
    expect(say(plain, en)).toEqual({ title: 'Revision 2 requested', detail: 'split the file', tone: 'warn' });
    expect(say(plain, ptBR).title).toBe('Revisão 2 pedida');
    expect(say({ at, type: 'revision_completed', detail: { revisionCount: 2 } }, en)).toEqual({ title: 'Revision 2 completed', tone: 'ok' });
  });

  it('says an amendment was recorded, by whom and about what', () => {
    const recorded = {
      at,
      type: 'amendment_recorded',
      detail: { id: 'AMD-003', kind: 'answer', task: 'TASK-002', actor: { kind: 'device', deviceId: 'dev_1', label: 'Office laptop' } },
    };
    expect(say(recorded, en)).toEqual({ title: 'Amendment AMD-003 recorded · answer', detail: 'TASK-002 · Office laptop', tone: 'idle' });
    expect(say(recorded, ptBR).title).toBe('Emenda AMD-003 registrada · resposta');
    // The device id is half a credential; the feed names the device by its label only.
    expect(say(recorded, en).detail).not.toContain('dev_1');

    const keyboard = { at, type: 'amendment_recorded', detail: { id: 'AMD-004', kind: 'decision', actor: { kind: 'keyboard' } } };
    expect(say(keyboard, en)).toEqual({ title: 'Amendment AMD-004 recorded · decision', detail: 'keyboard', tone: 'idle' });
  });
});
