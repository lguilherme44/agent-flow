import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { GitWorkspaces } from '../../src/adapters/git/git-workspaces.js';
import { testGitCommand } from '../fakes/test-git-command.js';
import { prepareWorkspace } from '../../src/app/workspace-preparation.js';

/**
 * AD-44 (AR-04) — one preparation sequence, used by everything that runs commands.
 *
 * The evidence run's `review` produced four `exit 127`s — lint, typecheck, test and build,
 * all reporting a missing binary — beneath a headline reading `Verification: PASS`. The
 * integration worktree had never had `npm install` run in it, while every *task* worktree
 * had, through a sequence that already existed and was simply not reused.
 *
 * The command, the mechanism and the policy were all already there. Only the integration
 * worktree was left out.
 */

const WORKSPACE = '/wt/integration';

function world(options: {
  readonly install?: string;
  readonly clean?: boolean;
  readonly cleanAfterInstall?: boolean;
  readonly installExit?: number;
}) {
  const fs = new InMemoryFileSystem();
  let statusCalls = 0;

  const processRunner = new FakeProcessRunner().always((spawn) => {
    if (spawn.command !== 'git') return { exitCode: options.installExit ?? 0 };

    const args = spawn.args.filter((arg) => arg !== '-c');
    if (args.some((arg) => arg === 'status')) {
      statusCalls += 1;
      const clean = statusCalls === 1 ? options.clean !== false : options.cleanAfterInstall !== false;
      return { stdout: clean ? '' : 'M  src/x.ts\0' };
    }
    return {};
  });

  const workspaces = new GitWorkspaces({
    git: testGitCommand(processRunner),
    fs,
    worktreeRoot: '/wt',
  });

  return {
    processRunner,
    prepare: () =>
      prepareWorkspace(
        { workspaces, processRunner },
        {
          path: WORKSPACE,
          ...(options.install === undefined ? {} : { install: options.install }),
        },
      ),
  };
}

describe('the shared preparation sequence (AD-44)', () => {
  it('asserts clean, installs, then asserts clean again', async () => {
    const { prepare, processRunner } = world({ install: 'npm ci' });

    const outcome = await prepare();

    expect(outcome.ok).toBe(true);
    const commands = processRunner.calls.map((call) => call.command);
    expect(commands.filter((command) => command !== 'git')).toEqual(['/bin/sh']);
  });

  it('reports the install command and its exit code on success', async () => {
    // C-10 wants `workspace_prepared` to record both. The emitter needs them from here.
    const { prepare } = world({ install: 'npm ci' });

    const outcome = await prepare();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.install).toEqual({ command: 'npm ci', exitCode: 0 });
  });

  it('is a no-op for a project that declares no install command', async () => {
    // "A project that declares no install command is not a project that failed to
    // install" — it simply has nothing to prepare.
    const { prepare, processRunner } = world({});

    const outcome = await prepare();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.install).toBeUndefined();
    expect(processRunner.calls.some((call) => call.command.endsWith('sh'))).toBe(false);
  });

  it('refuses at the checkout phase when the tree was born dirty', async () => {
    // `core.autocrlf` and `.gitattributes` filters both do this, and catching it
    // separately from the post-install assertion is why two phases exist.
    const { prepare } = world({ install: 'npm ci', clean: false });

    const outcome = await prepare();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.phase).toBe('checkout');
  });

  it('refuses when the install fails, naming its exit code', async () => {
    const { prepare } = world({ install: 'npm ci', installExit: 127 });

    const outcome = await prepare();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.phase).toBe('setup');
    expect(outcome.failure.detail).toContain('127');
  });

  it('refuses when the install dirtied tracked files', async () => {
    // The default Node install rewrites `package-lock.json` when the lock drifts, which is
    // a tracked modification — and the reason `doctor` has a probe for exactly this.
    const { prepare } = world({ install: 'npm install', cleanAfterInstall: false });

    const outcome = await prepare();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.phase).toBe('setup');
  });

  it('never puts an absolute path in the sentence it persists (§21.3)', async () => {
    const { prepare } = world({ install: 'npm ci', installExit: 1 });

    const outcome = await prepare();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(JSON.stringify(outcome.failure)).not.toContain(WORKSPACE);
  });
});
