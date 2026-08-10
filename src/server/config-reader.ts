import type { ConfigSectionView, ConfigSettingView, ConfigView } from '../contracts/index.js';
import { readSettingOrigins, type SettingOrigins } from '../app/config-origins.js';
import { ConfigError, loadConfig } from '../config/loader.js';
import type { EffectiveConfig } from '../contracts/index.js';
import type { FileSystem } from '../ports/index.js';
import type { RegisteredProject } from './project-registry.js';

/**
 * The effective configuration, sectioned as §85 asks (UI-26).
 *
 * Read-only, and every value carries the layer that produced it. That is the part
 * worth having: "parallelism is 1" invites an edit to the wrong file, while
 * "parallelism is 1, from this project's override" says where to look.
 *
 * Three sections the spec names have no keys behind them, and each says so rather
 * than showing a plausible blank. **Models** is the routing table, which has its
 * own page and would be a second place to read the same thing. **UI** has no
 * persisted settings at all — the dashboard keeps its preferences in the browser
 * and the server has none to report. **Retention** is a flag on `agent-flow clean`
 * rather than configuration, so there is nothing here to show or to change.
 * Inventing rows for them would present three settings nothing reads.
 *
 * Nothing here opens an auth file, reads an environment variable, or reports a
 * secret. The only files it touches are the two config YAMLs and the defaults
 * compiled into the binary — which is the same boundary §93 draws for the whole
 * server.
 */

export interface ConfigReaderOptions {
  readonly fs: FileSystem;
  readonly globalConfigPath: string;
}

export class ConfigReader {
  constructor(private readonly options: ConfigReaderOptions) {}

  async describe(project: RegisteredProject): Promise<ConfigView> {
    const origins = await readSettingOrigins({
      fs: this.options.fs,
      globalConfigPath: this.options.globalConfigPath,
      projectDir: project.path,
    });

    const sources = {
      globalPath: origins.globalPath,
      globalPresent: origins.globalPresent,
      projectPath: origins.projectPath,
      projectPresent: origins.projectPresent,
    };

    let config: EffectiveConfig;
    try {
      config = await loadConfig({
        fs: this.options.fs,
        globalConfigPath: this.options.globalConfigPath,
        projectDir: project.path,
      });
    } catch (error) {
      // A broken config is a state the page has to show, not a request that
      // failed: the sources are exactly what somebody needs in order to fix it, so
      // they come back alongside the reason rather than instead of it.
      return {
        sources,
        sections: [],
        configError:
          error instanceof ConfigError || error instanceof Error
            ? error.message
            : 'The configuration could not be read.',
      };
    }

    return { sources, sections: sectionsOf(config, origins, project) };
  }
}

function sectionsOf(
  config: EffectiveConfig,
  origins: SettingOrigins,
  project: RegisteredProject,
): ConfigSectionView[] {
  const setting = (
    key: string,
    label: string,
    value: string,
    note?: string,
  ): ConfigSettingView => ({
    key,
    label,
    value,
    origin: origins.originOf(key) ?? 'default',
    ...(note === undefined ? {} : { note }),
  });

  const global = config.global;
  const overlay = config.project;

  return [
    {
      id: 'general',
      title: 'General',
      settings: [
        setting('version', 'Config version', String(global.version)),
        {
          key: 'sources.global',
          label: 'Global config',
          value: origins.globalPath,
          origin: origins.globalPresent ? 'global' : 'default',
          note: origins.globalPresent
            ? undefined
            : 'not present — the built-in defaults are in force',
        },
        {
          key: 'sources.project',
          label: 'Project config',
          value: origins.projectPath,
          origin: origins.projectPresent ? 'project' : 'default',
          ...(origins.projectPresent ? {} : { note: 'not present' }),
        },
      ],
    },
    {
      id: 'workspace',
      title: 'Workspace',
      settings: [
        setting('project.name', 'Project name', overlay?.project.name ?? project.name),
        setting('project.type', 'Detected stack', overlay?.project.type ?? 'not detected'),
        setting('paths.source', 'Source paths', list(overlay?.paths.source)),
        setting('paths.tests', 'Test paths', list(overlay?.paths.tests)),
        setting('rules.architecture', 'Architecture rules', count(overlay?.rules.architecture)),
      ],
    },
    {
      id: 'runners',
      title: 'Runners',
      settings: Object.entries(global.runners).map(([id, runner]) =>
        setting(
          `runners.${id}`,
          id,
          [
            runner.type,
            runner.enabled ? 'enabled' : 'disabled',
            runner.command === undefined ? undefined : `command ${runner.command}`,
          ]
            .filter((part): part is string => part !== undefined)
            .join(' · '),
        ),
      ),
    },
    {
      id: 'models',
      title: 'Models',
      note: 'Role routing has its own page, which resolves each role against what its runner can actually do.',
      settings: [],
    },
    {
      id: 'execution',
      title: 'Execution',
      settings: [
        setting(
          'approval.requiredBeforeImplementation',
          'Approval before implementation',
          global.approval.requiredBeforeImplementation ? 'required' : 'not required',
          global.approval.requiredBeforeImplementation
            ? undefined
            : 'implementation can start without a human opening the gate',
        ),
        setting(
          'parallelism.maxTasks',
          'Parallel tasks',
          String(global.parallelism.maxTasks),
          global.parallelism.maxTasks > 1
            ? 'more than one task at a time needs worktrees to stop them colliding'
            : undefined,
        ),
        setting('retry.maxAttempts', 'Attempts per task', String(global.retry.maxAttempts)),
        setting('git.useWorktrees', 'Git worktrees', global.git.useWorktrees ? 'on' : 'off'),
        setting(
          'fallback.enabled',
          'Fallback',
          global.fallback.enabled ? 'enabled' : 'disabled',
        ),
        setting(
          'fallback.on',
          'Fallback triggers',
          global.fallback.on.join(', '),
          'infrastructure failures only — a capability gap is never routed around',
        ),
        setting(
          'validationCommands',
          'Extra validation commands',
          count(Object.keys(overlay?.validationCommands ?? {})),
          'a plan names one of these by id; nothing a model writes reaches a shell',
        ),
      ],
    },
    {
      id: 'ui',
      title: 'UI',
      note: 'The dashboard keeps its preferences in the browser. There is no server-side UI configuration to show.',
      settings: [],
    },
    {
      id: 'retention',
      title: 'Retention',
      note: 'Run history is pruned on request rather than on a policy: agent-flow clean --keep <n>. There is no retention setting to read.',
      settings: [],
    },
  ];
}

function list(values: readonly string[] | undefined): string {
  return values === undefined || values.length === 0 ? 'not set' : values.join(', ');
}

function count(values: readonly string[] | undefined): string {
  const total = values?.length ?? 0;
  return total === 0 ? 'none' : `${String(total)} declared`;
}
