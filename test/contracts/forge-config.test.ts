import { describe, it, expect } from 'vitest';
import { GlobalConfigSchema, ForgeConfigSchema, ForgeRepositorySchema } from '../../src/contracts/index.js';

/**
 * Remote delivery is opt-in, and this is where that is a fact rather than an intention.
 *
 * The charter's §21 and §22: the provider defaults to none, every write is separately off,
 * and a repository overlay cannot turn any of it on. A default that lets a run reach the
 * network because a remote happens to be a GitHub URL would be the whole milestone's
 * premise inverted.
 */

const MINIMAL = {
  runners: { claude: { type: 'claude-code-cli' } },
  roles: {
    architect: { runner: 'claude', effort: 'high' },
    sdd: { runner: 'claude', effort: 'high' },
    planner: { runner: 'claude', effort: 'high' },
    planReviewer: { runner: 'claude', effort: 'high' },
    executors: {
      trivial: { runner: 'claude', effort: 'low' },
      normal: { runner: 'claude', effort: 'medium' },
      complex: { runner: 'claude', effort: 'high' },
    },
    verification: { runner: 'claude', effort: 'medium' },
    finalReviewer: { runner: 'claude', effort: 'high' },
  },
};

describe('M7-ACC-01 — the provider defaults to none', () => {
  it('is none in a configuration that never mentions forge', () => {
    expect(GlobalConfigSchema.parse(MINIMAL).forge.provider).toBe('none');
  });

  it('is none even in an explicit but empty forge block', () => {
    expect(ForgeConfigSchema.parse({}).provider).toBe('none');
  });
});

describe('M7-ACC-02 — a legacy configuration authorises no network write', () => {
  it('leaves every write off', () => {
    const forge = GlobalConfigSchema.parse(MINIMAL).forge;

    expect(forge.publish.enabled).toBe(false);
    expect(forge.publish.autoAfterCompletion).toBe(false);
    expect(forge.issues).toEqual({ create: false, comment: false });
    expect(forge.pullRequests).toEqual({ create: false, update: false, postSummary: false });
    expect(forge.checks.read).toBe(false);
  });

  it('leaves every write off even when a provider is chosen', () => {
    // Choosing GitHub is naming a destination. It is not consent to write to it.
    const forge = ForgeConfigSchema.parse({ provider: 'github' });

    expect(forge.provider).toBe('github');
    expect(forge.publish.enabled).toBe(false);
    expect(forge.pullRequests.create).toBe(false);
  });
});

describe('M7-ACC-06 — the token is named, never carried', () => {
  it('defaults to a variable name', () => {
    expect(ForgeConfigSchema.parse({}).github.tokenEnv).toBe('GITHUB_TOKEN');
  });

  it('refuses anything that is not an environment variable name', () => {
    // The shape of the mistake this prevents: pasting the token itself into `tokenEnv`.
    expect(() => ForgeConfigSchema.parse({ github: { tokenEnv: 'ghp_realLookingToken' } })).toThrow();
  });

  it('has no field a token could be stored in', () => {
    const parsed = ForgeConfigSchema.parse({ provider: 'github' });

    expect(Object.keys(parsed.github)).toEqual(['tokenEnv', 'apiBaseUrl']);
  });

  it('pins the API host, so a config cannot point the token somewhere else', () => {
    expect(() =>
      ForgeConfigSchema.parse({ github: { apiBaseUrl: 'https://evil.example' } }),
    ).toThrow();
  });
});

describe('a repository is three fields, validated', () => {
  it('accepts an ordinary owner and repo', () => {
    expect(
      ForgeRepositorySchema.parse({ host: 'github.com', owner: 'lguilherme44', repo: 'agent-flow' }),
    ).toEqual({ host: 'github.com', owner: 'lguilherme44', repo: 'agent-flow' });
  });

  it('refuses an owner that could be a path traversal or a flag', () => {
    for (const owner of ['../etc', '-oProxyCommand', 'a/b', '']) {
      expect(() =>
        ForgeRepositorySchema.parse({ host: 'github.com', owner, repo: 'agent-flow' }),
      ).toThrow();
    }
  });

  it('refuses a repository name with a slash or a space', () => {
    for (const repo of ['a/b', 'a b', '']) {
      expect(() =>
        ForgeRepositorySchema.parse({ host: 'github.com', owner: 'o', repo }),
      ).toThrow();
    }
  });
});

describe('budgets exist and are finite', () => {
  it('bounds every loop the adapter can enter', () => {
    const budgets = ForgeConfigSchema.parse({}).budgets;

    for (const value of Object.values(budgets)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});
