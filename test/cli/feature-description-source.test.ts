import { afterEach, describe, expect, it, vi } from 'vitest';
import { runFeatureFromSource, type FeatureSourceDeps } from '../../src/cli/feature.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import type { GlobalOptions } from '../../src/cli/index.js';

/**
 * D15 — `feature` reads its description the way `revise` reads its instruction.
 *
 * Measured on AF-2026-004 (11/09/2026): the description was 9 KB with backticks, quotes
 * and paragraph breaks, and the run had to be launched from a Node script with `spawn`
 * because no shell carried the text intact. `revise` had solved this a milestone earlier
 * (AR-08) and `feature`, the command that reads the longer text, had not.
 */

const globals: GlobalOptions = {
  cwd: '/repo',
  globalConfigPath: '/home/.agent-flow/config.yaml',
  verbose: false,
  dryRun: false,
  json: false,
  strict: false,
};

// What a shell argument cannot carry: paragraphs, a fenced block, a lone apostrophe.
const DESCRIPTION = [
  'Add device pairing to the Deck.',
  '',
  "The phone's code is six digits and expires in `PAIRING_TTL` seconds:",
  '',
  '```yaml',
  'remoteAccess:',
  '  ttlSeconds: 300',
  '```',
].join('\n');

function deps(overrides: Partial<FeatureSourceDeps['io']> = {}): FeatureSourceDeps & {
  readonly run: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn(async () => ExitCode.OK);
  return {
    io: {
      readFile: (path) => (path === 'feature.md' ? `${DESCRIPTION}\n` : undefined),
      readStdin: async () => `${DESCRIPTION}\n`,
      openEditor: async () => `${DESCRIPTION}\n`,
      ...overrides,
    },
    run: run as unknown as FeatureSourceDeps['run'],
  } as FeatureSourceDeps & { readonly run: ReturnType<typeof vi.fn> };
}

describe('feature reads its description from a file, stdin or an editor (D15)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hands a file description to the command whole, fences and apostrophe included', async () => {
    const d = deps();
    const code = await runFeatureFromSource({ file: 'feature.md' }, { workflow: 'high-risk' }, globals, d);

    expect(code).toBe(ExitCode.OK);
    // Byte-for-byte, minus the trailing newline: the interior is the point.
    expect(d.run).toHaveBeenCalledWith(DESCRIPTION, { workflow: 'high-risk' }, globals);
  });

  it('reads stdin for a lone dash', async () => {
    const d = deps();
    await runFeatureFromSource({ argument: '-' }, {}, globals, d);
    expect(d.run).toHaveBeenCalledWith(DESCRIPTION, {}, globals);
  });

  it('reads what the editor left behind', async () => {
    const d = deps();
    await runFeatureFromSource({ edit: true }, {}, globals, d);
    expect(d.run).toHaveBeenCalledWith(DESCRIPTION, {}, globals);
  });

  it('still takes a plain argument, so the documented invocation keeps working', async () => {
    const d = deps();
    await runFeatureFromSource({ argument: 'add dark mode' }, { from: 'sdd' }, globals, d);
    expect(d.run).toHaveBeenCalledWith('add dark mode', { from: 'sdd' }, globals);
  });

  it('refuses two sources before anything runs, and says "description", not "instruction"', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const d = deps();

    const code = await runFeatureFromSource({ argument: 'short', file: 'feature.md' }, {}, globals, d);

    expect(code).toBe(ExitCode.CONFIG_ERROR);
    // Positive control for the seam: the command is what spends money, and a refused
    // invocation must not reach it.
    expect(d.run).not.toHaveBeenCalled();
    const written = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain('description');
    expect(written).not.toContain('instruction');
  });

  it('refuses a missing file by name, and an empty description by consequence', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const d = deps({ openEditor: async () => '  \n' });

    expect(await runFeatureFromSource({ file: 'missing.md' }, {}, globals, d)).toBe(ExitCode.CONFIG_ERROR);
    expect(await runFeatureFromSource({ edit: true }, {}, globals, d)).toBe(ExitCode.CONFIG_ERROR);
    expect(await runFeatureFromSource({}, {}, globals, d)).toBe(ExitCode.CONFIG_ERROR);

    expect(d.run).not.toHaveBeenCalled();
    const written = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain('missing.md');
    expect(written).toMatch(/nothing to plan/);
    expect(written).toContain('--file');
  });
});
