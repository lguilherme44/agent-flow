import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/cli/index.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { renderError } from '../../src/cli/render/errors.js';
import { renderWarm } from '../../src/cli/init.js';
import { ConfigError } from '../../src/config/loader.js';
import { StageFailure } from '../../src/app/stage-runner.js';
import { RoleResolutionError } from '../../src/core/role.js';
import { StateError } from '../../src/app/state-store.js';
import { PlanningRefusal } from '../../src/app/planning-pipeline.js';

function captureOutput() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { stdout: () => out.join(''), stderr: () => err.join('') };
}

describe('version and help', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports the installed version', async () => {
    const expected = (
      JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')) as {
        version: string;
      }
    ).version;

    const output = captureOutput();
    const code = await main(['node', 'agent-flow', '--version']);

    expect(code).toBe(ExitCode.OK);
    expect(output.stdout()).toContain(expected);
  });

  it('lists the commands available at this milestone', async () => {
    const output = captureOutput();
    await main(['node', 'agent-flow', '--help']);
    expect(output.stdout()).toContain('feature');
  });

  it('treats --help as success, not as a parse failure', async () => {
    captureOutput();
    expect(await main(['node', 'agent-flow', '--help'])).toBe(ExitCode.OK);
  });
});

describe('exit codes', () => {
  it('separates configuration errors from execution errors', () => {
    // The distinction a script needs: a config error will not fix itself on
    // retry, an execution error might.
    expect(renderError(new ConfigError('bad yaml')).exitCode).toBe(ExitCode.CONFIG_ERROR);
    expect(
      renderError(new StageFailure('sdd', 'execution_failed', 'boom')).exitCode,
    ).toBe(ExitCode.EXECUTION_ERROR);
  });

  it('gives a busy refusal from `feature` the code `approve` and `run` give it', () => {
    // The README promises 5 for a second `feature` while a run executes; it exited 1,
    // the code of a broken repository, so a script could not tell "wait" from "fix".
    const busy = new PlanningRefusal('run_busy', 'AF-2026-001 is running', 'use a separate worktree');
    expect(renderError(busy).exitCode).toBe(ExitCode.RUN_BUSY);
    // Every other repository refusal keeps the execution code.
    const dirty = new PlanningRefusal('dirty_worktree', 'uncommitted changes', 'commit or stash');
    expect(renderError(dirty).exitCode).toBe(ExitCode.EXECUTION_ERROR);
  });

  it('treats a role resolution failure as a configuration error', () => {
    const error = new RoleResolutionError('unknown_runner', 'sdd', 'no such runner');
    expect(renderError(error).exitCode).toBe(ExitCode.CONFIG_ERROR);
  });

  it('reserves distinct codes for the approval gate and strict degradation', () => {
    expect(ExitCode.GATE_NOT_SATISFIED).toBe(3);
    expect(ExitCode.DEGRADED_STRICT).toBe(4);
  });
});

