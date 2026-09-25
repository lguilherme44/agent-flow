import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import type { GitResult } from '../../src/adapters/git/git-command.js';
import {
  gitIgnoredDirectory,
  readDirectoryInstructions,
  type DirectoryInstructionsDeps,
} from '../../src/app/directory-instructions.js';
import { AGENTS_BEGIN, AGENTS_END, AGENTS_MD_SCAFFOLD } from '../../src/app/project-instructions.js';

/**
 * N1 — the instructions of every directory a task touches, read on the agent's behalf.
 *
 * The runner's isolation flags stop the CLI from loading a nested `CLAUDE.md` itself
 * (measured 24/09/2026), so this reader is the only route those rules have into a stage.
 * It is also a read the orchestrator makes with its own privileges and no sandbox, which
 * is why every bound and every failure below is a test rather than a hope.
 *
 * Git's answer is faked here; `directory-instructions.integration.test.ts` asks real Git.
 */

const ROOT = '/repo';

interface Harness {
  readonly fs: InMemoryFileSystem;
  readonly deps: DirectoryInstructionsDeps;
  /** Every directory Git was asked about, in order. */
  readonly asked: string[];
}

const harness = (
  answer: (directory: string) => GitResult<boolean> = () => ({ ok: true, value: false }),
): Harness => {
  const fs = new InMemoryFileSystem();
  const asked: string[] = [];
  return {
    fs,
    asked,
    deps: {
      fs,
      isIgnoredDirectory: async (cwd, directory) => {
        expect(cwd).toBe(ROOT);
        asked.push(directory);
        return answer(directory);
      },
    },
  };
};

const read = (deps: DirectoryInstructionsDeps, likely: readonly string[]) =>
  readDirectoryInstructions(deps, { treeRoot: ROOT, likely });

const errno = (code: string, path: string): Error =>
  Object.assign(new Error(`${code}: permission denied, open '${path}'`), { code });

describe('choosing and rendering each directory’s file (FR-004, FR-006)', () => {
  it('renders sub/AGENTS.md under one heading, labelled with its source path', async () => {
    const { fs, deps } = harness();
    fs.seed(`${ROOT}/sub/AGENTS.md`, '# Sub rules\n\n- sub never imports lib.\n');

    const got = await read(deps, ['sub/x.ts']);

    expect(got.block).toBe(
      '## Directory instructions\n\n### sub/AGENTS.md\n\n# Sub rules\n\n- sub never imports lib.',
    );
    expect(got.skipped).toEqual([]);
  });

  it('falls back to CLAUDE.md in a directory with no AGENTS.md (AC-04)', async () => {
    const { fs, deps } = harness();
    fs.seed(`${ROOT}/sub/CLAUDE.md`, '# Claude rules for sub\n');

    const got = await read(deps, ['sub/x.ts']);

    expect(got.block).toContain('### sub/CLAUDE.md\n\n');
    expect(got.block).toContain('# Claude rules for sub');
    expect(got.block).not.toContain('sub/AGENTS.md');
  });

  it('falls back to CLAUDE.md past a scaffold-only AGENTS.md, as the root reader does', async () => {
    const { fs, deps } = harness();
    const block = [AGENTS_BEGIN, '## Validation', AGENTS_END].join('\n');
    fs.seed(`${ROOT}/sub/AGENTS.md`, [...AGENTS_MD_SCAFFOLD, block, ''].join('\n'));
    fs.seed(`${ROOT}/sub/CLAUDE.md`, '# The real rules\n');

    const got = await read(deps, ['sub/x.ts']);

    expect(got.block).toContain('### sub/CLAUDE.md');
    expect(got.block).toContain('# The real rules');
    expect(got.block).not.toContain('Describe the boundaries that must not be crossed');
  });

  it('renders nothing for a directory holding neither file (AC-04)', async () => {
    const { fs, deps } = harness();
    fs.seed(`${ROOT}/sub/x.ts`, 'export {};\n');

    const got = await read(deps, ['sub/x.ts']);

    expect(got).toEqual({ block: '', skipped: [] });
  });

  it('renders directories root first, in candidate order', async () => {
    const { fs, deps } = harness();
    fs.seed(`${ROOT}/pkg/AGENTS.md`, 'pkg rules\n');
    fs.seed(`${ROOT}/pkg/api/AGENTS.md`, 'api rules\n');
    fs.seed(`${ROOT}/lib/CLAUDE.md`, 'lib rules\n');

    const got = await read(deps, ['pkg/api/handler.ts', 'lib/y.ts']);

    const order = ['### lib/CLAUDE.md', '### pkg/AGENTS.md', '### pkg/api/AGENTS.md'].map((label) =>
      got.block.indexOf(label),
    );
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(got.block.startsWith('## Directory instructions\n\n')).toBe(true);
  });

  it('lets an entry that is an existing directory contribute itself', async () => {
    const { fs, deps } = harness();
    fs.seed(`${ROOT}/docs/AGENTS.md`, 'docs rules\n');

    expect((await read(deps, ['docs'])).block).toContain('### docs/AGENTS.md');
  });

  it('gives an empty block and asks Git nothing when there is no candidate (NFR-003)', async () => {
    const { fs, deps, asked } = harness();
    fs.seed(`${ROOT}/AGENTS.md`, 'root rules\n');

    const got = await read(deps, ['README.md', '../x', '/etc/passwd']);

    expect(got).toEqual({ block: '', skipped: [] });
    expect(asked).toEqual([]);
    // Positive control: a nested entry does ask.
    await read(deps, ['sub/x.ts']);
    expect(asked).toEqual(['sub']);
  });
});

