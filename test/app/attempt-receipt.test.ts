import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { testGitCommand } from '../fakes/test-git-command.js';
import { GitWorkspaces } from '../../src/adapters/git/git-workspaces.js';
import {
  markerMessage,
  readAttempt,
  recordAttempt,
  type AttemptDraft,
  type AttemptEvidenceDeps,
} from '../../src/app/attempt-receipt.js';
import { runPaths } from '../../src/app/paths.js';
import { TaskAttemptResultSchema } from '../../src/contracts/index.js';
import type { Host } from '../../src/ports/index.js';

/**
 * The §11.2 sequence, without a repository.
 *
 * What is faked here is the *process* underneath Git, never the wrapper: the
 * argv is the thing worth asserting on, and a stand-in `GitWorkspaces` would
 * make every assertion below an assertion about the stand-in. The properties
 * that need real Git — that the marker's tree is the validated tree, that
 * re-running `commit-tree` yields the same SHA — are in
 * `attempt-marker.integration.test.ts`, because they are properties of Git
 * rather than of this module.
 */

const PROJECT = '/repo';
const WORKSPACE = '/home/.agent-flow/worktrees/repo-0f3a91c4bd27/AF-2026-001-0f3a91c4bd27e615/TASK-003/attempt-1';
const RUN = 'AF-2026-001';
const KEY = 'AF-2026-001-0f3a91c4bd27e615';
const BASE = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MARKER = 'ffee0011223344556677889900aabbccddeeff00';

/** The subcommand of a built argv: the first element past the `-c` pairs. */
function subcommandOf(args: readonly string[]): string {
  let index = 0;
  while (args[index] === '-c') index += 2;
  return args[index] ?? '';
}

/**
 * One ordered log of everything the sequence touched.
 *
 * The ordering property of §11.2 is not observable from a return value — the
 * nonce is *in* the artifact either way — so it is observed from the outside:
 * every Git subcommand and every draw of randomness lands in one list, and the
 * test reads the list.
 */
function world(
  options: {
    readonly tree?: string;
    readonly marker?: string;
    /**
     * Fails one Git subcommand, by name.
     *
     * Every step of §11.2 that can fail is a Git call or a filesystem call, and
     * each one fails for its own reason in the wild — a pruned object, a
     * concurrent ref update, a full disk. Injection is the only way to reach
     * them deterministically, and reaching them is the point: a failure path
     * nobody has executed is a guess about what the code does.
     */
    readonly failing?: string;
  } = {},
) {
  const timeline: string[] = [];
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();

  const processRunner = new FakeProcessRunner().always((spawn) => {
    const subcommand = subcommandOf(spawn.args);
    timeline.push(`git ${subcommand}`);
    if (subcommand === options.failing) {
      // Git's own stderr, verbatim in shape — including the absolute path it
      // always names, so the test can prove that path does not survive into
      // what a person reads (§7.2, §21.3).
      return { exitCode: 128, stderr: `fatal: something went wrong in ${WORKSPACE}` };
    }
    if (subcommand === 'write-tree') return { stdout: `${options.tree ?? TREE}\n` };
    if (subcommand === 'commit-tree') return { stdout: `${options.marker ?? MARKER}\n` };
    return {};
  });

  const inner = new FakeHost();
  const host: Host = {
    pid: inner.pid,
    hostname: inner.hostname,
    homeDir: inner.homeDir,
    maxPathLength: inner.maxPathLength,
    measurePathLength: (value) => inner.measurePathLength(value),
    isAlive: (pid) => inner.isAlive(pid),
    randomHex: (bytes) => {
      timeline.push(`randomHex(${String(bytes)})`);
      return inner.randomHex(bytes);
    },
  };

  const workspaces = new GitWorkspaces({
    git: testGitCommand(processRunner),
    fs,
    worktreeRoot: '/home/.agent-flow/worktrees',
  });

  const deps: AttemptEvidenceDeps = { workspaces, fs, clock, host, projectDir: PROJECT };
  return { deps, fs, clock, host, processRunner, timeline };
}

