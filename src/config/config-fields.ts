import { REASONING_ORDER } from '../contracts/common.schema.js';
import { FORGE_PROVIDERS } from '../contracts/forge.schema.js';
import { QUALITY_CATEGORIES } from '../contracts/review.schema.js';
import { UTILITY_MODEL_ADAPTERS } from '../contracts/utility-model-config.schema.js';
import { PROJECT_OVERRIDABLE_KEYS, PROJECT_OWN_KEYS } from './resolver.js';

export type ConfigScope = 'global' | 'project';
export type ConfigFieldEffect = 'server_restart' | 'next_run' | 'next_execution_context';
export type ConfigFieldValueType = 'string' | 'boolean' | 'integer' | 'number' | 'string_list' | 'reasoning_level' | 'enum';

export interface ConfigFieldDefinition {
  readonly path: readonly string[];
  readonly section: string;
  readonly valueType: ConfigFieldValueType;
  readonly scopes: readonly ConfigScope[];
  readonly effect: ConfigFieldEffect;
  /**
   * The values a closed field accepts, in the schema's own order.
   *
   * A `valueType` of `enum` without them is a type nobody can offer: an editor that
   * knows a field is closed but not what it is closed to has to render free text and
   * let the round-trip refuse the typo. Read from the schemas that already own these
   * lists rather than restated here, so a value added there reaches the editor without
   * a second edit.
   */
  readonly options?: readonly string[];
}

export interface ConfigFieldView extends ConfigFieldDefinition {
  readonly editable: boolean;
  readonly reason?: 'global_only';
}

const GLOBAL: readonly ConfigScope[] = ['global'];
const PROJECT: readonly ConfigScope[] = ['project'];
const NEXT: ConfigFieldEffect = 'next_execution_context';
const field = (path: string, valueType: ConfigFieldValueType, scopes: readonly ConfigScope[] = GLOBAL, effect: ConfigFieldEffect = NEXT): ConfigFieldDefinition => ({
  path: path.split('.'), section: path.split('.')[0] ?? 'general', valueType, scopes, effect,
  // Reasoning levels are the same four everywhere, so they are attached here rather
  // than repeated at every role and stage that takes one.
  ...(valueType === 'reasoning_level' ? { options: REASONING_ORDER } : {}),
});
/** An `enum` field and the list it is closed to, which is never optional for one. */
const enumField = (path: string, options: readonly string[], scopes: readonly ConfigScope[] = GLOBAL): ConfigFieldDefinition => ({
  ...field(path, 'enum', scopes), options,
});
const roleFields = (prefix: string, scopes = GLOBAL): ConfigFieldDefinition[] => [
  field(`${prefix}.runner`, 'string', scopes), field(`${prefix}.model`, 'string', scopes),
  field(`${prefix}.effort`, 'reasoning_level', scopes), field(`${prefix}.timeoutSeconds`, 'integer', scopes),
  field(`${prefix}.stages.*.runner`, 'string', scopes), field(`${prefix}.stages.*.model`, 'string', scopes),
  field(`${prefix}.stages.*.effort`, 'reasoning_level', scopes), field(`${prefix}.stages.*.timeoutSeconds`, 'integer', scopes),
];

