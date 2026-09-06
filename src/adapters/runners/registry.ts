import {
  ALL_WORKFLOW_ROLES,
  roleConfigOf,
  type GlobalConfig,
  type RunnerConfig,
} from '../../contracts/index.js';
import type {
  AgentRunner,
  RunnerCapabilities,
  RunnerCapabilityEntry,
  RunnerHealth,
} from '../../ports/agent-runner.js';
import type { ProcessRunner } from '../../ports/process-runner.js';
import type { FileSystem } from '../../ports/file-system.js';
import { ClaudeCodeRunner } from './claude-code-runner.js';
import { CodexRunner } from './codex-runner.js';
import { AgyRunner } from './agy-runner.js';
import { OpenAiRunner } from './openai-runner.js';

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

export interface RegistryDependencies {
  readonly processRunner: ProcessRunner;
  /** Some adapters must write temp files; see the codex-cli factory. */
  readonly fs: FileSystem;
  /**
   * Reads an environment variable by name, for a runner configured with `apiKeyEnv`.
   *
   * Injected rather than reaching for `process.env`, for the reason every other port is:
   * a factory that reads the process environment directly is a factory only one caller
   * can drive, and the value it reads is a credential a test must be able to withhold.
   */
  readonly env?: (name: string) => string | undefined;
}

/**
 * What `execution` tells the adapters about the process they are about to spawn.
 *
 * One object rather than a growing list of positionals: this is the second such setting
 * and the fourth argument was already easy to pass in the wrong order. Handed to the CLI
 * adapters and to none of the others — `openai-compatible` spawns nothing, so a process
 * policy would be a field it could only ignore.
 */
export interface RunnerSpawnPolicy {
  /**
   * `execution.passEnv` — extra names a spawned agent may inherit (PRI-17).
   *
   * Read from the configuration here rather than asked of every caller. There are four
   * `buildRegistry` call sites and a fifth would be added without this line being
   * anywhere in view; the failure of forgetting it is silent, and its shape is an
   * operator whose declared variable simply never arrives.
   */
  readonly envPass: readonly string[];
  /**
   * `execution.isolateRunnerSettings` — whether the CLI is cut off from the operator's own
   * customisations (PRI-18).
   */
  readonly isolateSettings: boolean;
}

type RunnerFactory = (
  id: string,
  config: RunnerConfig,
  deps: RegistryDependencies,
  policy: RunnerSpawnPolicy,
) => AgentRunner;

/**
 * The single place that maps a configured `type` to a concrete adapter.
 *
 * This table is the only spot in the codebase allowed to know that a runner
 * called "claude-code-cli" exists. Adding a runner means adding one entry here
 * and one adapter file — no workflow code, no stage, no prompt changes.
 */
const FACTORIES: Readonly<Record<string, RunnerFactory>> = {
  'claude-code-cli': (id, config, deps, policy) =>
    new ClaudeCodeRunner({
      id,
      processRunner: deps.processRunner,
      envPass: policy.envPass,
      isolateSettings: policy.isolateSettings,
      ...(config.command === undefined ? {} : { command: config.command }),
      // `RunnerConfig.args` (§7): the seam for what this schema does not model,
      // most concretely pointing a coding CLI at another inference endpoint.
      extraArgs: config.args,
    }),

  'codex-cli': (id, config, deps, policy) =>
    new CodexRunner({
      id,
      processRunner: deps.processRunner,
      envPass: policy.envPass,
      isolateSettings: policy.isolateSettings,
      // Needed because `--output-schema` takes a file path rather than a string.
      fs: deps.fs,
      ...(config.command === undefined ? {} : { command: config.command }),
      // `RunnerConfig.args` (§7): the seam for what this schema does not model,
      // most concretely pointing a coding CLI at another inference endpoint.
      extraArgs: config.args,
    }),

  'agy-cli': (id, config, deps, policy) =>
    new AgyRunner({
      id,
      processRunner: deps.processRunner,
      envPass: policy.envPass,
      isolateSettings: policy.isolateSettings,
      ...(config.command === undefined ? {} : { command: config.command }),
      // `RunnerConfig.args` (§7): the seam for what this schema does not model,
      // most concretely pointing a coding CLI at another inference endpoint.
      extraArgs: config.args,
    }),

  /**
   * An inference endpoint rather than a coding CLI — a local llama.cpp or vLLM server, or
   * any OpenAI-compatible host.
   *
   * It cannot write and has no working directory, and it declares both. That is what lets
   * it serve the nine shipped prompts which carry their whole input — `sdd`, `planning`,
   * the reviews, `verification` — while the resolver refuses it for `discovery` and
   * `implementation`, which read and write the repository.
   *
   * The key comes from the environment, never from the config file (§7.1).
   */
  'openai-compatible': (id, config, deps) => {
    if (config.baseUrl === undefined) {
      throw new RegistryError(
        `Runner "${id}" is an openai-compatible endpoint and declares no baseUrl.\n` +
          `  Add runners.${id}.baseUrl, e.g. http://127.0.0.1:8080/v1`,
      );
    }

    const apiKey = config.apiKeyEnv === undefined ? undefined : deps.env?.(config.apiKeyEnv);

    return new OpenAiRunner({
      id,
      baseUrl: config.baseUrl,
      ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
      ...(config.model === undefined ? {} : { model: config.model }),
    });
  },
};

