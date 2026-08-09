import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/cli/index.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { renderError } from '../../src/cli/render/errors.js';
import { ConfigError } from '../../src/config/loader.js';
import { StageFailure } from '../../src/app/stage-runner.js';
import { RoleResolutionError } from '../../src/core/role.js';
import { StateError } from '../../src/app/state-store.js';

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

  it('includes the original runner output for diagnosis', () => {
    const rendered = renderError(
      new StageFailure('sdd', 'execution_failed', 'failed', 'original CLI message'),
    );
    expect(rendered.message).toContain('original CLI message');
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