/** This metadata is also the write allowlist: unknown paths are never editable. */
export const configFieldCatalog: readonly ConfigFieldDefinition[] = [
  field('version', 'integer'),
  ...['type', 'command', 'baseUrl', 'apiKeyEnv', 'model'].map((key) => field(`runners.*.${key}`, 'string')),
  field('runners.*.enabled', 'boolean'), field('runners.*.args', 'string_list'), field('runners.*.contextWindow', 'integer'),
  ...['architect', 'sdd', 'planner', 'planReviewer', 'executors.trivial', 'executors.normal', 'executors.complex', 'verification', 'finalReviewer'].flatMap((role) => roleFields(`roles.${role}`)),
  field('fallback.enabled', 'boolean'), field('fallback.on', 'string_list'), ...roleFields('fallback.roles.*'),
  field('parallelism.maxTasks', 'integer'), field('retry.maxAttempts', 'integer'),
  field('recovery.enabled', 'boolean'),
  ...['maxEnvironmentRepairs', 'maxIdenticalFailures', 'maxModelCallsPerTask', 'maxCorrectiveRounds', 'maxCorrectivePlanRepairs', 'maxVerificationCycles', 'maxAutonomousModelCalls', 'maxPacketBytes', 'maxRawExcerptBytes', 'maxDiffStatLines'].map((key) => field(`recovery.${key}`, 'integer')),
  field('git.useWorktrees', 'boolean', GLOBAL, 'next_run'), field('approval.requiredBeforeImplementation', 'boolean'),
  field('execution.passEnv', 'string_list'), field('execution.recordPrompts', 'boolean'), field('execution.isolateRunnerSettings', 'boolean'), field('ui.workspaceDepth', 'integer', GLOBAL, 'server_restart'), field('ui.allowedHosts', 'string_list', GLOBAL, 'server_restart'),
  field('utilityModel.enabled', 'boolean'), enumField('utilityModel.adapter', UTILITY_MODEL_ADAPTERS),
  ...['baseUrl', 'model', 'apiKeyEnv'].map((key) => field(`utilityModel.${key}`, 'string')),
  ...['contextWindow', 'targetInputTokens', 'maxOutputTokens'].map((key) => field(`utilityModel.${key}`, 'integer')), field('utilityModel.timeoutSeconds', 'number'),
  field('collaboration.enabled', 'boolean'),
  ...['maxMessagesPerTask', 'maxMessageBytes', 'maxOutboxBytes', 'maxThreadDepth', 'maxHandoffsPerTask', 'maxBlackboardEntriesPerRun', 'maxContextBytes'].map((key) => field(`collaboration.${key}`, 'integer')),
  field('collaboration.handoffsReassignExecution', 'boolean'),
  field('teams.*.name', 'string'), field('teams.*.policies.admitHandoffs', 'boolean'),
  field('teams.*.members.*.roles', 'string_list'), ...['runner', 'model', 'displayName'].map((key) => field(`teams.*.members.*.${key}`, 'string')),
  field('teams.*.members.*.skills', 'string_list'), field('teams.*.members.*.specializations', 'string_list'),
  field('teams.*.members.*.capacity.maxConcurrentTasks', 'integer'),
  ...['preferred', 'exclusive', 'shared'].map((key) => field(`teams.*.members.*.ownership.${key}`, 'string_list')),
  enumField('quality.gates.*.category', QUALITY_CATEGORIES), field('quality.gates.*.required', 'boolean'), field('quality.gates.*.appliesTo', 'string_list'), field('quality.blockOnMedium', 'boolean'),
  ...['maxRounds', 'maxCorrectionRounds', 'maxDisputeRounds', 'maxFindingsPerReview'].map((key) => field(`review.${key}`, 'integer')),
  enumField('forge.provider', FORGE_PROVIDERS), field('forge.github.tokenEnv', 'string'), field('forge.github.apiBaseUrl', 'string'),
  field('forge.publish.enabled', 'boolean'), field('forge.publish.autoAfterCompletion', 'boolean'), field('forge.issues.create', 'boolean'), field('forge.issues.comment', 'boolean'),
  field('forge.pullRequests.create', 'boolean'), field('forge.pullRequests.update', 'boolean'), field('forge.pullRequests.postSummary', 'boolean'), field('forge.checks.read', 'boolean'),
  ...['host', 'owner', 'repo'].map((key) => field(`forge.repository.${key}`, 'string')), field('forge.baseBranch', 'string'), field('forge.labels', 'string_list'),
  ...['requestTimeoutMs', 'maxResponseBytes', 'maxMutationAttempts', 'maxSyncAttempts', 'maxCommentsPerRun', 'maxRecoveryScan'].map((key) => field(`forge.budgets.${key}`, 'integer')),
  field('project.name', 'string', PROJECT), field('project.type', 'string', PROJECT),
  ...['install', 'lint', 'typecheck', 'test', 'build'].map((key) => field(`commands.${key}`, 'string', PROJECT)),
  field('validationCommands.*', 'string', PROJECT), field('paths.source', 'string_list', PROJECT), field('paths.tests', 'string_list', PROJECT), field('rules.architecture', 'string_list', PROJECT),
];

const overridable = new Set<string>(PROJECT_OVERRIDABLE_KEYS);
const projectOwn = new Set<string>(PROJECT_OWN_KEYS);

export function configFieldAt(path: readonly (string | number)[], scope: ConfigScope): ConfigFieldView | undefined {
  const normalized = path.map(String);
  const definition = configFieldCatalog.find((candidate) => matches(candidate.path, normalized));
  if (definition === undefined) return undefined;
  if (definition.scopes.includes(scope)) return { ...definition, editable: true };
  if (scope === 'project' && definition.scopes.includes('global')) {
    const head = normalized[0];
    if (head !== undefined && overridable.has(head)) return { ...definition, editable: true };
    return { ...definition, editable: false, reason: 'global_only' };
  }
  return undefined;
}

export function isKnownConfigPath(path: readonly (string | number)[]): boolean {
  const normalized = path.map(String);
  return configFieldCatalog.some((candidate) => matches(candidate.path, normalized));
}

export function isKnownConfigPathPrefix(path: readonly (string | number)[]): boolean {
  const normalized = path.map(String);
  return configFieldCatalog.some((candidate) => normalized.every((segment, index) => candidate.path[index] === '*' || candidate.path[index] === segment));
}

export function isProjectEditableTopLevel(key: string): boolean {
  return overridable.has(key) || projectOwn.has(key);
}

function matches(pattern: readonly string[], path: readonly string[]): boolean {
  return pattern.length === path.length && pattern.every((part, index) => part === '*' || part === path[index]);
}
