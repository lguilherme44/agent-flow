import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { loadConfig, ConfigError } from '../../src/config/loader.js';
import { ValidationIdSchema } from '../../src/contracts/common.schema.js';

const GLOBAL_PATH = '/home/u/.agent-flow/config.yaml';
const PROJECT_PATH = '/repo/.agent-flow/config.yaml';

const load = (fs: InMemoryFileSystem) =>
  loadConfig({ fs, globalConfigPath: GLOBAL_PATH, projectDir: '/repo' });

function projectWith(validationCommands: string): InMemoryFileSystem {
  const fs = new InMemoryFileSystem();
  fs.seed(
    PROJECT_PATH,
    `
project:
  name: demo
  type: node
validationCommands:
${validationCommands}
`,
  );
  return fs;
}

/**
 * Measured on a real run (abastecepro, 2026-10-05): `test:frontend` passed the config,
 * doctor listed it as runnable, and the planner could not cite it because the plan
 * schema only takes `[a-z0-9-]`. The run spent a revision cycle on the detour. The
 * config must refuse what the plan cannot reference.
 */
describe('validationCommands keys are plan-citable ids', () => {
  it('accepts ids a plan may cite', async () => {
    const config = await load(projectWith('  test-frontend: npm run test:frontend\n  contract: npm run test:contract'));
    expect(Object.keys(config.project?.validationCommands ?? {})).toEqual(['test-frontend', 'contract']);
  });

  it('refuses an id the plan schema would reject, naming the key', async () => {
    const fs = projectWith('  test:frontend: npm run test:frontend');
    await expect(load(fs)).rejects.toBeInstanceOf(ConfigError);
    await expect(load(fs)).rejects.toThrow(/test:frontend|validationCommands/);
  });

  it('uses the same rule as a plan task validation entry', () => {
    // One rule in one place: if the plan schema ever widens, the config follows.
    expect(ValidationIdSchema.safeParse('test-frontend').success).toBe(true);
    expect(ValidationIdSchema.safeParse('test:frontend').success).toBe(false);
  });
});