describe('ignored directories are not the repository’s (FR-005)', () => {
  it('does not read an ignored directory and records no warning', async () => {
    const { fs, deps } = harness((directory) => ({ ok: true, value: directory === 'sub' }));
    fs.seed(`${ROOT}/sub/AGENTS.md`, 'ignored rules\n');
    fs.seed(`${ROOT}/lib/AGENTS.md`, 'lib rules\n');

    const got = await read(deps, ['sub/x.ts', 'lib/y.ts']);

    expect(got.block).not.toContain('ignored rules');
    expect(got.block).toContain('### lib/AGENTS.md');
    expect(got.skipped).toEqual([]);
  });

  it('excludes a directory under an ignored one without asking Git again', async () => {
    const { fs, deps, asked } = harness((directory) => ({ ok: true, value: directory === 'pkg' }));
    fs.seed(`${ROOT}/pkg/sub/AGENTS.md`, 'nested ignored rules\n');

    const got = await read(deps, ['pkg/sub/x.ts']);

    expect(got).toEqual({ block: '', skipped: [] });
    expect(asked).toEqual(['pkg']);
  });

  it('asks the adapter with --no-index and a trailing slash', async () => {
    const calls: unknown[] = [];
    const ask = gitIgnoredDirectory({
      isIgnored: async (options) => {
        calls.push(options);
        return { ok: true, value: false };
      },
    });

    await ask(ROOT, 'pkg/sub');

    expect(calls).toEqual([{ cwd: ROOT, path: 'pkg/sub/', noIndex: true }]);
  });
});

describe('the bounds of a read made outside any sandbox (FR-008, AC-07)', () => {
  it('cuts a 70 KiB file to 64 KiB and says so', async () => {
    const { fs, deps } = harness();
    fs.seed(`${ROOT}/sub/AGENTS.md`, 'x'.repeat(70 * 1024));

    const got = await read(deps, ['sub/x.ts']);

    const label = '### sub/AGENTS.md\n\n';
    const text = got.block.slice(got.block.indexOf(label) + label.length);
    const marker =
      `… [truncated: AGENTS.md is ${String(70 * 1024)} bytes and this prompt ` +
      `carries the first ${String(64 * 1024)}]`;
    expect(text).toBe(`${'x'.repeat(64 * 1024)}\n\n${marker}`);
  });

  it('keeps a file at the bound whole', async () => {
    const { fs, deps } = harness();
    fs.seed(`${ROOT}/sub/AGENTS.md`, 'x'.repeat(64 * 1024));

    expect((await read(deps, ['sub/x.ts'])).block).not.toContain('truncated');
  });

  it('does not follow a symlink out of the tree', async () => {
    const { fs, deps } = harness();
    fs.seed('/home/dev/.ssh/id_rsa', 'PRIVATE KEY\n');
    fs.link(`${ROOT}/sub/AGENTS.md`, '/home/dev/.ssh/id_rsa');
    fs.seed(`${ROOT}/lib/AGENTS.md`, 'lib rules\n');

    const got = await read(deps, ['sub/x.ts', 'lib/y.ts']);

    expect(got.block).not.toContain('PRIVATE KEY');
    expect(got.skipped).toEqual([{ directory: 'sub', reason: 'outside_tree' }]);
    expect(got.block).toContain('### lib/AGENTS.md');
  });

  it('follows a symlink that stays inside the tree', async () => {
    const { fs, deps } = harness();
    fs.seed(`${ROOT}/shared/RULES.md`, 'shared rules\n');
    fs.link(`${ROOT}/sub/AGENTS.md`, `${ROOT}/shared/RULES.md`);

    const got = await read(deps, ['sub/x.ts']);

    expect(got.block).toContain('shared rules');
    expect(got.skipped).toEqual([]);
  });
});

