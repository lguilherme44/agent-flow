import { describe, it, expect } from 'vitest';
import { parseRepositoryUrl, sameRepository } from '../../../src/core/forge/repository.js';

/**
 * M7-ACC-03 and M7-ACC-05: a repository is identified mechanically, and a mismatch refuses.
 *
 * The failure this prevents is publishing into somebody else's repository because two
 * spellings of one URL did not match as strings.
 */

const AF = { host: 'github.com', owner: 'lguilherme44', repo: 'agent-flow' };

describe('M7-ACC-03 — every spelling of one repository normalises to one identity', () => {
  it.each([
    'https://github.com/lguilherme44/agent-flow.git',
    'https://github.com/lguilherme44/agent-flow',
    'git@github.com:lguilherme44/agent-flow.git',
    'git@github.com:lguilherme44/agent-flow',
    'ssh://git@github.com/lguilherme44/agent-flow.git',
    'https://GitHub.com/lguilherme44/agent-flow.git',
    '  https://github.com/lguilherme44/agent-flow.git  ',
  ])('reads %s', (url) => {
    expect(parseRepositoryUrl(url)).toEqual(AF);
  });
});

describe('what it refuses rather than guesses', () => {
  it.each([
    ['a local path', '/Users/someone/wk/agent-flow'],
    ['a file remote', 'file:///Users/someone/wk/agent-flow'],
    ['no repository', 'https://github.com/lguilherme44'],
    ['a group of groups', 'https://gitlab.com/group/subgroup/project.git'],
    ['empty', ''],
    ['a traversal in the owner', 'https://github.com/../etc/passwd'],
    ['an owner that looks like a flag', 'git@github.com:-oProxyCommand=x/repo.git'],
    ['a space', 'https://github.com/own er/repo.git'],
  ])('refuses %s', (_why, url) => {
    expect(parseRepositoryUrl(url)).toBeUndefined();
  });

  /**
   * The reason `scpLike` is anchored. An unanchored pattern that merely finds `owner/repo`
   * somewhere reads this as GitHub and hands a token to `evil.example`.
   */
  it('does not read a hostile string as GitHub because GitHub appears in it', () => {
    const parsed = parseRepositoryUrl('git@evil.example:x/y#github.com/lguilherme44/agent-flow');

    expect(parsed?.host).not.toBe('github.com');
  });
});

describe('M7-ACC-05 — comparison is by field, not by string', () => {
  it('matches two spellings of the same repository', () => {
    const a = parseRepositoryUrl('git@github.com:lguilherme44/agent-flow.git');
    const b = parseRepositoryUrl('https://github.com/lguilherme44/agent-flow');

    expect(a && b && sameRepository(a, b)).toBe(true);
  });

  it('ignores case, which GitHub does', () => {
    expect(sameRepository(AF, { ...AF, owner: 'LGuilherme44' })).toBe(true);
  });

  it('separates two repositories that differ in one field', () => {
    expect(sameRepository(AF, { ...AF, repo: 'agent-flow-fork' })).toBe(false);
    expect(sameRepository(AF, { ...AF, owner: 'someone-else' })).toBe(false);
    expect(sameRepository(AF, { ...AF, host: 'gitlab.com' })).toBe(false);
  });
});
