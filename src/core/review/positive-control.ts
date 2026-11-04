import type { Finding } from '../../contracts/index.js';
import { aFailureNamesAnyOf, namesAnyOf, stripAnsi } from './runner-output.js';

/**
 * The automatic positive control: the change's tests, on the base, must fail (ported from
 * the Smart Place kit's `lib/positive-control.ts`).
 *
 * **A test proves a change only if it fails without it.** A reviewer reading a diff can only
 * guess at that. Running it is a fact: the base commit, the change's test files written over
 * it and nothing else, the project's own test command. A failure there is the tests noticing
 * the change is missing. A pass is a suite that would be green either way — a mock standing in
 * for the fixed path, an assertion on its own setup.
 *
 * **A failure is proven only when the runner's own failure record names one of the change's
 * tests.** The kit's first version read any non-zero exit as proven, and a checkout without
 * `vitest` installed (`ERR_MODULE_NOT_FOUND`, exit 1) passed as proof. A failure the runner
 * never reported, or one naming only other tests — a base that was already red — is
 * `not_run`: it says nothing about the change.
 *
 * **A pass can block a good test too.** Any exit 0 used to raise a high finding, including a
 * `test` script that never ran the change's tests at all. So a pass is `unproven` only when
 * the output names one of the tests; output naming none of them is `not_run`, and no output
 * to read makes it a medium finding rather than a high one.
 *
 * Pure: what ran in, a verdict and the finding it implies out. The checkout and the command
 * belong to the application layer, the way the base checkout belongs to
 * `app/baseline-verification.ts`.
 */

export type PositiveControlVerdict = 'proven' | 'unproven' | 'not_run';

export interface PositiveControl {
  readonly result: PositiveControlVerdict;
  readonly reason: string;
  readonly base: string;
  readonly command: string;
  readonly tests: readonly string[];
  readonly exitCode?: number;
  /**
   * Present exactly when the result is `unproven`: high when the output shows the tests ran
   * and passed, medium when there was no output to show it.
   */
  readonly finding?: Finding;
}

/**
 * A command that timed out (124) or never started (127): the environment answering, never
 * the base. The same pair `baseline-verification.ts` refuses to read as permission.
 */
export const ENVIRONMENT_EXIT_CODES: ReadonlySet<number> = new Set([124, 127]);

const TEST_PATTERNS = [
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /(?:^|\/)__tests__\//,
  /(?:^|\/)(?:test|tests|spec)\/.+\.[A-Za-z0-9]+$/,
  /_test\.(?:go|py|rb|exs?)$/,
  /(?:^|\/)test_[^/]+\.py$/,
  /[A-Za-z0-9](?:Test|Tests|Spec)\.(?:java|kt|cs|scala|swift)$/,
];

/** Documentation is never a test, wherever it lives. */
const PROSE = /\.(?:md|mdx|txt|rst)$/i;

/** Whether a path the change touched is one of its tests. */
export function isTestPath(path: string): boolean {
  const normalised = path.replace(/\\/g, '/');
  return !PROSE.test(normalised) && TEST_PATTERNS.some((pattern) => pattern.test(normalised));
}

/**
 * The runner said it ran nothing: vitest's "No test files found", jest's "No tests found",
 * pytest's "no tests ran" (exit 5), node:test's "# tests 0". A failure there is not the tests
 * noticing anything.
 */
const NOTHING_RAN = /no test files found|no tests found|no tests ran|collected 0 items|^# tests 0$/im;

/**
 * A dependency PACKAGE the checkout cannot resolve — node ESM/CJS, jest, vite, python —
 * named by a bare specifier. Runners report it as a failure of the test file that imports it
 * (node:test prints `not ok 1 - test/missing.test.mjs`), so it would read as proof. A missing
 * module of the change itself is a path (`'../src/x.js'`), not a package, and stays a
 * legitimate failure.
 */
function missingPackage(output: string): string | undefined {
  const patterns = [
    /Cannot find package '([^']+)'/g, // node ESM
    /Cannot find module '([^']+)'/g, // node CJS, jest
    /Failed to load url (\S+) \(resolved id: /g, // vite / vitest
    /Failed to resolve import "([^"]+)"/g, // vite
    /No module named '([^']+)'/g, // python
  ];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined && isBarePackage(specifier, pattern.source.startsWith('No module'))) {
        return specifier;
      }
    }
  }
  return undefined;
}

/**
 * A package name, not a path of the repository: not relative or absolute, not a drive, not an
 * alias the repository maps itself (`@/x`, `#x`, `~/x`). A Python module counts only without a
 * dot — a dotted one (`app.limit`) is the repository's own package, often the change itself.
 */
