import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { parseDepth, parsePort, resolveDepth } from '../../src/cli/ui.js';
import { DEFAULT_WORKSPACE_DEPTH } from '../../src/server/project-registry.js';

/**
 * `agent-flow ui [root]` — the workspace root and how far it is scanned (UI-29).
 *
 * The depth is the only number on this command that decides what the server can
 * serve at all, so where it comes from is worth pinning down: the flag was typed
 * for this run, the config was typed once, and the default is what neither says.
 */

const GLOBAL = (depth: number): string => `runners:
  codex:
    type: codex-cli
roles:
  architect: { runner: codex }
  sdd: { runner: codex }
  planner: { runner: codex }
  planReviewer: { runner: codex }
  verification: { runner: codex }
  finalReviewer: { runner: codex }
  executors:
    trivial: { runner: codex }
    normal: { runner: codex }
    complex: { runner: codex }
ui:
  workspaceDepth: ${String(depth)}
`;

function world(global?: string): InMemoryFileSystem {
  const fs = new InMemoryFileSystem();
  if (global !== undefined) fs.seed('/home/.agent-flow/config.yaml', global);
  return fs;
}

const at = (fs: InMemoryFileSystem) => ({
  fs,
  globalConfigPath: '/home/.agent-flow/config.yaml',
  projectDir: '/wk',
});

describe('parsePort', () => {
  it('refuses anything that is not a port', () => {
    for (const raw of ['0', '65536', 'eighty', '-1', '80.5']) {
      expect(() => parsePort(raw), raw).toThrow(/Invalid --port/);
    }
  });
});

describe('parseDepth', () => {
  it('refuses a depth outside the bound', () => {
    // Unbounded is the failure mode: a scan of a home directory reads places
    // nobody asked it to and takes minutes before anything renders.
    for (const raw of ['-1', '7', '99', 'deep']) {
      expect(() => parseDepth(raw), raw).toThrow(/Invalid --depth/);
    }
  });

  it('accepts zero, which means the root and nothing under it', () => {
    expect(parseDepth('0')).toBe(0);
  });
});

describe('resolveDepth', () => {
  it('prefers the flag, which was typed for this run', async () => {
    expect(await resolveDepth('1', at(world(GLOBAL(4))))).toBe(1);
  });

  it('falls back to the configured depth', async () => {
    // Somebody who keeps their repositories three levels down should not have to
    // say so every time they open the dashboard.
    expect(await resolveDepth(undefined, at(world(GLOBAL(4))))).toBe(4);
  });

  it('falls back to the default when nothing says otherwise', async () => {
    expect(await resolveDepth(undefined, at(world()))).toBe(DEFAULT_WORKSPACE_DEPTH);
  });

  it('starts anyway when the configuration will not load', async () => {
    // `agent-flow ui` is often exactly what somebody opens *because* something is
    // wrong. Refusing to start over a malformed global file would take away the
    // tool that shows them why — the Settings page reports the same error where
    // it can be read (§95).
    const fs = world('runners: [not a mapping]\n');

    expect(await resolveDepth(undefined, at(fs))).toBe(DEFAULT_WORKSPACE_DEPTH);
  });

  it('refuses a flag beyond the bound rather than clamping it silently', async () => {
    await expect(resolveDepth('9', at(world()))).rejects.toThrow(/Invalid --depth/);
  });
});
