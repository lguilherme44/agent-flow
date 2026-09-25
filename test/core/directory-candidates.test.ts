import { describe, it, expect } from 'vitest';
import { directoryCandidates, mayNameDirectory } from '../../src/core/directory-candidates.js';

/**
 * FR-003 — which directories' own instructions a task receives, from its `files.likely`.
 *
 * The runner's isolation flags stop the CLI from loading a nested `CLAUDE.md` (measured
 * 24/09/2026), so these directories are the only route a monorepo's per-directory rules
 * have into a stage. A wrong answer here is either a rule silently missing or the reader
 * sent somewhere outside the repository.
 */

describe('deriving candidate directories (AC-03)', () => {
  it('names every ancestor of a file, root first, and never the root', () => {
    expect(directoryCandidates(['a/b/c.ts'])).toEqual(['a', 'a/b']);
  });

  it('lets an entry ending in / contribute itself', () => {
    expect(directoryCandidates(['a/b/'])).toEqual(['a', 'a/b']);
  });

  it('lets an entry the caller found to be a directory contribute itself', () => {
    expect(directoryCandidates(['a/b'], ['a/b'])).toEqual(['a', 'a/b']);
    // Positive control: the same entry, not known to be a directory, is a file in `a`.
    expect(directoryCandidates(['a/b'])).toEqual(['a']);
  });

  it('stops at the first segment carrying a wildcard', () => {
    expect(directoryCandidates(['src/*/x.ts'])).toEqual(['src']);
    expect(directoryCandidates(['src/a?/x.ts'])).toEqual(['src']);
    expect(directoryCandidates(['src/[ab]/x.ts'])).toEqual(['src']);
    expect(directoryCandidates(['src/app/**'])).toEqual(['src', 'src/app']);
    // A wildcard entry is never taken for a directory, even if the caller says so.
    expect(directoryCandidates(['src/*'], ['src/*'])).toEqual(['src']);
  });

  it('refuses entries that are not repository-relative paths', () => {
    for (const entry of ['/etc/x', 'C:/x', 'c:x', '../x', 'a/../b/c.ts', 'a\\b.ts', '']) {
      expect(directoryCandidates([entry]), JSON.stringify(entry)).toEqual([]);
    }
  });

  it('gives nothing for a file at the root', () => {
    expect(directoryCandidates(['README.md'])).toEqual([]);
  });

  it('never makes the root a candidate through . or empty segments', () => {
    expect(directoryCandidates(['./x.ts', '.', './'])).toEqual([]);
    expect(directoryCandidates(['./a//b/c.ts'])).toEqual(['a', 'a/b']);
  });

  it('names a directory reached from several entries once', () => {
    expect(directoryCandidates(['a/b/c.ts', 'a/b/d.ts', 'a/e.ts', 'a/b/'])).toEqual(['a', 'a/b']);
  });

  it('orders by depth, then by ordinal path', () => {
    const got = directoryCandidates(['z/y/x.ts', 'b/a.ts', 'B/a.ts', 'a/zz/q.ts', 'a/Z/q.ts']);

    // Ordinal, so upper case sorts before lower case whatever the machine's locale says.
    expect(got).toEqual(['B', 'a', 'b', 'z', 'a/Z', 'a/zz', 'z/y']);
  });

  it('gives nothing for nothing', () => {
    expect(directoryCandidates([])).toEqual([]);
  });
});

describe('which entries are worth asking the filesystem about', () => {
  it('asks only where the answer changes the result', () => {
    expect(mayNameDirectory('a/b')).toBe(true);
    expect(mayNameDirectory('docs')).toBe(true);

    expect(mayNameDirectory('a/b/')).toBe(false);
    expect(mayNameDirectory('src/*')).toBe(false);
    expect(mayNameDirectory('../x')).toBe(false);
    expect(mayNameDirectory('/etc')).toBe(false);
    expect(mayNameDirectory('C:/x')).toBe(false);
    expect(mayNameDirectory('a\\b')).toBe(false);
    expect(mayNameDirectory('')).toBe(false);
  });
});