/**
 * One configuration key a runner type reads, and whether the type works without it.
 *
 * Declared beside the factories because that is where the requirement already lives — the
 * `openai-compatible` factory refuses a runner with no `baseUrl` and says so in the error.
 * Two places would eventually disagree, and the one an editor reads would be the wrong one.
 */
export interface RunnerTypeField {
  readonly name: 'command' | 'args' | 'baseUrl' | 'apiKeyEnv' | 'model' | 'contextWindow';
  readonly required: boolean;
  /** Names an environment variable rather than holding a value (§7.1). */
  readonly secretEnv?: true;
}

export interface RunnerTypeDescription {
  readonly type: string;
  readonly fields: readonly RunnerTypeField[];
  /**
   * What this type can do before a model is chosen — the CLI's own surface (AD-30).
   *
   * Read by *asking an instance*, because the adapter is the only thing that knows, and a
   * table restating it here would be a second answer that ages separately. No model is
   * passed: a narrowing that depends on the pair belongs to the pair, and this question is
   * asked while somebody is still choosing the type.
   */
  readonly capabilities: RunnerCapabilities;
}

const CLI_FIELDS: readonly RunnerTypeField[] = [
  { name: 'command', required: false },
  { name: 'args', required: false },
  { name: 'model', required: false },
];

const TYPE_FIELDS: Readonly<Record<string, readonly RunnerTypeField[]>> = {
  'claude-code-cli': CLI_FIELDS,
  'codex-cli': CLI_FIELDS,
  'agy-cli': CLI_FIELDS,
  'openai-compatible': [
    { name: 'baseUrl', required: true },
    { name: 'apiKeyEnv', required: false, secretEnv: true },
    { name: 'model', required: false },
    { name: 'contextWindow', required: false },
  ],
};

/**
 * Every runner type this installation supports, for a screen that offers them.
 *
 * The alternative was a list in the browser, which is how the local-only template shipped
 * one operator's runner name as a product feature. Adding an adapter is still one entry in
 * `FACTORIES` and one file; the editor picks it up from here.
 *
 * Each type is instantiated once, with the minimum its factory accepts, purely to read the
 * capabilities it declares. Nothing is spawned and nothing is reached: construction stores
 * dependencies, and `capabilities()` answers from the adapter's own declaration.
 */
export function describeRunnerTypes(deps: RegistryDependencies): RunnerTypeDescription[] {
  return Object.keys(FACTORIES).sort().flatMap((type): RunnerTypeDescription[] => {
    const factory = FACTORIES[type];
    if (factory === undefined) return [];
    const fields = TYPE_FIELDS[type] ?? [];
    const probe: RunnerConfig = {
      type,
      enabled: true,
      args: [],
      // Satisfies the one factory that refuses a runner without an endpoint. Never
      // called: only `capabilities()` is read from this instance.
      ...(fields.some(({ name }) => name === 'baseUrl') ? { baseUrl: 'http://127.0.0.1/v1' } : {}),
    };
    const policy: RunnerSpawnPolicy = { envPass: [], isolateSettings: true };
    return [{ type, fields, capabilities: factory(type, probe, deps, policy).capabilities() }];
  });
}

