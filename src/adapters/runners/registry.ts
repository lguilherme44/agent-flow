import {
  ALL_WORKFLOW_ROLES,
  roleConfigOf,
  type GlobalConfig,
  type RunnerConfig,
} from '../../contracts/index.js';
import type {
  AgentRunner,
  RunnerCapabilityEntry,
  RunnerHealth,
} from '../../ports/agent-runner.js';
import type { ProcessRunner } from '../../ports/process-runner.js';
import type { FileSystem } from '../../ports/file-system.js';
import { ClaudeCodeRunner } from './claude-code-runner.js';
import { CodexRunner } from './codex-runner.js';
import { AgyRunner } from './agy-runner.js';

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
}

type RunnerFactory = (
  id: string,
  config: RunnerConfig,
  deps: RegistryDependencies,
) => AgentRunner;

/**
 * The single place that maps a configured `type` to a concrete adapter.
 *
 * This table is the only spot in the codebase allowed to know that a runner
 * called "claude-code-cli" exists. Adding a runner means adding one entry here
 * and one adapter file — no workflow code, no stage, no prompt changes.
 */
const FACTORIES: Readonly<Record<string, RunnerFactory>> = {
  'claude-code-cli': (id, config, deps) =>
    new ClaudeCodeRunner({
      id,
      processRunner: deps.processRunner,
      ...(config.command === undefined ? {} : { command: config.command }),
    }),

  'codex-cli': (id, config, deps) =>
    new CodexRunner({
      id,
      processRunner: deps.processRunner,
      // Needed because `--output-schema` takes a file path rather than a string.
      fs: deps.fs,
      ...(config.command === undefined ? {} : { command: config.command }),
    }),

  'agy-cli': (id, config, deps) =>
    new AgyRunner({
      id,
      processRunner: deps.processRunner,
      ...(config.command === undefined ? {} : { command: config.command }),
    }),
};

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

    runners.set(id, factory(id, runnerConfig, deps));
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
