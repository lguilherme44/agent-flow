import { describe, it, expect } from 'vitest';
import {
  REQUIRED_SDD_SECTIONS,
  validateSdd,
  extractRequirementIds,
} from '../../src/core/sdd-validator.js';

const sectionsBlock = (omit: string[] = []): string =>
  REQUIRED_SDD_SECTIONS.filter((section) => !omit.includes(section))
    .map((section) => `## ${section}\n\nContent.\n`)
    .join('\n');

const validSdd = (): string =>
  `# Software Design Document\n\n${sectionsBlock()}`.replace(
    '## Functional Requirements\n\nContent.',
    '## Functional Requirements\n\n- FR-001: The system generates recurring bookings.\n- FR-002: Users can cancel one occurrence.',
  );

describe('required sections (§11)', () => {
  it('lists the twenty-one sections the spec mandates', () => {
    expect(REQUIRED_SDD_SECTIONS).toHaveLength(21);
    expect(REQUIRED_SDD_SECTIONS).toContain('Acceptance Criteria');
    expect(REQUIRED_SDD_SECTIONS).toContain('Testing Strategy');
  });

  it('accepts a complete document', () => {
    expect(validateSdd(validSdd())).toEqual([]);
  });

  it('names every missing section at once', () => {
    // Repairing one section per round trip would cost several calls.
    const problems = validateSdd(
      `# Software Design Document\n\n${sectionsBlock(['Security', 'Observability'])}`.replace(
        '## Functional Requirements\n\nContent.',
        '## Functional Requirements\n\n- FR-001: something',
      ),
    );

    expect(problems.join(' ')).toContain('Security');
    expect(problems.join(' ')).toContain('Observability');
  });

  it('ignores heading level and surrounding whitespace', () => {
    const document = REQUIRED_SDD_SECTIONS.map((section) => `### ${section}   \n\nx\n`)
      .join('\n')
      .replace('### Functional Requirements   \n\nx', '### Functional Requirements\n\n- FR-001: x');

    expect(validateSdd(document)).toEqual([]);
  });

  it('is case-insensitive about section names', () => {
    const document = REQUIRED_SDD_SECTIONS.map((section) => `## ${section.toUpperCase()}\n\nx\n`)
      .join('\n')
      .replace('## FUNCTIONAL REQUIREMENTS\n\nx', '## FUNCTIONAL REQUIREMENTS\n\n- FR-001: x');

    expect(validateSdd(document)).toEqual([]);
  });
});

describe('requirement ids (§40)', () => {
  it('requires at least one functional requirement', () => {
    // Without an FR there is nothing for the coverage check to verify, and the
    // plan cannot be tied back to anything.
    const problems = validateSdd(`# SDD\n\n${sectionsBlock()}`);
    expect(problems.join(' ')).toMatch(/FR-/);
  });

  it('extracts requirement ids of every kind', () => {
    const ids = extractRequirementIds(
      'FR-001 and NFR-002 plus SEC-003, with FR-001 repeated.',
    );
    expect(ids).toEqual(['FR-001', 'NFR-002', 'SEC-003']);
  });

  it('ignores malformed ids', () => {
    expect(extractRequirementIds('FR-1, FRR-001, fr-001, XX-001')).toEqual([]);
  });

  it('returns ids sorted and deduplicated', () => {
    expect(extractRequirementIds('SEC-002 FR-003 FR-001 FR-003')).toEqual([
      'FR-001',
      'FR-003',
      'SEC-002',
    ]);
  });
});

describe('empty input', () => {
  it('reports everything rather than throwing', () => {
    const problems = validateSdd('');
    expect(problems.length).toBeGreaterThan(0);
  });
});
