import type { EffectiveConfig } from '../contracts/index.js';
import {
  buildRegistry,
  type RegistryDependencies,
  type RunnerRegistry,
} from '../adapters/runners/registry.js';
import { commandGrantsFor } from '../core/command-grants.js';

/**
 * The runner registry for an effective configuration, with the project's command grants.
 *
 * **The only production caller of `buildRegistry`** (FR-008). Runtime, `doctor` and every
 * server route that builds a registry come through here, so each one derives the grants from
 * the same configuration, with the same trust decision, the same way. Six sites each
 * assembling the list by hand would be six chances for one to forget the trust screen — and
 * the one that forgot would show a grant the executor does not have, or hide one it does.
 */
export function registryFor(config: EffectiveConfig, deps: RegistryDependencies): RunnerRegistry {
  const { granted } = commandGrantsFor(config.project, config.projectTrusted === true);
  return buildRegistry(config.global, deps, { commandGrants: granted });
}
