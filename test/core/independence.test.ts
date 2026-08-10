import { describe, it, expect } from 'vitest';
import { assessIndependence, explainIndependence } from '../../src/core/independence.js';

/**
 * The provider half of AF-R01.
 *
 * The pipeline suite covers the fallback case, because that needs a pipeline.
 * This one needs nothing but a configuration — and that is the point: it never
 * required a fallback, a failure, or anything unusual to happen.
 */
const PROVIDERS: Record<string, string> = {
  claude: 'claude-code-cli',
  claudeBackup: 'claude-code-cli',
  codex: 'codex-cli',
};
const providerOf = (id: string): string | undefined => PROVIDERS[id];

describe('assessIndependence', () => {
  it('is cross-provider when the reviewer shares no provider with the authors', () => {
    expect(assessIndependence(['claude'], 'codex', providerOf)).toBe('cross-provider');
  });

  it('is same-provider when the reviewer is one of the authors', () => {
    // §56 permits this. It is not the same thing, and must not be reported as
    // though it were.
    expect(assessIndependence(['claude'], 'claude', providerOf)).toBe(
      'same-provider-fresh-context',
    );
  });

  it('sees through two runner ids that point at the same CLI', () => {
    // Different ids, same model family, same training, same blind spots.
    // Comparing ids called this cross-provider — a review a model gave of its
    // own work, labelled as independent.
    expect(assessIndependence(['claude'], 'claudeBackup', providerOf)).toBe(
      'same-provider-fresh-context',
    );
  });

  it('is same-provider when any single author shares the reviewer provider', () => {
    // A review is only independent of work it did not do. One overlap is enough
    // to lose the guarantee, however many other authors there were.
    expect(assessIndependence(['codex', 'claude'], 'claudeBackup', providerOf)).toBe(
      'same-provider-fresh-context',
    );
  });

  it('does not claim independence from an unknown provider', () => {
    expect(assessIndependence(['claude'], 'mystery', providerOf)).toBe(
      'same-provider-fresh-context',
    );
  });

  it('does not claim independence when nothing recorded who wrote the code', () => {
    // An empty author list is not evidence of independence; it is absence of
    // evidence. Reporting cross-provider here would be inventing a guarantee.
    expect(assessIndependence([], 'codex', providerOf)).toBe('same-provider-fresh-context');
  });
});

describe('explainIndependence', () => {
  it('names the reviewer, its provider, and the authors', () => {
    const explanation = explainIndependence(['claude', 'claude'], 'claudeBackup', providerOf);

    expect(explanation).toContain('claudeBackup');
    expect(explanation).toContain('claude-code-cli');
    // Deduplicated: three tasks on one runner is one author, not three.
    expect(explanation.match(/claude,/g)).toBeNull();
  });

  it('says so plainly when there are no recorded authors', () => {
    expect(explainIndependence([], 'codex', providerOf)).toContain('(none)');
  });
});
