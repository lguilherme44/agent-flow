import { describe, expect, it } from 'vitest';
import { decideProjectTrust } from '../../src/config/trust.js';

/**
 * A `realPath` that answers with the path itself, and records every question.
 *
 * Where a test forbids touching the filesystem it asserts the record is empty, rather than
 * using a fake that throws: `decideProjectTrust` treats a throwing `realPath` as
 * "untrusted", so a throw would be swallowed and the test would pass for the wrong reason.
 */
function identityFs() {
  const asked: string[] = [];
  return {
    asked,
    fs: {
      realPath: (path: string): Promise<string | null> => {
        asked.push(path);
        return Promise.resolve(path);
      },
    },
  };
}

const trustList = (projectConfig: unknown) => ({ trust: { projectConfig } });

describe('decideProjectTrust (FR-022)', () => {
  describe('costs no filesystem operation without a list (AC-21)', () => {
    const cases: readonly [string, unknown][] = [
      ['no global file', null],
      ['no trust section', { runners: {} }],
      ['no projectConfig key', { trust: {} }],
      ['an empty list', trustList([])],
      ['a string where the list belongs', trustList('C:/wk')],
      ['a mapping where the list belongs', trustList({ '/wk': true })],
    ];

    for (const [label, globalRaw] of cases) {
      it(`answers false for ${label}`, async () => {
        const { fs, asked } = identityFs();

        await expect(
          decideProjectTrust({ fs, globalRaw, projectDir: '/wk/api', platform: 'linux' }),
        ).resolves.toBe(false);
        expect(asked).toEqual([]);
      });
    }

    it('positive control: the fake does record a call when a list exists', async () => {
      const { fs, asked } = identityFs();

      await decideProjectTrust({ fs, globalRaw: trustList(['/wk']), projectDir: '/wk/api', platform: 'linux' });

      expect(asked).not.toEqual([]);
    });
  });

  it('skips non-string entries without a TypeError', async () => {
    const { fs } = identityFs();

    await expect(
      decideProjectTrust({ fs, globalRaw: trustList([42, null, { path: '/wk' }, '/wk']), projectDir: '/wk/api', platform: 'linux' }),
    ).resolves.toBe(true);

    const untouched = identityFs();
    await expect(
      decideProjectTrust({ fs: untouched.fs, globalRaw: trustList([42]), projectDir: '/wk/api', platform: 'linux' }),
    ).resolves.toBe(false);
    expect(untouched.asked).toEqual([]);
  });

  it('answers false when realPath throws for the project', async () => {
    const fs = { realPath: (): Promise<string | null> => Promise.reject(new Error('EACCES')) };

    await expect(
      decideProjectTrust({ fs, globalRaw: trustList(['/wk']), projectDir: '/wk/api', platform: 'linux' }),
    ).resolves.toBe(false);
  });

  it('answers false when realPath returns null for the project', async () => {
    const fs = { realPath: (): Promise<string | null> => Promise.resolve(null) };

    await expect(
      decideProjectTrust({ fs, globalRaw: trustList(['/wk']), projectDir: '/wk/api', platform: 'linux' }),
    ).resolves.toBe(false);
  });

  it('skips an entry realPath cannot resolve, and still honours the next one', async () => {
    const fs = {
      realPath: (path: string): Promise<string | null> => {
        if (path === '/gone') return Promise.reject(new Error('ENOENT'));
        if (path === '/null') return Promise.resolve(null);
        return Promise.resolve(path);
      },
    };

    await expect(
      decideProjectTrust({ fs, globalRaw: trustList(['/gone', '/null']), projectDir: '/wk/api', platform: 'linux' }),
    ).resolves.toBe(false);
    await expect(
      decideProjectTrust({ fs, globalRaw: trustList(['/gone', '/null', '/wk']), projectDir: '/wk/api', platform: 'linux' }),
    ).resolves.toBe(true);
  });

  it('compares the resolved paths, so a symlinked checkout takes the trust of its target', async () => {
    const fs = {
      realPath: (path: string): Promise<string | null> =>
        Promise.resolve(path === '/links/api' ? '/elsewhere/api' : path),
    };

    await expect(
      decideProjectTrust({ fs, globalRaw: trustList(['/links']), projectDir: '/links/api', platform: 'linux' }),
    ).resolves.toBe(false);
    await expect(
      decideProjectTrust({ fs, globalRaw: trustList(['/elsewhere']), projectDir: '/links/api', platform: 'linux' }),
    ).resolves.toBe(true);
  });

  it('skips a relative entry rather than resolving it against the working directory', async () => {
    const { fs, asked } = identityFs();

    await expect(
      decideProjectTrust({ fs, globalRaw: trustList(['.', 'wk']), projectDir: '/wk/api', platform: 'linux' }),
    ).resolves.toBe(false);
    expect(asked).toEqual([]);
  });

  describe('on Windows (AC-21, NFR-005)', () => {
    it('trusts a child across case and separator spellings', async () => {
      const { fs } = identityFs();

      await expect(
        decideProjectTrust({ fs, globalRaw: trustList(['c:\\WK\\api\\']), projectDir: 'C:/wk/api/sub', platform: 'win32' }),
      ).resolves.toBe(true);
      await expect(
        decideProjectTrust({ fs, globalRaw: trustList(['c:\\WK\\api\\']), projectDir: 'C:\\wk\\api', platform: 'win32' }),
      ).resolves.toBe(true);
    });

    it('does not trust a sibling that shares a prefix', async () => {
      const { fs } = identityFs();

      await expect(
        decideProjectTrust({ fs, globalRaw: trustList(['c:\\WK\\api\\']), projectDir: 'C:/wk/api2', platform: 'win32' }),
      ).resolves.toBe(false);
    });

    it('does not trust another drive', async () => {
      const { fs } = identityFs();

      await expect(
        decideProjectTrust({ fs, globalRaw: trustList(['C:\\wk']), projectDir: 'D:\\wk\\api', platform: 'win32' }),
      ).resolves.toBe(false);
    });
  });

  describe('elsewhere', () => {
    it('compares case-sensitively', async () => {
      const { fs } = identityFs();

      await expect(
        decideProjectTrust({ fs, globalRaw: trustList(['/WK/api']), projectDir: '/wk/api/sub', platform: 'linux' }),
      ).resolves.toBe(false);
      // Positive control: the same spelling is trusted.
      await expect(
        decideProjectTrust({ fs, globalRaw: trustList(['/wk/api']), projectDir: '/wk/api/sub', platform: 'linux' }),
      ).resolves.toBe(true);
    });

    it('does not trust a sibling that shares a prefix', async () => {
      const { fs } = identityFs();

      await expect(
        decideProjectTrust({ fs, globalRaw: trustList(['/wk/api']), projectDir: '/wk/api2', platform: 'linux' }),
      ).resolves.toBe(false);
    });
  });
});
