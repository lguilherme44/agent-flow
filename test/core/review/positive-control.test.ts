import { describe, it, expect } from 'vitest';
import {
  isTestPath,
  judgePositiveControl,
  type PositiveControlRun,
} from '../../../src/core/review/positive-control.js';
import { downgradeFinding } from '../../../src/core/review/downgrade.js';
import { FindingSchema } from '../../../src/contracts/index.js';

/**
 * The control that says whether a change's tests prove anything.
 *
 * Every case below is one the Smart Place kit measured on a real runner. The two that cost
 * the most are kept first in mind while reading: a checkout without the test runner installed
 * exits 1 and *looks* like proof, and a `test` script that never reached the change's tests
 * exits 0 and *looks* like a test gap.
 */

const run = (over: Partial<PositiveControlRun> = {}): PositiveControlRun => ({
  base: 'abcdef1234567890',
  command: 'npm test',
  tests: ['test/core/limit.test.ts'],
  ...over,
});

const ESC = '\u001b';

describe('a failure on the base proves the tests', () => {
  it('is proven when the runner names one of the tests in a failure record', () => {
    const control = judgePositiveControl(
      run({
        exitCode: 1,
        output: ['FAIL test/core/limit.test.ts > rejects over the cap', 'Test Files  1 failed (1)'].join('\n'),
      }),
    );

    expect(control.result).toBe('proven');
    expect(control.finding).toBeUndefined();
  });

  it('reads a coloured FAIL label, because vitest paints it even through a pipe', () => {
    const control = judgePositiveControl(
      run({ exitCode: 1, output: `${ESC}[31mFAIL${ESC}[39m test/core/limit.test.ts\n` }),
    );

    expect(control.result).toBe('proven');
  });

  it('reads a TAP failure whose file is in the record below the mark', () => {
    const control = judgePositiveControl(
      run({
        tests: ['test/double.test.mjs'],
        exitCode: 1,
        output: ['not ok 1 - doubles', '  ---', '  location: /repo/test/double.test.mjs:4:1', '  ...'].join('\n'),
      }),
    );

    expect(control.result).toBe('proven');
  });
});

describe('a failure that says nothing about the change', () => {
  it('is not_run when the test runner itself is missing from the checkout', () => {
    // The scar, in the shape that costs: node:test reports the absent package as a failure
    // *of the test file*, so the failure record names the test and the whole thing reads as
    // proof. Only recognising the package keeps it from being one.
    const control = judgePositiveControl(
      run({
        exitCode: 1,
        output: [
          'not ok 1 - test/core/limit.test.ts',
          "  error: \"Cannot find package 'vitest' imported from /tmp/wt/x.js\"",
        ].join('\n'),
      }),
    );

    expect(control.result).toBe('not_run');
    expect(control.reason).toContain("the package 'vitest' is not installed");
  });

  it('keeps a missing module of the change itself as a legitimate failure', () => {
    const control = judgePositiveControl(
      run({
        exitCode: 1,
        output: ["FAIL test/core/limit.test.ts", "Error: Cannot find module '../../src/core/limit.js'"].join('\n'),
      }),
    );

    expect(control.result).toBe('proven');
  });

  it('is not_run when the only failures name other tests — a base that was already red', () => {
    const control = judgePositiveControl(
      run({ exitCode: 1, output: ['FAIL test/other/flaky.test.ts', '✓ test/core/limit.test.ts'].join('\n') }),
    );

    expect(control.result).toBe('not_run');
  });

  it('is not_run when the runner reports it ran no test at all', () => {
    const control = judgePositiveControl(run({ exitCode: 1, output: 'No test files found, exiting with code 1' }));

    expect(control.result).toBe('not_run');
    expect(control.reason).toContain('ran no test');
  });

  it.each([
    [124, 'timed out'],
    [127, 'could not start'],
  ])('is not_run on exit %i, which is the environment answering', (exitCode, said) => {
    const control = judgePositiveControl(run({ exitCode, output: 'FAIL test/core/limit.test.ts' }));

    expect(control.result).toBe('not_run');
    expect(control.reason).toContain(said);
  });

  it('is not_run when the control never ran, and keeps the caller reason', () => {
    const control = judgePositiveControl(run({ reason: 'the base could not be checked out' }));

    expect(control.result).toBe('not_run');
    expect(control.reason).toBe('the base could not be checked out');
    expect(control.exitCode).toBeUndefined();
  });

  it('is not_run when a non-zero exit printed nothing to attribute it to', () => {
    const control = judgePositiveControl(run({ exitCode: 1 }));

    expect(control.result).toBe('not_run');
    expect(control.reason).toContain('no output');
  });
});

