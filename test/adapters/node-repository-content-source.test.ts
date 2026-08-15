import { afterEach, describe, expect, it, vi } from 'vitest';
import { constants, promises as nodeFs } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeRepositoryContentSource } from '../../src/adapters/fs/node-repository-content-source.js';

const created: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  created.push(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('NodeRepositoryContentSource', () => {
  it('rejects a trusted relative candidate whose file symlink escapes the project', async () => {
    const projectDir = await tempDir('af-content-project-');
    const externalDir = await tempDir('af-content-external-');
    const externalContent = 'EXTERNAL_SECRET_MUST_NOT_CROSS_THE_SEAM';

    await mkdir(join(projectDir, 'src'));
    await writeFile(join(externalDir, 'secret.txt'), externalContent, 'utf8');
    await symlink(join(externalDir, 'secret.txt'), join(projectDir, 'src', 'candidate.txt'));

    const result = await new NodeRepositoryContentSource({ maxFileBytes: 1024 }).readCandidate(
      projectDir,
      'src/candidate.txt',
    );

    expect(result).toMatchObject({
      ok: false,
      path: 'src/candidate.txt',
      errorCode: 'symlink',
    });
    expect(JSON.stringify(result)).not.toContain(externalContent);
  });

  it('rejects an in-project symlink so discovery authority cannot alias a different file', async () => {
    const projectDir = await tempDir('af-content-internal-link-');
    const secret = 'INTERNAL_ALIAS_MUST_NOT_CROSS_THE_SEAM';
    await writeFile(join(projectDir, '.env'), secret, 'utf8');
    await symlink(join(projectDir, '.env'), join(projectDir, 'config-example'));

    const result = await new NodeRepositoryContentSource().readCandidate(
      projectDir,
      'config-example',
    );

    expect(result).toMatchObject({ ok: false, path: 'config-example', errorCode: 'symlink' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('proves post-open identity before reading after an intermediate-directory swap', async () => {
    const projectDir = await tempDir('af-content-race-project-');
    const externalDir = await tempDir('af-content-race-external-');
    const externalContent = 'RACED_EXTERNAL_BYTES_MUST_NOT_CROSS_THE_SEAM';
    const sourceDir = join(projectDir, 'src');
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, 'candidate.txt'), 'safe', 'utf8');
    await writeFile(join(externalDir, 'candidate.txt'), externalContent, 'utf8');

    const open = nodeFs.open.bind(nodeFs);
    vi.spyOn(nodeFs, 'open').mockImplementation(async (path, flags) => {
      await rm(sourceDir, { recursive: true, force: true });
      await symlink(externalDir, sourceDir, 'dir');
      return open(path, flags);
    });

    const result = await new NodeRepositoryContentSource().readCandidate(
      projectDir,
      'src/candidate.txt',
    );

    expect(result).toMatchObject({ ok: false, path: 'src/candidate.txt', errorCode: 'path_changed' });
    expect(JSON.stringify(result)).not.toContain(externalContent);
  });

  it('rejects a post-open dev+ino mismatch before reading', async () => {
    const projectDir = await tempDir('af-content-identity-race-');
    await writeFile(join(projectDir, 'candidate.txt'), 'safe', 'utf8');
    const read = vi.fn().mockResolvedValue({ bytesRead: 0 });
    vi.spyOn(nodeFs, 'open').mockResolvedValue({
      stat: async () => ({ isFile: () => true, size: 4n, dev: -1n, ino: -1n }),
      read,
      close: async () => undefined,
    } as never);

    await expect(
      new NodeRepositoryContentSource().readCandidate(projectDir, 'candidate.txt'),
    ).resolves.toMatchObject({ ok: false, errorCode: 'path_changed' });
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a double-swap when the opened handle was never the authorized final inode', async () => {
    const root = '/virtual/repo';
    const candidate = `${root}/src/candidate.txt`;
    const read = vi.fn().mockResolvedValue({ bytesRead: 0 });
    const identities = new Map([
      [root, { dev: 1n, ino: 1n, directory: true }],
      [`${root}/src`, { dev: 1n, ino: 2n, directory: true }],
      [candidate, { dev: 1n, ino: 3n, directory: false }],
    ]);

    vi.spyOn(nodeFs, 'realpath').mockImplementation(async (path) =>
      path === root ? root : candidate,
    );
    vi.spyOn(nodeFs, 'lstat').mockImplementation(async (path) => {
      const identity = identities.get(String(path));
      if (!identity) throw new Error(`unexpected lstat: ${String(path)}`);
      return {
        dev: identity.dev,
        ino: identity.ino,
        isSymbolicLink: () => false,
        isDirectory: () => identity.directory,
        isFile: () => !identity.directory,
      } as never;
    });
    vi.spyOn(nodeFs, 'readdir').mockImplementation(async (path) => {
      if (path === root) return [Buffer.from('src')] as never;
      if (path === `${root}/src`) return [Buffer.from('candidate.txt')] as never;
      throw new Error(`unexpected readdir: ${String(path)}`);
    });
    vi.spyOn(nodeFs, 'open').mockResolvedValue({
      stat: async () => ({ isFile: () => true, size: 8n, dev: 9n, ino: 9n }),
      read,
      close: async () => undefined,
    } as never);
    // Simulates the attacker's second swap: the path agrees with the external
    // handle only after postflight. Path-based stat must not authorize it.
    vi.spyOn(nodeFs, 'stat').mockResolvedValue({
      isFile: () => true,
      dev: 9n,
      ino: 9n,
    } as never);

    const result = await new NodeRepositoryContentSource().readCandidate(
      root,
      'src/candidate.txt',
    );

    expect(result).toMatchObject({ ok: false, path: 'src/candidate.txt', errorCode: 'path_changed' });
    expect(read).not.toHaveBeenCalled();
  });

  it('opens regular candidates with no-follow and nonblocking flags', async () => {
    const projectDir = await tempDir('af-content-open-flags-');
    await writeFile(join(projectDir, 'candidate.txt'), 'safe', 'utf8');
    const open = nodeFs.open.bind(nodeFs);
    const openSpy = vi.spyOn(nodeFs, 'open').mockImplementation((path, flags) => open(path, flags));

    await expect(
      new NodeRepositoryContentSource().readCandidate(projectDir, 'candidate.txt'),
    ).resolves.toMatchObject({ ok: true, content: 'safe' });

    const flags = openSpy.mock.calls[0]?.[1];
    expect(typeof flags).toBe('number');
    expect((flags as number) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect((flags as number) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
  });

  it('does not confuse a project root with a sibling that shares its prefix', async () => {
    const parent = await tempDir('af-content-containment-');
    const projectDir = join(parent, 'repo');
    const prefixSibling = join(parent, 'repo-evil');
    const externalContent = 'PREFIX_SIBLING_CONTENT_MUST_NOT_CROSS_THE_SEAM';

    await mkdir(join(projectDir, 'src'), { recursive: true });
    await mkdir(prefixSibling);
    await writeFile(join(prefixSibling, 'outside.txt'), externalContent, 'utf8');
    await symlink(join(prefixSibling, 'outside.txt'), join(projectDir, 'src', 'candidate.txt'));

    const result = await new NodeRepositoryContentSource().readCandidate(
      projectDir,
      'src/candidate.txt',
    );

    expect(result).toMatchObject({ ok: false, errorCode: 'symlink' });
    expect(JSON.stringify(result)).not.toContain(externalContent);
  });

  it.each([
    '../outside.txt',
    'src/../outside.txt',
    '/absolute.txt',
    'C:\\absolute.txt',
    '\\\\server\\share\\file.txt',
    'file:///tmp/file.txt',
  ])('rejects unsafe path %s without throwing', async (candidatePath) => {
    const projectDir = await tempDir('af-content-path-');

    await expect(
      new NodeRepositoryContentSource().readCandidate(projectDir, candidatePath),
    ).resolves.toMatchObject({ ok: false, errorCode: 'invalid_path' });
  });

  it.each([
    ' .env',
    '.env ',
    './src/file.txt',
    'src//file.txt',
    'src\\file.txt',
    '.git./config',
    '.agent-flow./state.json',
    'file.txt::$DATA',
    'CON',
    'prn.txt',
    'AUX.json',
    'nul.md',
    'COM1.log',
    'com9',
    'LPT1.txt',
    'lpt9',
    'COM¹',
    'com².txt',
    'COM³.log',
    'LPT¹',
    'lpt².txt',
    'LPT³.md',
    'src/trailing-dot.',
    'src/trailing-space ',
    'bad<name.txt',
    'bad>name.txt',
    'bad"name.txt',
    'bad|name.txt',
    'bad?name.txt',
    'bad*name.txt',
  ])(
    'rejects path alias %j instead of silently changing discovery authority',
    async (candidatePath) => {
      const projectDir = await tempDir('af-content-exact-path-');
      await mkdir(join(projectDir, 'src'));
      await writeFile(join(projectDir, '.env'), 'secret', 'utf8');
      await writeFile(join(projectDir, 'src', 'file.txt'), 'safe', 'utf8');

      await expect(
        new NodeRepositoryContentSource().readCandidate(projectDir, candidatePath),
      ).resolves.toEqual({
        ok: false,
        path: '',
        errorCode: 'invalid_path',
        message: 'candidate path is not a safe exact repository-relative path',
      });
    },
  );

  it('rejects a case-folded alias when the filesystem resolves it', async (context) => {
    const projectDir = await tempDir('af-content-case-alias-');
    const content = 'CASE_ALIAS_MUST_NOT_CROSS_THE_SEAM';
    await writeFile(join(projectDir, 'Secret.txt'), content, 'utf8');
    const aliasPath = join(projectDir, 'secret.txt');
    const aliasResolves = await nodeFs.lstat(aliasPath).then(
      () => true,
      () => false,
    );
    if (!aliasResolves) {
      context.skip();
      return;
    }

    const result = await new NodeRepositoryContentSource().readCandidate(projectDir, 'secret.txt');

    expect(result).toMatchObject({ ok: false, path: 'secret.txt', errorCode: 'path_changed' });
    expect(JSON.stringify(result)).not.toContain(content);
  });

  it('rejects a Unicode-normalization alias when the filesystem resolves it', async (context) => {
    const projectDir = await tempDir('af-content-unicode-alias-');
    const content = 'UNICODE_ALIAS_MUST_NOT_CROSS_THE_SEAM';
    await writeFile(join(projectDir, 'café.txt'), content, 'utf8');
    const rawEntries = await nodeFs.readdir(projectDir, { encoding: 'buffer' });
    const rawName = rawEntries
      .map((entry) => entry.toString('utf8'))
      .find((entry) => entry.normalize('NFC') === 'café.txt');
    if (!rawName) throw new Error('created Unicode fixture was not enumerated');

    const alias = rawName === rawName.normalize('NFC')
      ? rawName.normalize('NFD')
      : rawName.normalize('NFC');
    const aliasResolves = alias !== rawName && await nodeFs.lstat(join(projectDir, alias)).then(
      () => true,
      () => false,
    );
    if (!aliasResolves) {
      context.skip();
      return;
    }

    const result = await new NodeRepositoryContentSource().readCandidate(projectDir, alias);

    expect(result).toMatchObject({ ok: false, path: alias, errorCode: 'path_changed' });
    expect(JSON.stringify(result)).not.toContain(content);
  });

  it('fails closed when raw enumeration reports multiple byte-exact entries', async () => {
    const projectDir = await tempDir('af-content-duplicate-entry-');
    await writeFile(join(projectDir, 'candidate.txt'), 'safe', 'utf8');
    vi.spyOn(nodeFs, 'readdir').mockResolvedValue([
      Buffer.from('candidate.txt'),
      Buffer.from('candidate.txt'),
    ] as never);
    const open = vi.spyOn(nodeFs, 'open');

    await expect(
      new NodeRepositoryContentSource().readCandidate(projectDir, 'candidate.txt'),
    ).resolves.toMatchObject({ ok: false, errorCode: 'path_changed' });
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects a lone UTF-16 surrogate that UTF-8 encoding aliases to replacement character', async () => {
    const projectDir = await tempDir('af-content-surrogate-alias-');
    const content = 'SURROGATE_ALIAS_MUST_NOT_CROSS_THE_SEAM';
    await writeFile(join(projectDir, '�.txt'), content, 'utf8');

    const result = await new NodeRepositoryContentSource().readCandidate(
      projectDir,
      '\ud800.txt',
    );

    expect(result).toMatchObject({ ok: false, path: '', errorCode: 'invalid_path' });
    expect(JSON.stringify(result)).not.toContain(content);
  });

  it('preserves a valid UTF-16 surrogate pair in an emoji filename', async () => {
    const projectDir = await tempDir('af-content-emoji-path-');
    await writeFile(join(projectDir, '😀.txt'), 'valid emoji path', 'utf8');

    await expect(
      new NodeRepositoryContentSource().readCandidate(projectDir, '😀.txt'),
    ).resolves.toEqual({
      ok: true,
      path: '😀.txt',
      content: 'valid emoji path',
      bytes: 16,
    });
  });

  it('does not echo control characters from an invalid candidate path', async () => {
    const projectDir = await tempDir('af-content-control-path-');
    const result = await new NodeRepositoryContentSource().readCandidate(
      projectDir,
      'src/unsafe\u0000name.ts',
    );

    expect(result).toMatchObject({ ok: false, path: '', errorCode: 'invalid_path' });
    expect(JSON.stringify(result)).not.toContain('unsafe');
    expect(JSON.stringify(result)).not.toContain('\\u0000');
  });

  it.each([
    'missing\u009b31m.txt',
    'missing\u2028line.txt',
    'missing\u2029paragraph.txt',
    'missing\u202esecret.txt',
    'missing\u2066isolate.txt',
    'missing\u200bzero-width.txt',
    'missing\u2060word-joiner.txt',
    'missing\ufeffbom.txt',
    'missing\u00adsoft-hyphen.txt',
  ])('rejects diagnostic control path %j without echoing it', async (candidatePath) => {
    const projectDir = await tempDir('af-content-unicode-control-');
    const result = await new NodeRepositoryContentSource().readCandidate(projectDir, candidatePath);

    expect(result).toMatchObject({ ok: false, path: '', errorCode: 'invalid_path' });
    expect(JSON.stringify(result)).not.toContain('missing');
  });

  it('checks the configured byte limit before exposing file content', async () => {
    const projectDir = await tempDir('af-content-limit-');
    const content = 'CONTENT_OVER_LIMIT_MUST_NOT_CROSS_THE_SEAM';
    const path = join(projectDir, 'large.txt');
    await writeFile(path, content, 'utf8');
    const identity = await nodeFs.lstat(path, { bigint: true });
    const read = vi.fn();
    vi.spyOn(nodeFs, 'open').mockResolvedValue({
      stat: async () => ({
        isFile: () => true,
        size: BigInt(Buffer.byteLength(content)),
        dev: identity.dev,
        ino: identity.ino,
      }),
      read,
      close: async () => undefined,
    } as never);

    const result = await new NodeRepositoryContentSource({ maxFileBytes: 4 }).readCandidate(
      projectDir,
      'large.txt',
    );

    expect(result).toMatchObject({ ok: false, errorCode: 'too_large' });
    expect(JSON.stringify(result)).not.toContain(content);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'falls back to the safe default for invalid maxFileBytes=%s',
    async (maxFileBytes) => {
      const projectDir = await tempDir('af-content-invalid-limit-');
      await writeFile(join(projectDir, 'large.txt'), Buffer.alloc(256 * 1024 + 1, 0x61));

      await expect(
        new NodeRepositoryContentSource({ maxFileBytes }).readCandidate(projectDir, 'large.txt'),
      ).resolves.toMatchObject({ ok: false, errorCode: 'too_large' });
    },
  );

  it('clamps a huge configured limit to a hard safety cap before reading', async () => {
    const projectDir = await tempDir('af-content-hard-limit-');
    const path = join(projectDir, 'huge.txt');
    await writeFile(path, 'placeholder', 'utf8');
    const identity = await nodeFs.lstat(path, { bigint: true });
    const read = vi.fn();
    vi.spyOn(nodeFs, 'open').mockResolvedValue({
      stat: async () => ({
        isFile: () => true,
        size: BigInt(4 * 1024 * 1024 + 1),
        dev: identity.dev,
        ino: identity.ino,
      }),
      read,
      close: async () => undefined,
    } as never);

    const result = await new NodeRepositoryContentSource({
      maxFileBytes: Number.MAX_SAFE_INTEGER,
    }).readCandidate(projectDir, 'huge.txt');

    expect(result).toMatchObject({ ok: false, errorCode: 'too_large' });
    expect(read).not.toHaveBeenCalled();
  });

  it('checks the final file kind with lstat before any potentially blocking open', async () => {
    const projectDir = await tempDir('af-content-fifo-');
    const fifoPath = join(projectDir, 'candidate.pipe');
    await writeFile(fifoPath, 'placeholder', 'utf8');
    const canonicalFifoPath = join(await nodeFs.realpath(projectDir), 'candidate.pipe');
    const realLstat = nodeFs.lstat.bind(nodeFs);
    vi.spyOn(nodeFs, 'lstat').mockImplementation(async (path) => {
      if (path === canonicalFifoPath) {
        return {
          isSymbolicLink: () => false,
          isDirectory: () => false,
          isFile: () => false,
        } as never;
      }
      return realLstat(path);
    });
    const open = vi.spyOn(nodeFs, 'open').mockRejectedValue(new Error('OPEN_MUST_NOT_RUN'));

    await expect(
      new NodeRepositoryContentSource().readCandidate(projectDir, 'candidate.pipe'),
    ).resolves.toMatchObject({ ok: false, errorCode: 'not_file' });
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'NUL bytes', bytes: new Uint8Array([0x61, 0x00, 0x62]) },
    { name: 'invalid UTF-8', bytes: new Uint8Array([0xc3, 0x28]) },
  ])('classifies $name as binary without permissive decoding', async ({ bytes }) => {
    const projectDir = await tempDir('af-content-binary-');
    await writeFile(join(projectDir, 'candidate.bin'), bytes);

    await expect(
      new NodeRepositoryContentSource().readCandidate(projectDir, 'candidate.bin'),
    ).resolves.toMatchObject({ ok: false, errorCode: 'binary' });
  });

  it('preserves Unicode text and reports its byte size', async () => {
    const projectDir = await tempDir('af-content-unicode-');
    const content = 'Olá, 世界 👋\n';
    await writeFile(join(projectDir, 'unicode.txt'), content, 'utf8');

    await expect(
      new NodeRepositoryContentSource().readCandidate(projectDir, 'unicode.txt'),
    ).resolves.toEqual({
      ok: true,
      path: 'unicode.txt',
      content,
      bytes: Buffer.byteLength(content),
    });
  });

  it('accepts a zero-content file, including with a zero-byte limit', async () => {
    const projectDir = await tempDir('af-content-empty-');
    await writeFile(join(projectDir, 'empty.txt'), '', 'utf8');

    await expect(
      new NodeRepositoryContentSource({ maxFileBytes: 0 }).readCandidate(projectDir, 'empty.txt'),
    ).resolves.toEqual({ ok: true, path: 'empty.txt', content: '', bytes: 0 });
  });

  it('returns explicit failures for missing paths and directories', async () => {
    const projectDir = await tempDir('af-content-file-kind-');
    await mkdir(join(projectDir, 'directory'));
    const source = new NodeRepositoryContentSource();

    await expect(source.readCandidate(projectDir, 'missing.txt')).resolves.toMatchObject({
      ok: false,
      errorCode: 'path_changed',
    });
    await expect(source.readCandidate(projectDir, 'directory')).resolves.toMatchObject({
      ok: false,
      errorCode: 'not_file',
    });
  });

  it('rejects even a contained symlink instead of opening an alias', async () => {
    const projectDir = await tempDir('af-content-contained-link-');
    await mkdir(join(projectDir, 'src'));
    await writeFile(join(projectDir, 'src', 'target.txt'), 'contained', 'utf8');
    await symlink(join(projectDir, 'src', 'target.txt'), join(projectDir, 'candidate.txt'));
    const result = await new NodeRepositoryContentSource().readCandidate(projectDir, 'candidate.txt');

    expect(result).toMatchObject({ ok: false, path: 'candidate.txt', errorCode: 'symlink' });
  });
});