describe('a directory that cannot be read cleanly is skipped, never thrown (FR-009, AC-08)', () => {
  /** Every case seeds a readable sibling, so "skipped only sub" is asserted, not assumed. */
  const withSibling = (h: Harness): Harness => {
    h.fs.seed(`${ROOT}/lib/AGENTS.md`, 'lib rules\n');
    return h;
  };

  const expectOnlySubSkipped = async (h: Harness, reason: string): Promise<void> => {
    const got = await read(h.deps, ['sub/x.ts', 'lib/y.ts']);

    expect(got.skipped).toEqual([{ directory: 'sub', reason }]);
    expect(got.block).toContain('### lib/AGENTS.md\n\nlib rules');
    expect(got.block).not.toContain('### sub/');
    // SEC-008: the warning reaches persisted events, so it names no machine path.
    expect(JSON.stringify(got.skipped)).not.toContain(ROOT);
  };

  it('skips an AGENTS.md that is a directory as not_a_file', async () => {
    const h = withSibling(harness());
    await h.fs.mkdirp(`${ROOT}/sub/AGENTS.md`);
    h.fs.seed(`${ROOT}/sub/CLAUDE.md`, 'claude rules\n');

    await expectOnlySubSkipped(h, 'not_a_file');
  });

  it('skips a file whose read is refused as unreadable', async () => {
    const h = withSibling(harness());
    h.fs.seed(`${ROOT}/sub/AGENTS.md`, 'unreadable rules\n');
    const readFile = h.fs.readFile.bind(h.fs);
    h.fs.readFile = async (path: string) => {
      if (path.includes('sub/AGENTS.md')) throw errno('EACCES', path);
      return readFile(path);
    };

    await expectOnlySubSkipped(h, 'unreadable');
  });

  it('skips a file whose real path cannot be resolved as unresolvable', async () => {
    const h = withSibling(harness());
    h.fs.seed(`${ROOT}/sub/AGENTS.md`, 'rules\n');
    const realPath = h.fs.realPath.bind(h.fs);
    h.fs.realPath = async (path: string) => {
      if (path.includes('sub/AGENTS.md')) throw errno('ELOOP', path);
      return realPath(path);
    };

    await expectOnlySubSkipped(h, 'unresolvable');
  });

  it('treats a real path of null for an existing file as unresolvable', async () => {
    const h = withSibling(harness());
    h.fs.seed(`${ROOT}/sub/AGENTS.md`, 'rules\n');
    const realPath = h.fs.realPath.bind(h.fs);
    h.fs.realPath = async (path: string) => (path.includes('sub/AGENTS.md') ? null : realPath(path));

    await expectOnlySubSkipped(h, 'unresolvable');
  });

  it('fails closed when the ignore check fails', async () => {
    const h = withSibling(
      harness((directory) =>
        directory === 'sub'
          ? { ok: false, failure: { code: 'git_command_failed', message: 'git check-ignore exited 128' } }
          : { ok: true, value: false },
      ),
    );
    h.fs.seed(`${ROOT}/sub/AGENTS.md`, 'sub rules\n');

    await expectOnlySubSkipped(h, 'ignore_check_failed');
  });

  it('fails closed when the ignore check throws', async () => {
    const h = withSibling(harness());
    h.fs.seed(`${ROOT}/sub/AGENTS.md`, 'sub rules\n');
    const deps: DirectoryInstructionsDeps = {
      fs: h.fs,
      isIgnoredDirectory: async (cwd, directory) => {
        if (directory === 'sub') throw new Error(`spawn failed in ${cwd}`);
        return { ok: true, value: false };
      },
    };

    await expectOnlySubSkipped({ ...h, deps }, 'ignore_check_failed');
  });

  it('skips on a failing CLAUDE.md fallback too', async () => {
    const h = withSibling(harness());
    await h.fs.mkdirp(`${ROOT}/sub/CLAUDE.md`);

    await expectOnlySubSkipped(h, 'not_a_file');
  });

  it('does not throw when the tree root itself cannot be resolved', async () => {
    const h = harness();
    h.fs.seed(`${ROOT}/sub/AGENTS.md`, 'rules\n');
    h.fs.realPath = async () => {
      throw new Error('EIO');
    };

    const got = await read(h.deps, ['sub/x.ts']);

    expect(got).toEqual({ block: '', skipped: [{ directory: 'sub', reason: 'unresolvable' }] });
  });
});
