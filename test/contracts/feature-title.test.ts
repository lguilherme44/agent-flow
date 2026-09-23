import { describe, it, expect } from 'vitest';
import { featureTitle } from '../../src/contracts/feature-title.js';

describe('featureTitle', () => {
  it('is the first non-empty line, without heading marks', () => {
    expect(featureTitle('\n\n## Incident 4821 — price differs\n\nlong body…')).toBe('Incident 4821 — price differs');
  });

  it('cuts a long first line at a word and says it was cut', () => {
    const title = featureTitle(`Incident 4821 ${'word '.repeat(60)}`, 40);
    expect(title.length).toBeLessThanOrEqual(41);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });

  it('leaves a short request as it is', () => {
    expect(featureTitle('Add a weekly recurrence')).toBe('Add a weekly recurrence');
  });

  it('is empty for an empty request, rather than inventing one', () => {
    expect(featureTitle('  \n  ')).toBe('');
  });
});
