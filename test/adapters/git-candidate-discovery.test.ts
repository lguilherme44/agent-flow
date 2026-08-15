import { describe, it, expect, afterEach } from 'vitest';
import { GitClient } from '../../src/adapters/git/git-client.js';
import { GitCandidateDiscovery } from '../../src/adapters/git/git-candidate-discovery.js';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

describe('GitCandidateDiscovery (M3-04)', () => {
  it('discovers tracked files in a git repository', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('app.ts', 'export const app = 1;');
    repo.write('util.ts', 'export const util = 2;');
    repo.write('.env', 'SECRET=xyz');
    repo.commitAll('add files');

    const client = new GitClient(repo.git, repo.dir);
    const discovery = new GitCandidateDiscovery(client);

    const candidates = await discovery.discoverCandidates(repo.dir);
    expect(candidates).toContain('README.md');
    expect(candidates).toContain('app.ts');
    expect(candidates).toContain('util.ts');
    // .env should be excluded by candidate filtering even if tracked
    expect(candidates).not.toContain('.env');
  });

  it('returns empty array when not in a git repository without throwing', async () => {
    repo = await makeTempRepoWithCommit();
    const client = new GitClient(repo.git, repo.home);
    const discovery = new GitCandidateDiscovery(client);

    const candidates = await discovery.discoverCandidates(repo.home);
    expect(candidates).toEqual([]);
  });
});
