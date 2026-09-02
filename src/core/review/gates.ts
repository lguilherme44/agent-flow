import type {
  CommandResult,
  QualityCategory,
  QualityConfig,
  QualityGateResult,
} from '../../contracts/index.js';
import type { ValidationRegistry } from '../validation-registry.js';
import { patternCovers } from '../team/ownership.js';

/**
 * What the project's own commands said, per gate (M6-07, §36–§41).
 *
 * **A projection over evidence that already exists, not a second way to run things.** The
 * command behind `test` is whatever `commands.test` or `validationCommands.test` says,
 * resolved by the registry a plan already picks from; what a run *did* is in the command
 * results the executor already recorded. This joins the two and says what each gate means.
 *
 * The join is on the resolved command string, because that is the only thing the two
 * halves share — a `CommandResult` records what ran, not which id asked for it. An id
 * whose command nothing ran is `not_run`, which is the point.
 *
 * **`not_run` is never `passed`** (I-45). This product already learned that at run
 * granularity, when four `exit 127`s from a tree nobody had installed into were rendered
 * beneath a headline saying PASS. The same rule, per gate: an environment that could not
 * answer is not a codebase that answered no, and a *required* gate that did not run blocks
 * exactly as a failed one does.
 *
 * Pure: configuration, a registry and a list of results in; a verdict per gate out. No
 * shell, no filesystem, no clock.
 */

export interface GateProjectionInput {
  readonly quality: QualityConfig;
  readonly registry: ValidationRegistry;
  /** What actually ran, from the attempt's own record. */
  readonly ran: readonly CommandResult[];
  /** The change's files, for mechanical applicability (§40). */
  readonly changedFiles: readonly string[];
}

export function projectQualityGates(input: GateProjectionInput): QualityGateResult[] {
  const byCommand = new Map(input.ran.map((result) => [result.command, result]));
  const results: QualityGateResult[] = [];

  for (const [gateId, gate] of Object.entries(input.quality.gates)) {
    const command = input.registry.resolve(gateId);

    if (command === undefined) {
      // Declared as a gate and defined by nothing. Reported rather than skipped: a
      // required gate nobody wired up is a hole, and silence would hide it.
      results.push({
        gateId,
        category: gate.category,
        required: gate.required,
        status: 'not_run',
        detail: `no command is configured for "${gateId}"`,
      });
      continue;
    }

    if (!applies(gate.appliesTo, input.changedFiles)) {
      results.push({
        gateId,
        category: gate.category,
        required: gate.required,
        status: 'not_applicable',
        detail: `this change touches nothing under ${(gate.appliesTo ?? []).join(', ')}`,
      });
      continue;
    }

    const result = byCommand.get(command);
    if (result === undefined) {
      results.push({
        gateId,
        category: gate.category,
        required: gate.required,
        status: 'not_run',
        detail: 'the command was not executed for this change',
      });
      continue;
    }

    results.push({
      gateId,
      category: gate.category,
      required: gate.required,
      status: result.exitCode === 0 ? 'passed' : 'failed',
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    });
  }

  // Commands that ran and nobody declared. Advisory by definition — an operator who did
  // not say a gate is required did not say it is required — and shown rather than
  // dropped, because evidence that exists and is invisible is evidence nobody weighs.
  for (const result of input.ran) {
    const declared = Object.keys(input.quality.gates).some(
      (gateId) => input.registry.resolve(gateId) === result.command,
    );
    if (declared) continue;

    results.push({
      gateId: idOf(input.registry, result.command) ?? result.command,
      category: 'custom' satisfies QualityCategory,
      required: false,
      status: result.exitCode === 0 ? 'passed' : 'failed',
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    });
  }

  return results.sort((a, b) => (a.gateId < b.gateId ? -1 : a.gateId > b.gateId ? 1 : 0));
}

/**
 * Whether a gate applies to this change (§40).
 *
 * **Mechanical first.** A glob over the files the change touched, matched by the same
 * segment-aware matcher the ownership map uses — because two path matchers are two
 * answers about one path, and the day they disagree a required gate quietly stops
 * applying.
 *
 * No `appliesTo` means always. A `UtilityModel` may suggest one and may never switch a
 * required gate off.
 */
function applies(patterns: readonly string[] | undefined, files: readonly string[]): boolean {
  if (patterns === undefined || patterns.length === 0) return true;
  return files.some((file) => patterns.some((pattern) => patternCovers(pattern, file)));
}

/** The registry id behind a command, when one owns it. */
function idOf(registry: ValidationRegistry, command: string): string | undefined {
  return registry.ids.find((id) => registry.resolve(id) === command);
}

/**
 * The required gates that are not satisfied.
 *
 * Empty means every required gate ran and passed. A `not_run` is in this list, which is
 * the whole of I-45 expressed as code rather than as a comment.
 */
export function unsatisfiedRequired(
  results: readonly QualityGateResult[],
): QualityGateResult[] {
  return results.filter(
    (gate) => gate.required && gate.status !== 'passed' && gate.status !== 'not_applicable',
  );
}
