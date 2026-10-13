import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { loadFlowGuide } from '../../src/app/flow-guide-loader.js';
import { resolveGuidesDir } from '../../src/app/prompt-paths.js';
import { FLOW_GUIDES } from '../../src/core/flow-guides.js';

/**
 * Loading a guide's text from the shipped `guides/` directory.
 *
 * The registry is pure data; the text lives in Markdown beside `prompts/`, so a guide
 * can be edited without touching code — and so a guide the registry names but the
 * package forgot to ship is a failure here, not on the first operator who asks for it.
 */
describe('the shipped guides', () => {
  const fs = new NodeFileSystem();
  const guidesDir = resolveGuidesDir();

  it('exist for every registered key, non-empty and short', async () => {
    for (const entry of FLOW_GUIDES) {
      const outcome = await loadFlowGuide({ fs, guidesDir }, entry.key);
      expect(outcome.ok, `${entry.key}: ${outcome.ok ? '' : outcome.error.message}`).toBe(true);
      if (!outcome.ok) continue;

      expect(outcome.value.text.trim().length, `${entry.key} is empty`).toBeGreaterThan(0);
      // Read by a model at the start of a conversation: a guide that grows past a screen
      // stops being read in full, and the rule at its bottom is the one that gets lost.
      const lines = outcome.value.text.trimEnd().split(/\r?\n/).length;
      expect(lines, `${entry.key} has ${String(lines)} lines`).toBeLessThanOrEqual(60);
    }
  });

  it('carries the registry fields beside the text', async () => {
    const outcome = await loadFlowGuide({ fs, guidesDir }, 'gate');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value).toMatchObject({
      key: 'gate',
      uri: 'agent-flow://flows/gate',
    });
    expect(outcome.value.name).toBe(FLOW_GUIDES.find((g) => g.key === 'gate')?.name);
  });
});

describe('loadFlowGuide', () => {
  it('refuses an unknown key and names every valid one', async () => {
    const outcome = await loadFlowGuide({ fs: new InMemoryFileSystem(), guidesDir: '/pkg/guides' }, 'nope');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('unknown_guide');
    expect(outcome.error.validKeys).toEqual(FLOW_GUIDES.map((g) => g.key));
  });

  it('reports a registered guide whose file was not shipped, naming where it looked', async () => {
    const outcome = await loadFlowGuide({ fs: new InMemoryFileSystem(), guidesDir: '/pkg/guides' }, 'overview');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('guide_missing');
    expect(outcome.error.message).toContain('/pkg/guides/overview.md');
  });

  it('reads the text from <guidesDir>/<key>.md', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/pkg/guides/feature.md', '# Feature\n\nbody\n');

    const outcome = await loadFlowGuide({ fs, guidesDir: '/pkg/guides' }, 'feature');

    expect(outcome.ok && outcome.value.text).toBe('# Feature\n\nbody\n');
  });
});
