import { describe, expect, it } from 'vitest';
import { fileNamedEnv, patternNamesEnvFile } from '../../src/core/env-exposure.js';

describe('rule (a): a worktree.copy pattern that names a .env file (FR-018)', () => {
  it.each(['.env', '.env.local', '.env.test', '.env.*', 'config/.env.local', '**/.env*'])(
    'warns for %s, by its last segment read as text',
    (pattern) => {
      expect(patternNamesEnvFile(pattern)).toBe(true);
    },
  );

  // Every one of these would match a `.env` under a glob matcher; that is exactly the test
  // this rule refuses to be, so a matcher slipped in here turns these red.
  it.each(['*.json', '*.yaml.example', 'config/*.yaml.example', 'config/*', '**/*', 'certs/dev.pem'])(
    'does not warn for %s, whatever it would match',
    (pattern) => {
      expect(patternNamesEnvFile(pattern)).toBe(false);
    },
  );

  it('reads only the last segment, so a .env directory higher up names nothing', () => {
    expect(patternNamesEnvFile('.env.d/app.conf')).toBe(false);
  });
});

describe("rule (b)'s test for one listed file", () => {
  it('is true for a file whose name starts with .env, at any depth', () => {
    expect(fileNamedEnv('.env')).toBe(true);
    expect(fileNamedEnv('config/.env.local')).toBe(true);
  });

  it('is false for any other name, including a file inside a .env directory', () => {
    expect(fileNamedEnv('app.yaml.example')).toBe(false);
    expect(fileNamedEnv('.env.d/app.conf')).toBe(false);
    expect(fileNamedEnv('config/local.env')).toBe(false);
  });
});