export interface RunnerRegistry {
  ids(): string[];
  get(id: string): AgentRunner;
  has(id: string): boolean;
  /**
   * What each registered runner can do, per runner id (AD-30).
   *
   * This implementation returns **resolvers**, because a runner's supported reasoning
   * levels can depend on the model and this is the layer allowed to know that. The
   * declared type is the union so a fake registry may answer with plain records; every
   * consumer reads through `capabilitiesOf`, passing the configured model as an opaque
   * string, and so never learns which form it was given.
   */
  capabilities(): Readonly<Record<string, RunnerCapabilityEntry>>;
  /**
   * The adapter type behind a runner id.
   *
   * Independence is a question about providers, not about configuration keys:
   * two entries can point at the same CLI under different names, and a review
   * across them is not independent of anything.
   */
  providerOf(id: string): string | undefined;
  health(): Promise<Readonly<Record<string, RunnerHealth>>>;
  /** Throws unless every configured role points at a registered runner. */
  validateRoles(config: GlobalConfig): void;
}

/**
 * Instantiates the runners a configuration declares.
 *
 * Disabled runners are never constructed. That matters for the alpha
 * checkpoint: the shipped default enables one runner, and a machine without a
 * second CLI must not pay any attention to it.
 */
export function buildRegistry(
  config: GlobalConfig,
  deps: RegistryDependencies,
): RunnerRegistry {
  const runners = new Map<string, AgentRunner>();
  const providers = new Map<string, string>();

  for (const [id, runnerConfig] of Object.entries(config.runners)) {
    if (!runnerConfig.enabled) continue;
    providers.set(id, runnerConfig.type);

    const factory = FACTORIES[runnerConfig.type];
    if (!factory) {
      throw new RegistryError(
        `Runner "${id}" declares unknown type "${runnerConfig.type}".\n` +
          `  Supported types: ${Object.keys(FACTORIES).join(', ')}`,
      );
    }

    runners.set(id, factory(id, runnerConfig, deps, {
      envPass: config.execution.passEnv,
      isolateSettings: config.execution.isolateRunnerSettings,
    }));
  }

  const get = (id: string): AgentRunner => {
    const runner = runners.get(id);
    if (!runner) {
      const known = [...runners.keys()].join(', ') || '(none enabled)';
      throw new RegistryError(
        `Runner "${id}" is not registered.\n  Enabled runners: ${known}`,
      );
    }
    return runner;
  };

  return {
    ids: () => [...runners.keys()],
    get,
    has: (id) => runners.has(id),

    capabilities: () =>
      Object.fromEntries(
        [...runners].map(([id, runner]) => [id, (model?: string) => runner.capabilities(model)]),
      ),

    providerOf: (id) => providers.get(id),

    health: async () => {
      const entries = await Promise.all(
        [...runners].map(async ([id, runner]) => [id, await runner.healthCheck()] as const),
      );
      return Object.fromEntries(entries);
    },

    /**
     * Reports *every* broken role rather than the first one found. Fixing
     * configuration one error per run is a miserable loop, and the information
     * is already in hand.
     */
    validateRoles: (target: GlobalConfig) => {
      const problems: string[] = [];

      for (const role of ALL_WORKFLOW_ROLES) {
        const runnerId = roleConfigOf(target.roles, role).runner;
        if (runners.has(runnerId)) continue;

        const declared = target.runners[runnerId];
        problems.push(
          declared === undefined
            ? `  • role "${role}" → runner "${runnerId}" is not declared under runners:`
            : `  • role "${role}" → runner "${runnerId}" is declared but disabled`,
        );
      }

      if (problems.length > 0) {
        const known = [...runners.keys()].join(', ') || '(none enabled)';
        throw new RegistryError(
          `Configuration refers to runners that cannot be used:\n${problems.join('\n')}\n` +
            `  Enabled runners: ${known}`,
        );
      }
    },
  };
}
