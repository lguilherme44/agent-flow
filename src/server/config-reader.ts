import type { ConfigSectionView, ConfigSettingView, ConfigView } from '../contracts/index.js';
import { readSettingOrigins, type SettingOrigins } from '../app/config-origins.js';
import { ConfigError, loadConfig } from '../config/loader.js';
import { resolveTaskConcurrency } from '../core/concurrency.js';
import type { EffectiveConfig } from '../contracts/index.js';
import type { FileSystem } from '../ports/index.js';
import type { RegisteredProject } from './project-registry.js';
import type { ProjectRegistry } from './project-registry.js';
import { createConfigEditor, type ConfigEditor } from '../app/config-editor.js';
import { YamlConfigSourceCodec } from '../adapters/config/yaml-config-source-codec.js';
import { SchemaConfigSemanticValidator } from '../adapters/config/semantic-validator.js';

/**
 * The effective configuration, sectioned as §85 asks (UI-26).
 *
 * Read-only, and every value carries the layer that produced it. That is the part
 * worth having: "parallelism is 1" invites an edit to the wrong file, while
 * "parallelism is 1, from this project's override" says where to look.
 *
 * Two sections the spec names have no keys behind them, and each says so rather
 * than showing a plausible blank. **Models** is the routing table, which has its
 * own page and would be a second place to read the same thing. **Retention** is a
 * flag on `agent-flow clean` rather than configuration, so there is nothing here
 * to show or to change. Inventing rows for them would present settings nothing
 * reads.
 *
 * **UI** used to be the third, and stopped being one with UI-29: `ui.workspaceDepth`
 * decides how far `agent-flow ui ~/wk` looks for projects, which is to say what
 * this server will serve at all. That belongs on a page about what is configured.
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

/**
 * Composition root for the writable configuration Module.
 *
 * Keeping project lookup here makes the HTTP adapter incapable of converting a
 * client-controlled string into a path. The CLI composes the same Module with a
 * single current-project resolver.
 */
export function createServerConfigEditor(options: {
  readonly fs: FileSystem;
  readonly globalConfigPath: string;
  readonly registry: ProjectRegistry;
}): ConfigEditor {
  return createConfigEditor({
    fs: options.fs,
    codec: new YamlConfigSourceCodec(),
    semanticValidator: new SchemaConfigSemanticValidator(),
    globalConfigPath: options.globalConfigPath,
    resolveProjectDir: (projectId) => options.registry.get(projectId)?.path,
  });
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
          // The note has to say what the *runtime* does, not what the setting
          // would like to. It used to read as though switching worktrees on were
          // the missing step, and worktrees did not exist in the execution path —
          // so a reader who followed it would have configured four parallel tasks
          // and got one, with nothing on this page admitting it. Since M2-11 they
          // do exist, and the note says which kind of run gets which number.
          concurrencyNote(global.parallelism.maxTasks, global.git.useWorktrees),
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
      note: 'Everything else the dashboard remembers — filters, tabs, which task is open — lives in the browser.',
      settings: [
        setting(
          'ui.workspaceDepth',
          'Workspace scan depth',
          String(global.ui.workspaceDepth),
          'how far under a workspace root `agent-flow ui ~/wk` looks for projects; a directory beyond it is not discovered and not served',
        ),
      ],
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

/**
 * What a configured task limit actually does, when the two differ.
 *
 * The number on this page is the configured one, which is right — this is a page
 * about configuration, and every row here carries the layer it came from. What it
 * must not do is let the reader infer the runtime from it. Resolved through the
 * same function the scheduler is wired from, so the sentence cannot fall behind
 * the behaviour it describes.
 *
 * **This page has no run, and that is why it reads `git.useWorktrees` at all.** It
 * is answering "what would this configuration do to a run created now", which is
 * the one question the flag legitimately decides (§6.1). Every *execution* and
 * every *run* page reads `state.isolationMode` instead, because a run created
 * before this setting was touched is not governed by it (I-13, §6.4).
 */
function concurrencyNote(maxTasks: number, useWorktrees: boolean): string | undefined {
  // Both answers, because the difference between them is the whole point of the
  // setting above and this is the only place a reader sees the two side by side.
  const isolated = resolveTaskConcurrency(maxTasks, 'worktree');
  const shared = resolveTaskConcurrency(maxTasks, 'none');

  if (!isolated.clamped && !shared.clamped) return undefined;

  if (!useWorktrees) {
    return (
      `configured, not effective: without isolated workspaces a run executes ` +
      `${String(shared.effective)} task at a time — turn on git.useWorktrees, then start a new run`
    );
  }

  return (
    `new runs execute up to ${String(isolated.effective)} at a time in isolated workspaces; ` +
    `a run created before worktrees were on still executes ${String(shared.effective)}`
  );
}
