import { describe, expect, it } from 'vitest';
import { readSettingOrigins } from '../../src/app/config-origins.js';
import { loadConfig } from '../../src/config/loader.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';

const HOME = '/home/u';
const GLOBAL_PATH = `${HOME}/.agent-flow/config.yaml`;
const PROJECT_DIR = '/repo';
const PROJECT_PATH = `${PROJECT_DIR}/.agent-flow/config.yaml`;
const projectYaml =
  'project:\n  name: some-api\n  type: node\n' +
  'approval:\n  requiredBeforeImplementation: false\n' +
  'runners:\n  claude:\n    dangerouslySkipPermissions: true\n';

const origins = (fs: InMemoryFileSystem, projectDir = PROJECT_DIR) =>
  readSettingOrigins({ fs, globalConfigPath: GLOBAL_PATH, projectDir, platform: 'linux' });

describe('readSettingOrigins and project trust (FR-027)', () => {
  it('never attributes a loosening an untrusted project was refused to the project (AC-22)', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(GLOBAL_PATH, 'approval:\n  requiredBeforeImplementation: true\n');
    fs.seed(PROJECT_PATH, projectYaml);

    const read = await origins(fs);
    const config = await loadConfig({ fs, globalConfigPath: GLOBAL_PATH, projectDir: PROJECT_DIR });

    // The value the runtime runs on, and the layer that says it supplied it, agree.
    expect(config.global.approval.requiredBeforeImplementation).toBe(true);
    expect(read.originOf('approval.requiredBeforeImplementation')).toBe('global');
    expect(read.originOf('runners.claude.dangerouslySkipPermissions')).not.toBe('project');
    // Positive control: the project file was read, and its own keys are still its own.
    expect(read.originOf('project.name')).toBe('project');
  });

  it('attributes the same values to the project once the global list trusts it', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(GLOBAL_PATH, `trust:\n  projectConfig: [${PROJECT_DIR}]\n`);
    fs.seed(PROJECT_PATH, projectYaml);

    const read = await origins(fs);

    expect(read.originOf('approval.requiredBeforeImplementation')).toBe('project');
    expect(read.originOf('runners.claude.dangerouslySkipPermissions')).toBe('project');
  });

  it('ignores a trust list written in the project file itself (SEC-001)', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJECT_PATH, `${projectYaml}trust:\n  projectConfig: [${PROJECT_DIR}]\n`);

    const read = await origins(fs);

    expect(read.originOf('approval.requiredBeforeImplementation')).not.toBe('project');
  });

  it('attributes nothing to a project when run from the home directory', async () => {
    // From home the project path *is* the global file. Read twice, every global value
    // came back as the project's.
    const fs = new InMemoryFileSystem();
    fs.seed(GLOBAL_PATH, 'parallelism:\n  maxTasks: 3\n');

    const read = await origins(fs, HOME);

    expect(read.projectPresent).toBe(false);
    expect(read.originOf('parallelism.maxTasks')).toBe('global');
  });

  it('positive control: a real project directory does attribute its override', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(GLOBAL_PATH, 'parallelism:\n  maxTasks: 3\n');
    fs.seed(PROJECT_PATH, 'project:\n  name: x\n  type: node\nparallelism:\n  maxTasks: 2\n');

    const read = await origins(fs);

    expect(read.projectPresent).toBe(true);
    expect(read.originOf('parallelism.maxTasks')).toBe('project');
  });
});
