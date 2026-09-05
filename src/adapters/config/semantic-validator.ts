import { GlobalConfigSchema, ProjectConfigSchema } from '../../contracts/index.js';
import type {
  ConfigDiagnostic,
  ConfigSemanticValidationInput,
  ConfigSemanticValidationResult,
  ConfigSemanticValidator,
} from '../../ports/config-semantic-validator.js';

export class SchemaConfigSemanticValidator implements ConfigSemanticValidator {
  validate(input: ConfigSemanticValidationInput): readonly ConfigDiagnostic[] {
    return this.normalize(input).diagnostics;
  }

  normalize(input: ConfigSemanticValidationInput): ConfigSemanticValidationResult {
    const diagnostics: ConfigDiagnostic[] = [];
    const global = GlobalConfigSchema.safeParse(input.effectiveGlobal);
    if (!global.success) diagnostics.push(...global.error.issues.map(schemaDiagnostic));

    let normalizedProject = input.projectSource;
    if (input.projectSource !== undefined) {
      const project = ProjectConfigSchema.safeParse(input.projectSource);
      if (!project.success) diagnostics.push(...project.error.issues.map(schemaDiagnostic));
      else normalizedProject = project.data;
    }

    const effectiveGlobal = global.success ? global.data : input.effectiveGlobal;
    diagnostics.push(...runnerReferenceDiagnostics(effectiveGlobal));
    return {
      effectiveGlobal,
      ...(input.projectSource === undefined
        ? {}
        : { projectSource: normalizedProject }),
      diagnostics: deduplicate(diagnostics),
    };
  }
}

function schemaDiagnostic(issue: { path: PropertyKey[]; message: string; code: string }): ConfigDiagnostic {
  return {
    severity: 'error',
    code: `schema_${issue.code}`,
    path: issue.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number'),
    message: issue.message,
    action: 'Correct the value before saving.',
  };
}

function runnerReferenceDiagnostics(global: Record<string, unknown>): ConfigDiagnostic[] {
  const runners = record(global['runners']);
  const valid = new Set(Object.entries(runners)
    .filter(([, config]) => typeof record(config)['type'] === 'string' && record(config)['type'] !== '')
    .map(([id]) => id));
  const references: Array<{ path: (string | number)[]; value: unknown }> = [];
  collectRoleReferences(global['roles'], ['roles'], references);
  collectRoleReferences(record(global['fallback'])['roles'], ['fallback', 'roles'], references);

  for (const [teamId, team] of Object.entries(record(global['teams']))) {
    for (const [memberId, member] of Object.entries(record(record(team)['members']))) {
      references.push({ path: ['teams', teamId, 'members', memberId, 'runner'], value: record(member)['runner'] });
    }
  }

  return references.flatMap(({ path, value }) =>
    typeof value === 'string' && !valid.has(value)
      ? [{
          severity: 'error' as const,
          code: 'invalid_runner',
          path,
          message: `Runner '${value}' is not configured with a valid type.`,
          action: `Create runner '${value}' or route this entry to an existing runner.`,
        }]
      : []);
}

function collectRoleReferences(value: unknown, path: (string | number)[], output: Array<{ path: (string | number)[]; value: unknown }>): void {
  const object = record(value);
  if ('runner' in object) output.push({ path: [...path, 'runner'], value: object['runner'] });
  for (const [key, child] of Object.entries(record(object['stages']))) {
    output.push({ path: [...path, 'stages', key, 'runner'], value: record(child)['runner'] });
  }
  for (const [key, child] of Object.entries(object)) {
    if (key !== 'runner' && key !== 'stages' && typeof child === 'object' && child !== null) {
      collectRoleReferences(child, [...path, key], output);
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function deduplicate(diagnostics: readonly ConfigDiagnostic[]): ConfigDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.code}:${diagnostic.path.join('.')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
