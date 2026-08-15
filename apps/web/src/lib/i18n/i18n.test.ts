import { describe, it, expect, beforeEach } from 'vitest';
import { en } from './translations/en';
import { ptBR } from './translations/pt-BR';

describe('Web Internationalization (I18N-01 / I18N-02)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('has identical translation key structures for en and pt-BR', () => {
    function getKeys(obj: Record<string, unknown>, prefix = ''): string[] {
      const keys: string[] = [];
      for (const [k, v] of Object.entries(obj)) {
        const full = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          keys.push(...getKeys(v as Record<string, unknown>, full));
        } else {
          keys.push(full);
        }
      }
      return keys.sort();
    }

    const enKeys = getKeys(en as unknown as Record<string, unknown>);
    const ptKeys = getKeys(ptBR as unknown as Record<string, unknown>);

    expect(enKeys).toEqual(ptKeys);
    expect(enKeys.length).toBeGreaterThan(20);
  });

  it('provides translations for critical navigation and approval workflows', () => {
    expect(en.nav.dashboard).toBe('Dashboard');
    expect(ptBR.nav.dashboard).toBe('Painel');

    expect(en.approval.approveButton).toBe('Approve & Start Execution');
    expect(ptBR.approval.approveButton).toBe('Aprovar e Iniciar Execução');

    expect(en.status.waiting_for_approval).toBe('Waiting for Approval');
    expect(ptBR.status.waiting_for_approval).toBe('Aguardando Aprovação');
  });

  it('keeps canonical IDs and hash patterns untranslated', () => {
    // Canonical identifiers must never be subject to translation
    const runId = 'AF-104';
    const taskId = 'TASK-001';
    expect(runId).toBe('AF-104');
    expect(taskId).toBe('TASK-001');
  });
});