describe('error rendering', () => {
  it('shows a configuration error without a stack trace', () => {
    // A trace tells the user where our code was, not what they should change.
    const rendered = renderError(new ConfigError('Invalid config.yaml:\n  • roles.sdd: required'));
    expect(rendered.message).toContain('roles.sdd');
    expect(rendered.message).not.toContain('at Object.');
  });

  it('points at doctor when a runner cannot be resolved', () => {
    const rendered = renderError(
      new RoleResolutionError('unknown_runner', 'planner', 'runner "ghost" is not registered'),
    );
    expect(rendered.message).toContain('doctor');
  });

  it('explains why invalid output is not retried elsewhere (§55)', () => {
    // The hint has to say this, or the natural next question is "why not just
    // try the other model?" — which is exactly the wrong instinct.
    const rendered = renderError(new StageFailure('planning', 'invalid_output', 'schema mismatch'));
    expect(rendered.message).toMatch(/hide the mismatch|not retried/i);
  });

  it('suggests a concrete action for quota and auth failures', () => {
    expect(renderError(new StageFailure('sdd', 'quota_exceeded', 'x')).message).toMatch(
      /usage limit|fallback/i,
    );
    expect(renderError(new StageFailure('sdd', 'auth_required', 'x')).message).toMatch(/log in/i);
  });

  it('says that BLOCKED needs a person, not a retry (§23)', () => {
    const rendered = renderError(new StageFailure('sdd', 'blocked', 'needs a decision'));
    expect(rendered.message).toMatch(/human decision/i);
  });

  /**
   * AR-02 at the surface a person actually reads.
   *
   * The evidence run's worst failure reached a terminal as `execution_failed` and nothing
   * else. The cause — a denied shell command — was in memory and was discarded, so the
   * sentence in front of the operator contained no fact they could act on.
   */
  describe('a classified failure says what to do', () => {
    const denial = () =>
      new StageFailure(
        'implementation',
        'execution_failed',
        'failed',
        'soft-denying tool confirmation "Bash"\npermission check failed',
      );

    it('names the class beside the transport code, never instead of it', () => {
      // A refinement, not a replacement: a script matching on `execution_failed` still
      // finds it (AD-36).
      const message = renderError(denial()).message;

      expect(message).toContain('runner_permission_required');
      expect(message).toContain('execution_failed');
    });

    it('names the tool that was refused', () => {
      expect(renderError(denial()).message).toContain('Bash');
    });

    it('prefers the taxonomy’s action when the class is sharper than the code', () => {
      // The generic hint for `execution_failed` is "the original message is above", which
      // is exactly the non-advice this milestone exists to remove.
      const message = renderError(denial()).message;

      expect(message).toMatch(/Next:/);
      expect(message).toMatch(/grant/i);
    });

    it('says the attempt was not spent, because it was not', () => {
      // The counter that forced `retry --force` in the evidence run (AD-37, I-22).
      expect(renderError(denial()).message).toMatch(/did not spend/i);
    });

    it('keeps the richer terminal hint when the class adds nothing', () => {
      // `quota_exceeded` has exactly one refinement, so the classifier learned nothing the
      // code did not already say and the sentence written for this terminal is better.
      const message = renderError(new StageFailure('sdd', 'quota_exceeded', 'x')).message;

      expect(message).toMatch(/usage limit|fallback/i);
      expect(message).not.toMatch(/Next:/);
    });
  });

  it('includes the original runner output for diagnosis', () => {
    const rendered = renderError(
      new StageFailure('sdd', 'execution_failed', 'failed', 'original CLI message'),
    );
    expect(rendered.message).toContain('original CLI message');
  });

  /**
   * A timeout that tells the reader which limit was hit and where to change it.
   *
   * The sentence used to be "Raise timeoutSeconds for this role if this is expected",
   * which names no role, no path and no duration — so the reader could not tell a tight
   * budget from a hung runner without reading the source. Measured: a discovery stage
   * killed at 900 s whose whole record was the word `timeout`.
   */
  describe('a timeout names the numbers and the key', () => {
    const killed = (role: 'architect' | 'executor.normal') =>
      new StageFailure('discovery', 'timeout', 'failed', undefined, undefined, undefined, {
        role,
        timeoutSeconds: 900,
        durationMs: 900_004,
      });

    it('says how long it ran and what it was allowed', () => {
      const message = renderError(killed('architect')).message;

      expect(message).toContain('15m00s');
      expect(message).toContain('900s');
    });

    it('names the config path that raises the limit', () => {
      expect(renderError(killed('architect')).message).toContain('roles.architect.timeoutSeconds');
    });

    it('uses the path the file actually has, not the workflow’s spelling', () => {
      // The workflow says `executor.normal`; the YAML says `roles.executors.normal`. A hint
      // printing the first would send someone to edit a key that does not exist.
      const message = renderError(killed('executor.normal')).message;

      expect(message).toContain('roles.executors.normal.timeoutSeconds');
      expect(message).not.toContain('roles.executor.normal');
    });

    it('explains the empty output rather than showing nothing', () => {
      // A killed CLI that buffers its whole response leaves no bytes. Printing nothing
      // about that sends the reader looking for a log that was never written.
      expect(renderError(killed('architect')).message).toMatch(/wrote no output/i);
    });

    it('falls back to the vague sentence rather than inventing numbers', () => {
      // No budget travelled with this failure — every construction site predating the
      // field, and the two paths that legitimately have none.
      const message = renderError(new StageFailure('discovery', 'timeout', 'failed')).message;

      expect(message).toMatch(/exceeded its timeout/i);
      expect(message).not.toMatch(/\d+s budget/);
    });
  });

  it('keeps the stack for an unexpected error', () => {
    // Here the trace really is the most useful thing available.
    const rendered = renderError(new Error('something unforeseen'));
    expect(rendered.message).toContain('something unforeseen');
  });

  it('renders a state error without a trace', () => {
    expect(renderError(new StateError('Run AF-2026-404 not found')).message).toContain('AF-2026-404');
  });
});

/**
 * `init --warm`, which exists so the first feature is not the one that finds the wall.
 *
 * Two numbers nobody had before it: how long the repository's map takes to build, and how
 * much of the architect's budget that is. A repository too large for the default was
 * indistinguishable from one that fits, right up to the request that died at its first
 * stage — measured at 15min00s against 900s.
 */
describe('the warm-up reports the map against the budget', () => {
  it('says how long it took and what share of the budget that is', () => {
    const lines = renderWarm({ ran: true, elapsedMs: 450_000 }, 900).join('\n');

    expect(lines).toContain('7m30s');
    expect(lines).toContain('900s');
    expect(lines).toContain('50%');
  });

  it('stays quiet when there is margin', () => {
    // Crying wolf at 50% would train people past the one warning that matters.
    const lines = renderWarm({ ran: true, elapsedMs: 450_000 }, 900).join('\n');

    expect(lines).not.toMatch(/Warning/);
  });

  it('warns, and names the key, once the margin is gone', () => {
    // 80%, the same share `stage_near_timeout` uses — deliberately not a second opinion,
    // or setup would certify a configuration the first real run then rejects.
    const lines = renderWarm({ ran: true, elapsedMs: 800_000 }, 900).join('\n');

    expect(lines).toMatch(/Warning/);
    expect(lines).toContain('roles.architect.timeoutSeconds');
  });

  it('says nothing was spent when the map was already current', () => {
    // The elapsed time here is a cache check, not a stage. Reporting it as "built in 2ms,
    // 0% of the budget" would be a measurement of the wrong thing, stated confidently.
    const lines = renderWarm({ ran: false, elapsedMs: 2 }, 900).join('\n');

    expect(lines).toMatch(/already current/i);
    expect(lines).not.toMatch(/%/);
  });
});
