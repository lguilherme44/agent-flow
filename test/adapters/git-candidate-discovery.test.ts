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
  it('discovers tracked files in a git repository including spaces and unicode', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('app.ts', 'export const app = 1;');
    repo.write('my helper.ts', 'export const helper = 2;');
    repo.write('ação.ts', 'export const acao = 3;');
    repo.write('.env', 'SECRET=xyz');
    repo.commitAll('add files');

    const client = new GitClient(repo.git, repo.dir);
    const discovery = new GitCandidateDiscovery(client);

    const candidates = await discovery.discoverCandidates(repo.dir);
    expect(candidates).toContain('README.md');
    expect(candidates).toContain('app.ts');
    expect(candidates).toContain('my helper.ts');
    expect(candidates).toContain('ação.ts');
    // .env should be excluded by candidate filtering even if tracked
    expect(candidates).not.toContain('.env');
  });

  it('selects candidates matching objective when objective is provided', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('payment-service.ts', 'export const payment = 1;');
    repo.write('auth-handler.ts', 'export const auth = 2;');
    repo.commitAll('add services');

    const client = new GitClient(repo.git, repo.dir);
    const discovery = new GitCandidateDiscovery(client, { maxCandidates: 1 });

    const paymentCandidates = await discovery.discoverCandidates(repo.dir, 'fix payment service');
    expect(paymentCandidates).toEqual(['payment-service.ts']);

    const authCandidates = await discovery.discoverCandidates(repo.dir, 'fix auth login handler');
    expect(authCandidates).toEqual(['auth-handler.ts']);
  });

  it('returns empty array when not in a git repository without throwing', async () => {
    repo = await makeTempRepoWithCommit();
    const client = new GitClient(repo.git, repo.home);
    const discovery = new GitCandidateDiscovery(client);

    const candidates = await discovery.discoverCandidates(repo.home);
    expect(candidates).toEqual([]);
  });
});