function draft(overrides: Partial<AttemptDraft> = {}): AttemptDraft {
  return {
    run: RUN,
    task: 'TASK-003',
    attempt: 1,
    base: BASE,
    branch: `agent-flow/${KEY}/TASK-003/attempt-1`,
    workspace: `repo-0f3a91c4bd27/${KEY}/TASK-003/attempt-1`,
    runner: 'claude',
    reasoning: 'high',
    reasoningClamped: false,
    startedAt: '2026-08-09T19:59:00.000Z',
    finishedAt: '2026-08-09T20:00:00.000Z',
    filesChanged: ['src/a.ts'],
    agentReport: { status: 'COMPLETED', notes: [], deviations: [], claimedFilesChanged: [] },
    validation: { expectation: 'pass', passed: true, ids: ['lint', 'test'], commands: [] },
    validationJudgement: 'satisfied',
    ...overrides,
  };
}

function request(overrides: Partial<AttemptDraft> = {}) {
  return { draft: draft(overrides), workspacePath: WORKSPACE, gitRunKey: KEY };
}

describe('the receipt is minted after the agent is gone (§11.2)', () => {
  it('stages, writes the tree, and only then draws the nonce', async () => {
    const { deps, timeline } = world();

    const outcome = await recordAttempt(deps, request());

    expect(outcome.ok).toBe(true);
    // The whole security property, as an order. A nonce drawn before
    // `write-tree` is a nonce that could have existed while the agent's process
    // was still alive, and §11.1 is entirely about that moment.
    expect(timeline.slice(0, 3)).toEqual(['git add', 'git write-tree', 'randomHex(16)']);
  });

  it('binds the receipt to exactly what write-tree returned', async () => {
    const captured = '0123456789abcdef0123456789abcdef01234567';
    const { deps } = world({ tree: captured });

    const outcome = await recordAttempt(deps, request());

    expect(outcome.ok && outcome.value.attempt.receipt?.validatedTree).toBe(captured);
  });

  it('mints 128 bits, as thirty-two lowercase hex characters', async () => {
    const { deps, timeline } = world();

    const outcome = await recordAttempt(deps, request());
    const nonce = outcome.ok ? outcome.value.attempt.receipt?.nonce : undefined;

    expect(timeline).toContain('randomHex(16)');
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it('dates the receipt from the clock, and the marker from the receipt', async () => {
    const { deps, clock, processRunner } = world();

    const outcome = await recordAttempt(deps, request());
    const issuedAt = outcome.ok ? outcome.value.attempt.receipt?.issuedAt : undefined;

    expect(issuedAt).toBe(clock.now());

    const commit = processRunner.calls.find((call) => subcommandOf(call.args) === 'commit-tree');
    expect(commit?.env?.['GIT_AUTHOR_DATE']).toBe(issuedAt);
    expect(commit?.env?.['GIT_COMMITTER_DATE']).toBe(issuedAt);
  });

  it('stages before it reads the index, in that order and not the reverse', async () => {
    // `write-tree` records whatever the index holds. Reading it first would
    // capture the tree as the checkout left it, which is a tree the validation
    // commands did not run against once the agent wrote a single file.
    const { deps, timeline } = world();

    await recordAttempt(deps, request());

    expect(timeline.indexOf('git add')).toBeLessThan(timeline.indexOf('git write-tree'));
  });
});

describe('an attempt that was not satisfied gets no receipt and no marker', () => {
  for (const judgement of ['unsatisfied', 'not_reached'] as const) {
    it(`records ${judgement} as evidence and asks Git for nothing`, async () => {
      const { deps, timeline, fs } = world();

      const outcome = await recordAttempt(
        deps,
        request({ validationJudgement: judgement, validation: {
          expectation: 'pass',
          passed: false,
          ids: ['test'],
          commands: [],
        } }),
      );

      expect(outcome.ok).toBe(true);
      expect(outcome.ok && outcome.value.marker).toBeUndefined();
      expect(outcome.ok && outcome.value.attempt.receipt).toBeUndefined();
      // No tree captured, no nonce drawn, no commit, no ref. There is no tree a
      // receipt could point at, so there is nothing to sign.
      expect(timeline).toEqual([]);

      const persisted = await readAttempt(
        { fs, projectDir: PROJECT },
        RUN,
        'TASK-003',
        1,
      );
      expect(persisted?.validationJudgement).toBe(judgement);
      expect(persisted?.receipt).toBeUndefined();
    });
  }
});

describe('the artifact is written once and never again (§11.3)', () => {
  it('refuses a second write rather than overwriting', async () => {
    const { deps, fs } = world();

    const first = await recordAttempt(deps, request());
    const second = await recordAttempt(deps, request());

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(!second.ok && second.failure.code).toBe('attempt_artifact_exists');

    // And the first evidence is untouched: the nonce on disk is the one the
    // first run minted. Recovery decides what happened to an attempt from this
    // file, so a path that replaced it would be a path that replaces a receipt.
    const persisted = await readAttempt({ fs, projectDir: PROJECT }, RUN, 'TASK-003', 1);
    expect(persisted?.receipt?.nonce).toBe(first.ok ? first.value.attempt.receipt?.nonce : null);
  });

  it('refuses a second write of byte-identical content too', async () => {
    // "It is the same content, so rewriting is idempotent" is the argument that
    // turns an append-only record into a mutable one. It is refused on the
    // filename, before anything compares anything.
    const { deps } = world();

    await recordAttempt(deps, request());
    const again = await recordAttempt(deps, request());

    expect(!again.ok && again.failure.code).toBe('attempt_artifact_exists');
  });

  it('writes a second attempt of the same task to its own file', async () => {
    const { deps, fs } = world();

    await recordAttempt(deps, request());
    const second = await recordAttempt(deps, {
      draft: draft({ attempt: 2, branch: `agent-flow/${KEY}/TASK-003/attempt-2` }),
      workspacePath: WORKSPACE,
      gitRunKey: KEY,
    });

    expect(second.ok).toBe(true);
    expect(await fs.exists(runPaths(PROJECT, RUN).taskAttempt('TASK-003', 1))).toBe(true);
    expect(await fs.exists(runPaths(PROJECT, RUN).taskAttempt('TASK-003', 2))).toBe(true);
  });

  it('writes it atomically', async () => {
    const { deps, fs } = world();

    await recordAttempt(deps, request());

    expect(fs.writes).toContain(runPaths(PROJECT, RUN).taskAttempt('TASK-003', 1));
  });
});

describe('the artifact lives outside every worktree, and names no machine (§7.2, §11.2)', () => {
  it('writes under the run artifacts, not under the workspace', async () => {
    const { deps, fs } = world();

    await recordAttempt(deps, request());

    const path = runPaths(PROJECT, RUN).taskAttempt('TASK-003', 1);
    expect(path).toBe(`${PROJECT}/.agent-flow/runs/${RUN}/tasks/TASK-003/attempt-1.json`);
    expect(path.startsWith(WORKSPACE)).toBe(false);
    expect(await fs.exists(path)).toBe(true);
  });

  it('records the workspace-relative path and never the absolute one', async () => {
    const { deps, fs } = world();

    await recordAttempt(deps, request());

    const raw = await fs.readFile(runPaths(PROJECT, RUN).taskAttempt('TASK-003', 1));
    const parsed = TaskAttemptResultSchema.parse(JSON.parse(raw));

    expect(parsed.workspace.startsWith('/')).toBe(false);
    // The absolute root the agent actually ran in appears nowhere in the bytes.
    expect(raw).not.toContain(WORKSPACE);
    expect(raw).not.toContain('/home/.agent-flow');
  });
});

describe('the marker is built from the persisted artifact (§12.1, §12.2)', () => {
  it('commits the validated tree onto the attempt base, with no other parent', async () => {
    const { deps, processRunner } = world();

    await recordAttempt(deps, request());

    const commit = processRunner.calls.find((call) => subcommandOf(call.args) === 'commit-tree');
    const args = commit?.args ?? [];

    expect(args).toContain(TREE);
    expect(args.filter((arg) => arg === '-p')).toHaveLength(1);
    expect(args[args.indexOf('-p') + 1]).toBe(BASE);
  });

  it('names the fixed identity rather than the user', async () => {
    const { deps, processRunner } = world();

    await recordAttempt(deps, request());

    const commit = processRunner.calls.find((call) => subcommandOf(call.args) === 'commit-tree');
    expect(commit?.args).toContain('user.name=Agent Flow');
    expect(commit?.args).toContain('user.email=agent-flow@local');
  });

  it('uses commit-tree and update-ref, never commit, branch or --allow-empty', async () => {
    const { deps, processRunner } = world();

    await recordAttempt(deps, request());

    const subcommands = processRunner.calls.map((call) => subcommandOf(call.args));
    expect(subcommands).toEqual(['add', 'write-tree', 'commit-tree', 'update-ref']);

    for (const call of processRunner.calls) {
      expect(call.args).not.toContain('--allow-empty');
      expect(call.args).not.toContain('--no-verify');
      expect(call.args).not.toContain('branch');
    }
  });

  it('points the attempt ref at the marker', async () => {
    const { deps, processRunner } = world();

    const outcome = await recordAttempt(deps, request());

    const update = processRunner.calls.find((call) => subcommandOf(call.args) === 'update-ref');
    expect(update?.args).toContain(`refs/heads/agent-flow/${KEY}/TASK-003/attempt-1`);
    expect(update?.args).toContain(MARKER);
    expect(outcome.ok && outcome.value.marker?.oid).toBe(MARKER);
    expect(outcome.ok && outcome.value.marker?.tree).toBe(TREE);
  });

  it('carries the hook-isolation flag on every one of them (I-7, S-12)', async () => {
    const { deps, processRunner } = world();

    await recordAttempt(deps, request());

    for (const call of processRunner.calls) {
      expect(call.args.slice(0, 2)).toEqual(['-c', 'core.hooksPath=/fake-home/.agent-flow/no-hooks']);
    }
  });
});

describe('the marker message says what it is, without being believed (§12.4)', () => {
  const attempt = TaskAttemptResultSchema.parse({
    ...draft(),
    receipt: { nonce: 'a'.repeat(32), validatedTree: TREE, issuedAt: '2026-08-09T20:00:00.000Z' },
  });

  it('opens with the subject and the prose §12.4 specifies', () => {
    const message = markerMessage(attempt, KEY);
    const lines = message.split('\n');

    expect(lines[0]).toBe('agent-flow: TASK-003 attempt 1');
    expect(lines[1]).toBe('');
    expect(message).toContain('Validated tree for TASK-003, attempt 1, of run AF-2026-001.');
    // §12.5's model, in prose, so a person reading `git log` is not surprised
    // that the agent's own commits are not in the ancestry.
    expect(message).toContain("not the coding agent's commit history");
  });

  it('carries every normative trailer', () => {
    const message = markerMessage(attempt, KEY);

    for (const [trailer, value] of [
      ['Agent-Flow-Run', RUN],
      ['Agent-Flow-Run-Key', KEY],
      ['Agent-Flow-Task', 'TASK-003'],
      ['Agent-Flow-Attempt', '1'],
      ['Agent-Flow-Base', BASE],
      ['Agent-Flow-Tree', TREE],
      ['Agent-Flow-Receipt', 'a'.repeat(32)],
      ['Agent-Flow-Validation', 'satisfied'],
      ['Agent-Flow-Validation-Expectation', 'pass'],
      ['Agent-Flow-Validation-Ids', 'lint,test'],
    ] as const) {
      expect(message).toContain(`${trailer}: ${value}`);
    }
  });

  it('writes object ids in full, never abbreviated (§33)', () => {
    const message = markerMessage(attempt, KEY);

    expect(message).toMatch(new RegExp(`Agent-Flow-Base: [0-9a-f]{40}$`, 'm'));
    expect(message).toMatch(new RegExp(`Agent-Flow-Tree: [0-9a-f]{40}$`, 'm'));
  });

  it('is a pure function of the artifact and the namespace', () => {
    // The determinism of §12.2 begins here: same artifact in, same bytes out.
    expect(markerMessage(attempt, KEY)).toBe(markerMessage(attempt, KEY));
  });
});

describe('a sequence that cannot finish reports why, without naming a path', () => {
  it('refuses when the tree cannot be written', async () => {
    const fs = new InMemoryFileSystem();
    const processRunner = new FakeProcessRunner().always((spawn) =>
      subcommandOf(spawn.args) === 'write-tree'
        ? { exitCode: 128, stderr: `fatal: not a git repository: ${WORKSPACE}` }
        : {},
    );
    const workspaces = new GitWorkspaces({
      git: testGitCommand(processRunner),
      fs,
      worktreeRoot: '/home/.agent-flow/worktrees',
    });

    const outcome = await recordAttempt(
      { workspaces, fs, clock: new FixedClock(), host: new FakeHost(), projectDir: PROJECT },
      request(),
    );

    expect(!outcome.ok && outcome.failure.code).toBe('validated_tree_uncapturable');
    // The detail reaches a note on a task result, so it carries a stable code
    // and never Git's stderr — which names the absolute worktree it ran in.
    expect(!outcome.ok && outcome.failure.detail).not.toContain(WORKSPACE);
    // And nothing was written: an attempt with no captured tree has no evidence.
    expect(await fs.exists(runPaths(PROJECT, RUN).taskAttempt('TASK-003', 1))).toBe(false);
  });

  it('refuses to persist an artifact its own contract rejects', async () => {
    // The `.refine` of §10.2 as a runtime gate: a half-forged shape never
    // reaches the disk, whichever half is missing.
    const { deps, fs } = world();

    const outcome = await recordAttempt(deps, {
      draft: draft({ validationJudgement: 'unsatisfied', attempt: 0 }),
      workspacePath: WORKSPACE,
      gitRunKey: KEY,
    });

    expect(!outcome.ok && outcome.failure.code).toBe('attempt_artifact_unreadable');
    expect(await fs.exists(runPaths(PROJECT, RUN).taskAttempt('TASK-003', 0))).toBe(false);
  });
});

/**
 * Every synchronous way the §11.2 sequence can fail, and what must be true after.
 *
 * The happy path proves the guarantee exists. These prove it cannot be *faked* —
 * which is a different claim, and the one that matters for a trust root. The
 * shape being ruled out everywhere below is the same: a step fails, and
 * something downstream carries on with a value it was never handed.
 *
 * Two invariants run through all of them:
 *
 *   - **No forged evidence.** A failure before the artifact leaves nothing on
 *     disk. A failure after it leaves the artifact exactly as it was written —
 *     never rewritten, never repaired, never downgraded.
 *   - **The judgement is not the fallback.** `validated_tree_uncapturable` is an
 *     evidence-capture failure. Recording it as `unsatisfied` or `not_reached`
 *     to satisfy the receipt-iff-satisfied `.refine` would be a lie about what
 *     the validation commands found, written into the one file recovery trusts.
 */
describe('every failure of the evidence sequence, and what survives it', () => {
  const ARTIFACT = runPaths(PROJECT, RUN).taskAttempt('TASK-003', 1);

  describe('failures before the tree exists leave nothing at all', () => {
    for (const [step, failing] of [
      ['stageAll', 'add'],
      ['writeTree', 'write-tree'],
    ] as const) {
      it(`records nothing when ${step} fails`, async () => {
        const { deps, fs, timeline } = world({ failing });

        const outcome = await recordAttempt(deps, request());

        expect(!outcome.ok && outcome.failure.code).toBe('validated_tree_uncapturable');
        // No artifact — not even one without a receipt. An attempt whose tree
        // was never captured has no evidence to record, and a file here would
        // be a claim that something was observed.
        expect(await fs.exists(ARTIFACT)).toBe(false);
        // No nonce was ever drawn. There is no tree for it to point at, and a
        // nonce that exists without one is a value looking for a claim.
        expect(timeline.filter((entry) => entry.startsWith('randomHex'))).toEqual([]);
        // And nothing was published.
        expect(timeline).not.toContain('git commit-tree');
        expect(timeline).not.toContain('git update-ref');
        expect(!outcome.ok && outcome.failure.detail).not.toContain(WORKSPACE);
      });
    }

    it('stops at the staging step rather than reading a stale index', async () => {
      // `write-tree` records whatever the index holds. Running it after a failed
      // `add -A` would capture the tree the checkout started with — a real tree,
      // a plausible receipt, and not the one validation ran over.
      const { deps, timeline } = world({ failing: 'add' });

      await recordAttempt(deps, request());

      expect(timeline).toEqual(['git add']);
    });
  });

  describe('a filesystem that refuses the write publishes no marker', () => {
    it('reports the write, and asks Git for nothing more', async () => {
      const { deps, fs, timeline } = world();
      fs.failWrite = (_operation, path) =>
        path.includes('attempt-1.json') ? new Error(`ENOSPC: no space left, ${path}`) : undefined;

      const outcome = await recordAttempt(deps, request());

      expect(!outcome.ok && outcome.failure.code).toBe('attempt_artifact_unwritable');
      expect(await fs.exists(ARTIFACT)).toBe(false);
      // The tree was captured and the nonce was drawn — both happened before the
      // write — and neither becomes a marker. The artifact is the authority, so
      // a marker without one would be a commit nothing can ever vouch for.
      expect(timeline).toEqual(['git add', 'git write-tree', 'randomHex(16)']);
    });

    it('does not let the failure escape as an exception', async () => {
      // A throw here would unwind past the caller's judgement and out of the
      // wave's dispatch, and the run would fail on a stack trace instead of on a
      // task that says what happened to it.
      const { deps, fs } = world();
      fs.failWrite = () => new Error('EACCES: permission denied');

      await expect(recordAttempt(deps, request())).resolves.toMatchObject({ ok: false });
    });

    it('names no path in what a person reads', async () => {
      const { deps, fs } = world();
      fs.failWrite = (_operation, path) => new Error(`ENOSPC: no space left on device, ${path}`);

      const outcome = await recordAttempt(deps, request());

      // The filesystem's message names the file it failed on; §7.2 keeps that
      // out of a note, so the message is dropped rather than forwarded.
      expect(!outcome.ok && outcome.failure.detail).not.toContain('/repo');
      expect(!outcome.ok && outcome.failure.detail).not.toContain('.agent-flow');
    });
  });

  describe('an artifact that does not read back is not repaired', () => {
    /** Writes succeed; the read of the attempt comes back corrupted. */
    function corruptingReadOf(fs: InMemoryFileSystem) {
      return new Proxy(fs, {
        get(target, property, receiver) {
          if (property !== 'readFile') return Reflect.get(target, property, receiver);
          return async (path: string) =>
            path.includes('attempt-1.json')
              ? '{ "run": "AF-2026-001", truncated'
              : target.readFile(path);
        },
      });
    }

    it('refuses, publishes nothing, and writes the file exactly once', async () => {
      const { deps, fs } = world();
      const outcome = await recordAttempt(
        { ...deps, fs: corruptingReadOf(fs) },
        request(),
      );

      expect(!outcome.ok && outcome.failure.code).toBe('attempt_artifact_unreadable');

      // Written once and left alone. The repair that suggests itself — write it
      // again, it is the same content — is the one thing §11.3 forbids: a path
      // that can rewrite an artifact is a path that can replace a receipt, and
      // the second write would carry a *different* nonce.
      expect(fs.writes.filter((path) => path === ARTIFACT)).toHaveLength(1);
    });

    it('publishes no marker from an artifact it could not read', async () => {
      const { deps, fs, timeline } = world();

      await recordAttempt({ ...deps, fs: corruptingReadOf(fs) }, request());

      // Not "it failed so it stopped" — this is the §12.2 property under a
      // failure. Every input to `commit-tree` comes from the persisted file, so
      // a file that does not read back has no inputs, and building the marker
      // from the in-memory copy instead would produce a commit no later process
      // could ever reconstruct.
      expect(timeline).not.toContain('git commit-tree');
      expect(timeline).not.toContain('git update-ref');
    });
  });

  describe('a marker that cannot be published leaves the evidence standing', () => {
    for (const [step, failing, reached] of [
      ['commit-tree', 'commit-tree', ['git add', 'git write-tree', 'randomHex(16)', 'git commit-tree']],
      [
        'update-ref',
        'update-ref',
        ['git add', 'git write-tree', 'randomHex(16)', 'git commit-tree', 'git update-ref'],
      ],
    ] as const) {
      it(`keeps the artifact byte-for-byte when ${step} fails`, async () => {
        const { deps, fs, timeline } = world({ failing });

        const outcome = await recordAttempt(deps, request());

        expect(!outcome.ok && outcome.failure.code).toBe('attempt_marker_unpublishable');
        expect(timeline).toEqual(reached);

        // The artifact was written before the marker was attempted, and it stays
        // — with its receipt, and with `satisfied` intact. This is §17.3 window
        // 3 as a live state rather than as a crash: evidence exists, the marker
        // does not, and recovery re-runs `commit-tree` to the same SHA. Deleting
        // it "to keep things consistent" would destroy the only record of which
        // tree was validated.
        const persisted = await readAttempt({ fs, projectDir: PROJECT }, RUN, 'TASK-003', 1);
        expect(persisted?.validationJudgement).toBe('satisfied');
        expect(persisted?.receipt?.nonce).toMatch(/^[0-9a-f]{32}$/);
        expect(persisted?.receipt?.validatedTree).toBe(TREE);
        expect(fs.writes.filter((path) => path === ARTIFACT)).toHaveLength(1);

        expect(!outcome.ok && outcome.failure.detail).not.toContain(WORKSPACE);
      });
    }

    it('does not point the ref at a marker commit-tree never produced', async () => {
      const { deps, processRunner } = world({ failing: 'commit-tree' });

      await recordAttempt(deps, request());

      expect(processRunner.calls.map((call) => subcommandOf(call.args))).not.toContain('update-ref');
    });
  });

  describe('the judgement is never rewritten to make the schema fit', () => {
    for (const failing of ['commit-tree', 'update-ref'] as const) {
      it(`keeps satisfied on disk when ${failing} fails`, async () => {
        // The tempting shape, and the reason this test exists: the artifact says
        // `satisfied`, the marker does not exist, so "downgrade it to
        // unsatisfied and drop the receipt" makes everything look consistent.
        // It also destroys the record that the validation commands passed, and
        // writes a false statement into the one file §17.1 says to trust first.
        const { deps, fs } = world({ failing });

        await recordAttempt(deps, request());

        const raw = await fs.readFile(ARTIFACT);
        const persisted = TaskAttemptResultSchema.parse(JSON.parse(raw));

        expect(persisted.validationJudgement).toBe('satisfied');
        expect(persisted.validationJudgement).not.toBe('unsatisfied');
        expect(persisted.validationJudgement).not.toBe('not_reached');
        expect(persisted.receipt).toBeDefined();
        expect(persisted.validation.passed).toBe(true);
      });
    }

    it('does not record a capture failure as a validation outcome', async () => {
      // The other direction of the same mistake: no artifact is written at all
      // when the tree could not be captured, so there is no file claiming the
      // expectation was unmet by a run that met it.
      const { deps, fs } = world({ failing: 'write-tree' });

      await recordAttempt(deps, request());

      expect(await fs.exists(ARTIFACT)).toBe(false);
    });
  });
});

describe('reading an attempt back', () => {
  it('answers null for an attempt that was never written', async () => {
    const { deps, fs } = world();
    expect(await readAttempt({ fs, projectDir: PROJECT }, RUN, 'TASK-003', 9)).toBeNull();
    void deps;
  });

  it('answers null for a file that does not parse, rather than half of it', async () => {
    const { fs } = world();
    fs.seed(runPaths(PROJECT, RUN).taskAttempt('TASK-003', 1), '{ not json');

    expect(await readAttempt({ fs, projectDir: PROJECT }, RUN, 'TASK-003', 1)).toBeNull();
  });

  it('answers null for a forged half — a receipt with an unsatisfied judgement', async () => {
    const { fs } = world();
    fs.seed(
      runPaths(PROJECT, RUN).taskAttempt('TASK-003', 1),
      JSON.stringify({
        ...draft({ validationJudgement: 'unsatisfied' }),
        receipt: { nonce: 'b'.repeat(32), validatedTree: TREE, issuedAt: '2026-08-09T20:00:00.000Z' },
      }),
    );

    expect(await readAttempt({ fs, projectDir: PROJECT }, RUN, 'TASK-003', 1)).toBeNull();
  });
});
