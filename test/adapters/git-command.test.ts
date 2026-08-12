import { describe, it, expect } from 'vitest';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import {
  GIT_HOSTILE_ENVIRONMENT,
  GIT_SUBCOMMANDS,
  GIT_TIMEOUT_SECONDS,
  GitCommand,
  assertOperationArgs,
  createGitCommand,
} from '../../src/adapters/git/git-command.js';

/**
 * The wrapper's own unit tests: what argv it builds, and what it refuses.
 *
 * This is the one place `ProcessRunner` is faked, and the reason is that the
 * subject here is the *command line* rather than what Git does with it. Every
 * claim about Git's behaviour is proved against real Git in
 * `git-workspaces.integration.test.ts` and `git-hook-isolation.integration.test.ts`.
 */

const NO_HOOKS = '/home/dev/.agent-flow/no-hooks';

/** `FakeProcessRunner` already records every call; this only fixes the reply. */
function recorder(): FakeProcessRunner {
  return new FakeProcessRunner().always({ exitCode: 0, stdout: '' });
}

function commandWith(runner: FakeProcessRunner): GitCommand {
  return new GitCommand({ processRunner: runner, noHooksDir: NO_HOOKS });
}

describe('every invocation carries hook isolation (I-7, §12.3)', () => {
  it('injects core.hooksPath before the subcommand', async () => {
    const runner = recorder();
    const calls = runner.calls;

    await commandWith(runner).run({ subcommand: 'status', args: ['--porcelain=v1'], cwd: '/repo' });

    expect(calls[0]?.command).toBe('git');
    expect(calls[0]?.args).toEqual([
      '-c',
      `core.hooksPath=${NO_HOOKS}`,
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain=v1',
    ]);
  });

  it('reports the argv it ran, so a caller can prove what happened', async () => {
    const runner = recorder();

    const result = await commandWith(runner).run({ subcommand: 'version', cwd: '/repo' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.argv[0]).toBe('git');
    expect(result.value.argv).toContain(`core.hooksPath=${NO_HOOKS}`);
  });

  it('carries it on every subcommand, with no exceptions', async () => {
    const runner = recorder();
    const calls = runner.calls;
    const git = commandWith(runner);

    for (const subcommand of GIT_SUBCOMMANDS) {
      await git.run({ subcommand, cwd: '/repo' });
    }

    expect(calls).toHaveLength(GIT_SUBCOMMANDS.length);
    for (const call of calls) {
      expect(call.args.slice(0, 2)).toEqual(['-c', `core.hooksPath=${NO_HOOKS}`]);
    }
  });

  it('creates the hooks directory rather than only naming it', async () => {
    const fs = new InMemoryFileSystem();
    const runner = recorder();

    await createGitCommand({ processRunner: runner, fs, homeDir: '/home/dev' });

    // An absent directory would make the isolation depend on it *staying*
    // absent — the first person to create it and drop a script inside would
    // have found a way into every internal Git operation.
    expect(await fs.exists('/home/dev/.agent-flow/no-hooks')).toBe(true);
  });
});

describe('safety configuration is not overridable (§45, S-12)', () => {
  // Probed against real Git: with two `-c core.hooksPath=` flags on one command
  // line the LAST one wins. So a wrapper that merely prefixes a safe value and
  // then appends arbitrary argv provides no protection at all — the attacker
  // repeats the flag. Two mechanisms close it, and both are tested here.

  it('refuses a -c smuggled in as an operation argument', async () => {
    const runner = recorder();
    const calls = runner.calls;

    const result = await commandWith(runner).run({
      subcommand: 'status',
      args: ['-c', 'core.hooksPath=/tmp/evil'],
      cwd: '/repo',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('git_unsafe_argument');
    // Refused *before* spawning. A refusal that still ran the command would be
    // a report, not a defence.
    expect(calls).toHaveLength(0);
  });

  it('refuses the attached form, -ccore.hooksPath=…', async () => {
    // Git accepts the value attached to the flag, so an equality check against
    // "-c" would let exactly this through.
    const result = assertOperationArgs(['-ccore.hooksPath=/tmp/evil']);

    expect(result?.code).toBe('git_unsafe_argument');
  });

  it('refuses --config-env, which sets configuration from the environment', () => {
    expect(assertOperationArgs(['--config-env=core.hooksPath=EVIL'])?.code).toBe(
      'git_unsafe_argument',
    );
    expect(assertOperationArgs(['--config-env'])?.code).toBe('git_unsafe_argument');
  });

  it('refuses the global options that relocate the repository', () => {
    for (const option of ['-C', '--git-dir=/tmp/other', '--work-tree=/tmp/other', '--namespace']) {
      expect(assertOperationArgs([option])?.code, option).toBe('git_unsafe_argument');
    }
  });

  it('refuses an argument carrying a NUL byte', () => {
    // A NUL is where the argument ends as far as `execve` is concerned, so this
    // layer and `git` below it would disagree about what was actually passed.
    expect(assertOperationArgs(['refs/heads/x\u0000--upload-pack=evil'])?.code).toBe(
      'git_unsafe_argument',
    );
  });

  it('allows a newline inside an argument, because a commit message is one', () => {
    // §12.4 specifies a marker message with a subject, a body and trailers, so a
    // newline inside one argument is exactly what M2-05 has to pass. An earlier
    // version of this rejected the whole C0 range, which looked prudent and
    // would have made writing a marker impossible.
    //
    // Safe because there is no shell: a newline in an argv element is text. A
    // newline in a *ref* is refused by the ref allowlist in `git-workspaces.ts`,
    // which is where a decision about structured values belongs.
    expect(assertOperationArgs(['-m', 'subject\n\nbody\n\nAgent-Flow-Task: TASK-001'])).toBeNull();
  });



  it('accepts the ordinary operands every operation needs', () => {
    expect(
      assertOperationArgs([
        'add',
        '--lock',
        '--reason',
        'agent-flow AF-2026-001-0f3a91c4bd27e615 TASK-001 attempt-1',
        '-b',
        'agent-flow/AF-2026-001-0f3a91c4bd27e615/TASK-001/attempt-1',
        '--',
        '/home/dev/.agent-flow/worktrees/repo-abc/x',
        'HEAD',
      ]),
    ).toBeNull();
  });

  it('refuses a subcommand outside the closed list', async () => {
    const runner = recorder();
    const calls = runner.calls;

    const result = await commandWith(runner).run({
      // The whole point of the list is that this cannot be reached by accident,
      // so reaching it on purpose needs a cast.
      subcommand: 'push' as (typeof GIT_SUBCOMMANDS)[number],
      cwd: '/repo',
    });

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('places identity configuration where a caller cannot reach it either', async () => {
    const runner = recorder();
    const calls = runner.calls;

    await commandWith(runner).run({
      subcommand: 'commit-tree',
      args: ['0'.repeat(40)],
      cwd: '/repo',
      identity: { name: 'Agent Flow', email: 'agent-flow@local' },
    });

    const args = calls[0]?.args ?? [];
    expect(args).toEqual([
      '-c',
      `core.hooksPath=${NO_HOOKS}`,
      '-c',
      'core.quotePath=false',
      '-c',
      'user.name=Agent Flow',
      '-c',
      'user.email=agent-flow@local',
      'commit-tree',
      '0'.repeat(40),
    ]);
    // Every `-c` sits before the subcommand, which is the only region Git reads
    // configuration in.
    expect(args.indexOf('commit-tree')).toBeGreaterThan(args.lastIndexOf('-c'));
  });

  it('refuses an identity that could carry a second configuration line', async () => {
    const runner = recorder();
    const calls = runner.calls;

    const result = await commandWith(runner).run({
      subcommand: 'commit-tree',
      cwd: '/repo',
      identity: { name: 'Agent Flow\ncore.hooksPath=/tmp/evil', email: 'x@y' },
    });

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('it never reaches a shell (V-01, S-8)', () => {
  it('spawns the git executable with an argument vector', async () => {
    const runner = recorder();
    const calls = runner.calls;

    await commandWith(runner).run({
      subcommand: 'merge',
      args: ['--no-ff', '-m', 'a message with spaces; and ; semicolons', '--', 'abc'],
      cwd: '/repo',
    });

    expect(calls[0]?.command).toBe('git');
    // The message travels as one argument. Through a shell it would be five,
    // and two of them would be commands.
    expect(calls[0]?.args).toContain('a message with spaces; and ; semicolons');
  });
});

describe('what a caller controls, and what it does not', () => {
  it('passes cwd, timeout, output ceiling and stdin through', async () => {
    const runner = recorder();
    const calls = runner.calls;

    await commandWith(runner).run({
      subcommand: 'status',
      cwd: '/some/worktree',
      timeoutSeconds: 12,
      maxOutputBytes: 4096,
      stdin: 'hello',
    });

    expect(calls[0]?.cwd).toBe('/some/worktree');
    expect(calls[0]?.timeoutSeconds).toBe(12);
    expect(calls[0]?.maxOutputBytes).toBe(4096);
    expect(calls[0]?.stdin).toBe('hello');
  });

  it('gives every command a timeout even when the caller names none (§36)', async () => {
    const runner = recorder();
    const calls = runner.calls;

    await commandWith(runner).run({ subcommand: 'status', cwd: '/repo' });

    expect(calls[0]?.timeoutSeconds).toBe(GIT_TIMEOUT_SECONDS.read);
    expect(calls[0]?.maxOutputBytes).toBeGreaterThan(0);
  });

  it('sets the author and committer dates through the environment', async () => {
    const runner = recorder();
    const calls = runner.calls;

    await commandWith(runner).run({
      subcommand: 'commit-tree',
      cwd: '/repo',
      dates: { author: '2026-01-01T00:00:00Z', committer: '2026-01-01T00:00:00Z' },
    });

    expect(calls[0]?.env?.['GIT_AUTHOR_DATE']).toBe('2026-01-01T00:00:00Z');
    expect(calls[0]?.env?.['GIT_COMMITTER_DATE']).toBe('2026-01-01T00:00:00Z');
  });

  it('asks for the repository-relocating variables to be removed, not blanked', async () => {
    const runner = recorder();
    const calls = runner.calls;

    await commandWith(runner).run({ subcommand: 'status', cwd: '/repo' });

    // Blanking is not an option: probed, `GIT_DIR=` fails with
    // `not a git repository: ''` rather than reading as unset.
    expect(calls[0]?.unsetEnv).toEqual(GIT_HOSTILE_ENVIRONMENT);
    expect(calls[0]?.env?.['GIT_DIR']).toBeUndefined();
    expect(calls[0]?.env?.['GIT_TERMINAL_PROMPT']).toBe('0');
  });

  it('names every variable that could redirect which repository is acted on', () => {
    // Pinned as a list rather than left implicit, so that removing one is a
    // deliberate edit with a test to answer to. `GIT_INDEX_FILE` is the one
    // worth staring at: `write-tree` records whatever index it names, so an
    // inherited value would make the "validated tree" a tree nobody validated.
    expect([...GIT_HOSTILE_ENVIRONMENT]).toEqual([
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_NAMESPACE',
      'GIT_CEILING_DIRECTORIES',
      // The environment form of `--exec-path`, which the argument denylist
      // already refuses. Refusing one and inheriting the other is an asymmetry
      // an attacker only has to notice once.
      'GIT_EXEC_PATH',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_PARAMETERS',
    ]);
  });

  it('leaves the user their own configuration files and transport setup', () => {
    // §12.3 isolates hooks and nothing else. Stripping these would disable
    // configuration Agent Flow has no business overriding, for no threat.
    for (const kept of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_SSH_COMMAND', 'GIT_ASKPASS']) {
      expect([...GIT_HOSTILE_ENVIRONMENT], kept).not.toContain(kept);
    }
  });
});

describe('failures are typed, and a non-zero exit is not one of them', () => {
  it('reports a missing executable as git_unavailable', async () => {
    const runner = new FakeProcessRunner().always(() => ({
      spawnFailed: true,
      stderr: 'spawn git ENOENT',
    }));

    const result = await commandWith(runner).run({ subcommand: 'status', cwd: '/repo' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('git_unavailable');
  });

  it('reports a timeout as git_timed_out', async () => {
    const runner = new FakeProcessRunner().always(() => ({ timedOut: true, exitCode: null }));

    const result = await commandWith(runner).run({ subcommand: 'merge', cwd: '/repo' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('git_timed_out');
  });

  it('hands a non-zero exit back as data, not as an error', async () => {
    // `merge` exits 1 on a conflict and `cat-file -e` exits 1 for "absent".
    // Deciding here that non-zero means failure would destroy the distinction
    // at the bottom of the stack, where nothing above can recover it.
    const runner = new FakeProcessRunner().always(() => ({ exitCode: 1, stderr: 'CONFLICT' }));

    const result = await commandWith(runner).run({ subcommand: 'merge', cwd: '/repo' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exitCode).toBe(1);
    expect(result.value.stderr).toBe('CONFLICT');
  });

  it('reports truncation without deciding what it means', async () => {
    const runner = new FakeProcessRunner().always(() => ({
      exitCode: 0,
      stdout: 'half of it',
      truncated: true,
    }));

    const result = await commandWith(runner).run({ subcommand: 'status', cwd: '/repo' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The wrapper reports it; `GitWorkspaces` refuses to parse it (§37).
    expect(result.value.truncated).toBe(true);
  });
});