function isBarePackage(specifier: string, python: boolean): boolean {
  if (/^(?:\.|\/|\\|[A-Za-z]:|#|~|@\/|file:)/.test(specifier)) return false;
  return python ? !specifier.includes('.') : true;
}

/** The first line that reads like an error, to say why a failure proved nothing. */
function firstError(output: string): string | undefined {
  const line = output.split(/\r?\n/).find((text) => /error|cannot find|not found|failed to/i.test(text));
  return line?.trim().slice(0, 200);
}

export interface PositiveControlRun {
  readonly base: string;
  readonly command: string;
  readonly tests: readonly string[];
  readonly exitCode?: number;
  /** Why the control never ran, when the caller knows. Read only when there is no exit code. */
  readonly reason?: string;
  /**
   * What the command printed, stdout then stderr. Absent when the caller had none to give; a
   * pass is then only a medium finding, because nothing shows the tests ran.
   */
  readonly output?: string;
}

export function judgePositiveControl(input: PositiveControlRun): PositiveControl {
  const { base, command, tests } = input;
  const common = { base, command, tests };
  // Colours off before any match: vitest paints its `FAIL` label even through a pipe, the
  // line begins with an escape code, and a 27-failure proof reads as `not_run`.
  const output = input.output === undefined ? undefined : stripAnsi(input.output);

  if (input.exitCode === undefined) {
    return { ...common, result: 'not_run', reason: input.reason ?? 'the tests were not run on the base' };
  }
  if (ENVIRONMENT_EXIT_CODES.has(input.exitCode)) {
    return {
      ...common,
      result: 'not_run',
      exitCode: input.exitCode,
      reason: `\`${command}\` ${input.exitCode === 124 ? 'timed out' : 'could not start'} on the base (exit ${String(input.exitCode)})`,
    };
  }
  if (output !== undefined && NOTHING_RAN.test(output)) {
    return {
      ...common,
      result: 'not_run',
      exitCode: input.exitCode,
      reason: `\`${command}\` ran no test on the base (exit ${String(input.exitCode)})`,
    };
  }
  if (input.exitCode !== 0) {
    const absent = output === undefined ? undefined : missingPackage(output);
    if (absent !== undefined) {
      return {
        ...common,
        result: 'not_run',
        exitCode: input.exitCode,
        reason: `\`${command}\` failed on the base because the package '${absent}' is not installed there — an environment failure, not the tests noticing the change`,
      };
    }
    if (output !== undefined && aFailureNamesAnyOf(output, tests)) {
      return {
        ...common,
        result: 'proven',
        exitCode: input.exitCode,
        reason: `\`${command}\` fails on the base with only the tests applied, and the runner reports a failure in ${tests.join(', ')} (exit ${String(input.exitCode)})`,
      };
    }
    const error = output === undefined ? undefined : firstError(output);
    return {
      ...common,
      result: 'not_run',
      exitCode: input.exitCode,
      reason:
        output === undefined
          ? `\`${command}\` exited ${String(input.exitCode)} on the base with no output to show which test failed`
          : `\`${command}\` exited ${String(input.exitCode)} on the base, but no test failure names ${tests.join(', ')} — the environment or other tests failed${error === undefined ? '' : `: ${error}`}`,
    };
  }

  // A pass proves something only about tests that ran. A `test` script scoped to another
  // package, or a glob that does not reach where the change put its tests, exits 0 without
  // running them — and a fix task for that is one nobody can satisfy.
  const ranThem = output !== undefined && namesAnyOf(output, tests);
  if (output !== undefined && !ranThem) {
    return {
      ...common,
      result: 'not_run',
      exitCode: 0,
      reason: `\`${command}\` passed on the base without naming any of the tests (${tests.join(', ')}), so they may not have run`,
    };
  }

  const short = base.slice(0, 7);
  const first = tests[0];
  const description =
    `The tests do not prove the change: with only these test files (${tests.join(', ')}) written ` +
    `over the base ${short}, \`${command}\` passes — they would pass without the change. ` +
    `Control: \`${command}\` on base ${short} plus the change's tests gave exit 0, where a failure was expected.`;
  return {
    ...common,
    result: 'unproven',
    exitCode: 0,
    reason: description,
    finding: {
      severity: ranThem ? 'high' : 'medium',
      type: 'test-gap',
      ...(first === undefined ? {} : { file: first }),
      description,
      suggestedAction:
        'Make the tests exercise the changed behaviour, so that they fail on the base and pass on the change.',
      // The control itself is the evidence, and `downgrade.ts` reads a file reference as
      // support: without it a measured, reproducible result would be filed as unsupported.
      evidence: first === undefined ? [] : [{ kind: 'file', id: first }],
    },
  };
}
