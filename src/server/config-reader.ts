import type { ConfigSectionView, ConfigSettingView, ConfigView } from '../contracts/index.js';
import { en, type Phrases } from '../core/phrases/index.js';
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

  async describe(project: RegisteredProject, say?: Phrases): Promise<ConfigView> {
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
            : (say ?? en).config.configUnreadable,
      };
    }

    return { sources, sections: sectionsOf(config, origins, project, say ?? en) };
  }
}

function sectionsOf(
  config: EffectiveConfig,
  origins: SettingOrigins,
  project: RegisteredProject,
  say: Phrases,
): ConfigSectionView[] {
  const t = say.config;
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
      title: t.general,
      settings: [
        setting('version', t.configVersion, String(global.version)),
        {
          key: 'sources.global',
          label: t.globalConfig,
          value: origins.globalPath,
          origin: origins.globalPresent ? 'global' : 'default',
          note: origins.globalPresent ? undefined : t.notPresentDefaults,
        },
        {
          key: 'sources.project',
          label: t.projectConfig,
          value: origins.projectPath,
          origin: origins.projectPresent ? 'project' : 'default',
          ...(origins.projectPresent ? {} : { note: t.notPresent }),
        },
      ],
    },
    {
      id: 'workspace',
      title: t.workspace,
      settings: [
        setting('project.name', t.projectName, overlay?.project.name ?? project.name),
        setting('project.type', t.detectedStack, overlay?.project.type ?? t.notDetected),
        setting('paths.source', t.sourcePaths, list(overlay?.paths.source, t)),
        setting('paths.tests', t.testPaths, list(overlay?.paths.tests, t)),
        setting('rules.architecture', t.architectureRules, count(overlay?.rules.architecture, t)),
      ],
    },
    {
      id: 'runners',
      title: t.runners,
      settings: Object.entries(global.runners).map(([id, runner]) =>
        setting(
          `runners.${id}`,
          id,
          [
            runner.type,
            runner.enabled ? t.enabled : t.disabled,
            runner.command === undefined ? undefined : t.commandIs(runner.command),
          ]
            .filter((part): part is string => part !== undefined)
            .join(' · '),
        ),
      ),
    },
    {
      id: 'models',
      title: t.models,
      note: t.roleRoutingHasItsOwnPage,
      settings: [],
    },
    {
      id: 'execution',
      title: t.execution,
      settings: [
        setting(
          'approval.requiredBeforeImplementation',
          t.approvalBeforeImplementation,
          global.approval.requiredBeforeImplementation ? t.required : t.notRequired,
          global.approval.requiredBeforeImplementation ? undefined : t.canStartWithoutGate,
        ),
        setting(
          'parallelism.maxTasks',
          t.parallelTasks,
          String(global.parallelism.maxTasks),
          // The note has to say what the *runtime* does, not what the setting
          // would like to. It used to read as though switching worktrees on were
          // the missing step, and worktrees did not exist in the execution path —
          // so a reader who followed it would have configured four parallel tasks
          // and got one, with nothing on this page admitting it. Since M2-11 they
          // do exist, and the note says which kind of run gets which number.
          concurrencyNote(global.parallelism.maxTasks, global.git.useWorktrees, t),
        ),
        setting('retry.maxAttempts', t.attemptsPerTask, String(global.retry.maxAttempts)),
        setting('git.useWorktrees', t.gitWorktrees, global.git.useWorktrees ? t.on : t.off),
        setting(
          'fallback.enabled',
          t.fallback,
          global.fallback.enabled ? t.enabled : t.disabled,
        ),
        setting(
          'fallback.on',
          t.fallbackTriggers,
          global.fallback.on.join(', '),
          t.infrastructureOnly,
        ),
        setting(
          'validationCommands',
          t.extraValidationCommands,
          count(Object.keys(overlay?.validationCommands ?? {}), t),
          t.planNamesById,
        ),
      ],
    },
    {
      id: 'ui',
      title: t.ui,
      note: t.everythingElseInBrowser,
      settings: [
        setting(
          'ui.workspaceDepth',
          t.workspaceScanDepth,
          String(global.ui.workspaceDepth),
          t.scanDepthNote,
        ),
      ],
    },
    {
      id: 'retention',
      title: t.retention,
      note: t.retentionNote,
      settings: [],
    },
  ];
}

function list(values: readonly string[] | undefined, t: Phrases['config']): string {
  return values === undefined || values.length === 0 ? t.notSet : values.join(', ');
}

function count(values: readonly string[] | undefined, t: Phrases['config']): string {
  const total = values?.length ?? 0;
  return total === 0 ? t.none : t.declared(total);
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
function concurrencyNote(
  maxTasks: number,
  useWorktrees: boolean,
  t: Phrases['config'],
): string | undefined {
  // Both answers, because the difference between them is the whole point of the
  // setting above and this is the only place a reader sees the two side by side.
  const isolated = resolveTaskConcurrency(maxTasks, 'worktree');
  const shared = resolveTaskConcurrency(maxTasks, 'none');

  if (!isolated.clamped && !shared.clamped) return undefined;

  if (!useWorktrees) return t.configuredNotEffective(shared.effective);

  return t.newRunsExecuteUpTo(isolated.effective, shared.effective);
}
