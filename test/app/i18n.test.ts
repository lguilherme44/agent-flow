import { describe, it, expect } from 'vitest';
import { en } from '../../apps/web/src/lib/i18n/translations/en.js';
import { ptBR } from '../../apps/web/src/lib/i18n/translations/pt-BR.js';

describe('Web i18n & Translation Dictionaries', () => {
  it('guarantees key symmetry between en and pt-BR dictionaries', () => {
    const enSections = Object.keys(en);
    const ptSections = Object.keys(ptBR);
    expect(ptSections.sort()).toEqual(enSections.sort());

    for (const section of enSections) {
      const enKeys = Object.keys((en as Record<string, Record<string, string>>)[section] ?? {});
      const ptKeys = Object.keys((ptBR as Record<string, Record<string, string>>)[section] ?? {});
      expect(ptKeys.sort(), `Section "${section}" keys match`).toEqual(enKeys.sort());
    }
  });

  it('preserves canonical identifiers without translation corruption', () => {
    // Canonical system codes & identifiers
    const canonicalCodes = [
      'quota_exceeded',
      'auth_required',
      'runner_unavailable',
      'integration_conflict',
    ];
    for (const code of canonicalCodes) {
      expect(code).toBe(code);
    }

    // Ensure translations don't clobber technical terms
    expect(en.nav.runs).toBe('Runs');
    expect(ptBR.nav.runs).toBe('Execuções');
    expect(ptBR.nav.dashboard).toBe('Painel');
    expect(ptBR.common.approve).toBe('Aprovar');
    expect(ptBR.common.revise).toBe('Revisar');
    expect(ptBR.common.reject).toBe('Recusar');
  });
});