describe('a pass on the base', () => {
  it('is unproven and high when the output shows the tests ran and passed', () => {
    const control = judgePositiveControl(
      run({ exitCode: 0, output: ['✓ test/core/limit.test.ts (3 tests)', 'Test Files  1 passed (1)'].join('\n') }),
    );

    expect(control.result).toBe('unproven');
    expect(control.finding?.severity).toBe('high');
    expect(control.finding?.type).toBe('test-gap');
    expect(control.finding?.file).toBe('test/core/limit.test.ts');
  });

  it('is only medium when there was no output to show the tests ran', () => {
    const control = judgePositiveControl(run({ exitCode: 0 }));

    expect(control.result).toBe('unproven');
    expect(control.finding?.severity).toBe('medium');
  });

  it('is not_run when the output names none of the tests — the script never reached them', () => {
    // The other scar: `npm test` scoped to another package exits 0, and raising a high there
    // files a fix task nobody can satisfy.
    const control = judgePositiveControl(
      run({ exitCode: 0, output: ['✓ packages/api/test/health.test.ts', 'Test Files  1 passed (1)'].join('\n') }),
    );

    expect(control.result).toBe('not_run');
    expect(control.finding).toBeUndefined();
  });

  it('raises a finding the contract accepts, with evidence that survives the downgrade', () => {
    const control = judgePositiveControl(
      run({ exitCode: 0, output: '✓ test/core/limit.test.ts (3 tests)' }),
    );
    const finding = control.finding;

    if (finding === undefined) throw new Error('a pass that named the tests must raise a finding');
    expect(FindingSchema.safeParse(finding).success).toBe(true);
    // A measured, reproducible result must not be filed as "no evidence".
    expect(downgradeFinding(finding).downgraded).toBeUndefined();
  });
});

describe('naming a test is a whole path token, never a substring', () => {
  it('does not read `data.test.mjs` as `a.test.mjs`', () => {
    const control = judgePositiveControl(
      run({ tests: ['a.test.mjs'], exitCode: 1, output: 'FAIL data.test.mjs' }),
    );

    expect(control.result).toBe('not_run');
  });

  it('does not read `backend/src/index.test.ts` as the frontend one', () => {
    const control = judgePositiveControl(
      run({ tests: ['frontend/src/index.test.ts'], exitCode: 1, output: 'FAIL backend/src/index.test.ts' }),
    );

    expect(control.result).toBe('not_run');
  });

  it('accepts a path printed from the runner own root, shorter than the repository one', () => {
    const control = judgePositiveControl(
      run({ tests: ['backend/test/unit/a.test.ts'], exitCode: 1, output: 'FAIL test/unit/a.test.ts' }),
    );

    expect(control.result).toBe('proven');
  });
});

describe('which of the change files are its tests', () => {
  it.each([
    'src/core/limit.test.ts',
    'src/core/limit.spec.tsx',
    'src/__tests__/limit.ts',
    'test/core/limit.ts',
    'internal/limit_test.go',
    'tests/test_limit.py',
    'src/LimitTest.java',
  ])('counts %s', (path) => {
    expect(isTestPath(path)).toBe(true);
  });

  it.each(['src/core/limit.ts', 'docs/testing.md', 'test/README.md', 'package.json'])(
    'does not count %s',
    (path) => {
      expect(isTestPath(path)).toBe(false);
    },
  );

  it('reads a Windows path the same way', () => {
    expect(isTestPath('src\\core\\limit.test.ts')).toBe(true);
  });
});
