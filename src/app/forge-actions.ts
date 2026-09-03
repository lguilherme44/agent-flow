import {
  ForgeConfigSchema,
  type ForgeConfig,
  type ForgeRepository,
} from '../contracts/index.js';
import { createGitCommand } from '../adapters/git/git-command.js';
import { GitHubForgeProvider } from '../adapters/forge/github-forge.js';
import { RemoteGitPublisher } from '../adapters/git/remote-publisher.js';
import { parseRepositoryUrl } from '../core/forge/repository.js';
import { projectDelivery, type DeliveryView } from '../core/forge/delivery.js';
import { DeliveryService } from './delivery-service.js';
import { DeliveryStore } from './delivery-store.js';
import type { StateStore } from './state-store.js';
import type { Clock, FileSystem, ProcessRunner } from '../ports/index.js';

/**
 * Composing remote delivery, and the one place a token is read (M7 §6, §23).
 *
 * **The composition boundary, deliberately.** `process.env` appears here and nowhere else
 * in the forge: the adapter takes a token as a constructor argument, the service never
 * sees one, and the architecture suite proves no other file names the variable. A token
 * resolved deep in a call stack is a token that ends up in a log by accident.
 *
 * Every function here is refusable. A provider that is not configured, a repository that
 * does not match, a token that is not exported — all of them answer with a sentence rather
 * than throwing, because none of them is a bug and all of them are things an operator can
 * fix in a minute if they are told which one it is.
 */

export interface ForgeDeps {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly processRunner: ProcessRunner;
  readonly store: StateStore;
  readonly projectDir: string;
  /** From the `Host` port, never `process.env.HOME` (§7.1). */
  readonly homeDir: string;
  readonly config: ForgeConfig;
  /** Read once, here. `undefined` when the operator has not exported it. */
  readonly token: string | undefined;
  readonly fetch?: typeof fetch;
  readonly remote?: string;
}

export type ForgeSetup =
  | { readonly ok: true; readonly service: DeliveryService; readonly repository: ForgeRepository }
  | { readonly ok: false; readonly detail: string; readonly action: string };

/**
 * Everything remote delivery needs, or the reason it cannot be assembled.
 *
 * The order is the order an operator would hit the problems in, so the first thing they
 * are told is the first thing they have to do.
 */
export async function forgeSetup(deps: ForgeDeps): Promise<ForgeSetup> {
  if (deps.config.provider === 'none') {
    return {
      ok: false,
      detail: 'no forge provider is configured',
      action: 'Set forge.provider: github in the global configuration to enable delivery.',
    };
  }

  // The same factory every other caller uses, so the hooks directory this run's Git sees
  // is the provisioned one rather than the operator's.
  const git = await createGitCommand({
    processRunner: deps.processRunner,
    fs: deps.fs,
    homeDir: deps.homeDir,
  });
  const remote = deps.remote ?? 'origin';

  // `--get-url` reads the configured URL and touches no network, which is why this can
  // fail fast on a misconfigured repository without a round trip.
  const url = await git.run({
    subcommand: 'ls-remote',
    args: ['--get-url', remote],
    cwd: deps.projectDir,
  });

  if (!url.ok || url.value.exitCode !== 0) {
    return {
      ok: false,
      detail: `this repository has no "${remote}" remote`,
      action: `Add one with: git remote add ${remote} <url>`,
    };
  }

  const repository = parseRepositoryUrl(url.value.stdout.trim());
  if (repository === undefined) {
    return {
      ok: false,
      detail: `"${url.value.stdout.trim()}" is not a repository this tool can identify`,
      action: 'Delivery supports github.com. Point the remote at one, or leave forge off.',
    };
  }

  if (deps.token === undefined || deps.token.length === 0) {
    return {
      ok: false,
      detail: `${deps.config.github.tokenEnv} is not set in this environment`,
      action:
        `Export it before running: ${deps.config.github.tokenEnv}=... agent-flow forge …\n` +
        '  The configuration stores the variable name; the value never touches disk.',
    };
  }

  const provider = new GitHubForgeProvider({
    repository,
    token: deps.token,
    apiBaseUrl: deps.config.github.apiBaseUrl,
    fetch: deps.fetch ?? fetch,
    requestTimeoutMs: deps.config.budgets.requestTimeoutMs,
    maxResponseBytes: deps.config.budgets.maxResponseBytes,
    maxRecoveryScan: deps.config.budgets.maxRecoveryScan,
  });

  return {
    ok: true,
    repository,
    service: new DeliveryService({
      store: deps.store,
      config: deps.config,
      repository,
      provider,
      publisher: new RemoteGitPublisher(git),
      records: new DeliveryStore({ fs: deps.fs, projectDir: deps.projectDir }),
      clock: deps.clock,
      projectDir: deps.projectDir,
      remote,
    }),
  };
}

/**
 * What delivery has reached, for a reader.
 *
 * Available with no token and no provider: "nothing is configured" is a legitimate answer
 * to "where did this run go", and needing a credential to be told that would be absurd.
 */
export async function deliveryStatus(deps: {
  readonly fs: FileSystem;
  readonly projectDir: string;
  readonly config: ForgeConfig;
  readonly runId: string;
}): Promise<DeliveryView> {
  const record = await new DeliveryStore({
    fs: deps.fs,
    projectDir: deps.projectDir,
  }).read(deps.runId);

  return projectDelivery({
    config: deps.config,
    ...(record === undefined ? {} : { record }),
  });
}

/** The token, from the variable the configuration names. The only `process.env` in M7. */
export function tokenFrom(config: ForgeConfig, env: NodeJS.ProcessEnv): string | undefined {
  return env[config.github.tokenEnv];
}

/** A configuration with delivery off, for a caller that has none. */
export const FORGE_OFF: ForgeConfig = ForgeConfigSchema.parse({});
