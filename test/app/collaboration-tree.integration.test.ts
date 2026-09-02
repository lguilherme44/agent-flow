import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { CollaborationStore } from '../../src/app/collaboration-store.js';
import { CollaborationService } from '../../src/app/collaboration-service.js';
import { StateStore } from '../../src/app/state-store.js';
import { captureAttemptChange } from '../../src/app/attempt-receipt.js';
import { AGENT_OUTBOX_FILENAME, agentOutboxPath } from '../../src/app/paths.js';
import { deriveAgentRoster } from '../../src/core/collaboration/roster.js';
import { CollaborationConfigSchema, GlobalConfigSchema } from '../../src/contracts/index.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';

/**
 * I-32, against real Git.
 *
 * **The one claim in M4 that a fake cannot make.** Everything else about the harvest is a
 * decision this code takes and can be tested in memory; this is a claim about what `git
 * add -A` and `git write-tree` do to a file that is present at that moment — and a fake
 * would only ever confirm what the fake was told.
 *
 * What is being proved is the *ordering*. The agent writes an outbox into its workspace;
 * the harvest reads and removes it; and the tree captured afterwards is byte-identical to
 * the tree that would have been captured had the agent never written it. If the harvest
 * ran one line later, that tree would contain agent-authored JSON, the receipt would be
 * bound to it, the marker would carry it, and every merge would put it on the integration
 * branch.
 */

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

const RUN = 'AF-2026-001';

const roster = deriveAgentRoster(
  GlobalConfigSchema.parse({
    runners: { claude: { type: 'claude-code-cli' } },
    roles: {
      architect: { runner: 'claude', effort: 'high' },
      sdd: { runner: 'claude', effort: 'high' },
      planner: { runner: 'claude', effort: 'high' },
      planReviewer: { runner: 'claude', effort: 'high' },
      executors: {
        trivial: { runner: 'claude', effort: 'low' },
        normal: { runner: 'claude', effort: 'medium' },
        complex: { runner: 'claude', effort: 'high' },
      },
      verification: { runner: 'claude', effort: 'medium' },
      finalReviewer: { runner: 'claude', effort: 'high' },
    },
  }),
);

/**
 * What `agent-flow init` writes, so the repository under test looks like a real one.
 *
 * Without it `.agent-flow/runs/` is untracked and shows up in every diff, which would
 * make this file assert against a repository no operator has. `init` ignores the run
 * directory and versions the config, and that distinction is the reason the log can live
 * inside the project at all.
 */
function ignoreRunState(current: TempRepo): void {
  current.write('.gitignore', '.agent-flow/runs/\n.agent-flow/cache/\n.agent-flow/current-run\n');
  current.commitAll('ignore agent-flow run state');
}

function serviceOn(current: TempRepo): CollaborationService {
  const fs = new NodeFileSystem();
  const clock = new FixedClock();

  return new CollaborationService({
    fs,
    clock,
    store: new StateStore({ fs, clock, projectDir: current.dir }),
    collaboration: new CollaborationStore({ fs, projectDir: current.dir }),
    roster,
    config: CollaborationConfigSchema.parse({ enabled: true }),
  });
}

const OUTBOX = JSON.stringify({
  messages: [
    {
      to: { kind: 'agent', id: 'architect' },
      type: 'question',
      subject: 'which idempotency key?',
      body: 'the SDD names one but does not say where it is generated',
    },
  ],
  entries: [
    { kind: 'discovery', subject: 'retry-backoff', statement: 'the retry is exponential' },
  ],
});

describe('the outbox never reaches a validated tree (I-32)', () => {
  it('captures the same tree as a run where the agent never wrote one', async () => {
    // The whole claim, as a comparison rather than as an assertion about a hash nobody
    // can read. Two attempts doing identical work, one of which also spoke.
    const current = await makeTempRepoWithCommit();
    repo = current;
    ignoreRunState(current);
    const service = serviceOn(current);
    const state = new StateStore({
      fs: new NodeFileSystem(),
      clock: new FixedClock(),
      projectDir: current.dir,
    });
    await state.createRun('a feature');

    const base = current.head();

    // Silent attempt: change a file, capture.
    current.write('a.ts', 'export const a = 1;\n');
    const silent = await captureAttemptChange(
      { workspaces: current.workspaces },
      { workspacePath: current.dir, base },
    );

    // Reset the index so the second capture starts from the same place.
    current.userGit(['reset', '--quiet']);

    // Speaking attempt: the same change, plus an outbox, harvested before the capture.
    writeFileSync(agentOutboxPath(current.dir), OUTBOX);
    await service.harvest({
      runId: RUN,
      taskId: 'TASK-001',
      agentId: 'executor.normal',
      workspaceDir: current.dir,
    });
    const speaking = await captureAttemptChange(
      { workspaces: current.workspaces },
      { workspacePath: current.dir, base },
    );

    expect(speaking.validatedTree).toBe(silent.validatedTree);
  });

  it('leaves the outbox out of the changed-file list', async () => {
    // `filesChanged` reaches the result, the review and the acceptance assertion. A
    // scope-containment check that saw `.agent-flow-outbox.json` would fail a task for
    // writing a file the product told it to write.
    const current = await makeTempRepoWithCommit();
    repo = current;
    ignoreRunState(current);
    const service = serviceOn(current);
    await new StateStore({
      fs: new NodeFileSystem(),
      clock: new FixedClock(),
      projectDir: current.dir,
    }).createRun('a feature');

    const base = current.head();
    current.write('a.ts', 'export const a = 1;\n');
    writeFileSync(agentOutboxPath(current.dir), OUTBOX);

    await service.harvest({
      runId: RUN,
      taskId: 'TASK-001',
      agentId: 'executor.normal',
      workspaceDir: current.dir,
    });
    const observed = await captureAttemptChange(
      { workspaces: current.workspaces },
      { workspacePath: current.dir, base },
    );

    expect(observed.changedFiles).toEqual(['a.ts']);
    expect(observed.changedFiles).not.toContain(AGENT_OUTBOX_FILENAME);
  });

  it('removes the file from the working tree, so it is not in the user’s git status', async () => {
    // Sequential mode writes the outbox in the operator's own working tree. A file
    // nobody wrote appearing in their `git status` is a real cost, and the cheapest
    // moment to avoid it is the one where it is already being read.
    const current = await makeTempRepoWithCommit();
    repo = current;
    ignoreRunState(current);
    const service = serviceOn(current);
    await new StateStore({
      fs: new NodeFileSystem(),
      clock: new FixedClock(),
      projectDir: current.dir,
    }).createRun('a feature');

    writeFileSync(agentOutboxPath(current.dir), OUTBOX);

    await service.harvest({
      runId: RUN,
      taskId: 'TASK-001',
      agentId: 'executor.normal',
      workspaceDir: current.dir,
    });

    expect(existsSync(agentOutboxPath(current.dir))).toBe(false);
    expect(current.userGit(['status', '--porcelain'])).not.toContain(AGENT_OUTBOX_FILENAME);
  });

  it('keeps the record it harvested, outside every checkout', async () => {
    // The other half of the same guarantee: the outbox leaves the tree, and what it
    // said does not leave with it. The log lives under `.agent-flow/runs/`, which is
    // gitignored and is not part of any checkout an agent receives.
    const current = await makeTempRepoWithCommit();
    repo = current;
    ignoreRunState(current);
    const service = serviceOn(current);
    await new StateStore({
      fs: new NodeFileSystem(),
      clock: new FixedClock(),
      projectDir: current.dir,
    }).createRun('a feature');

    writeFileSync(agentOutboxPath(current.dir), OUTBOX);
    await service.harvest({
      runId: RUN,
      taskId: 'TASK-001',
      agentId: 'executor.normal',
      workspaceDir: current.dir,
    });

    const store = new CollaborationStore({ fs: new NodeFileSystem(), projectDir: current.dir });
    expect(await store.readMessages(RUN)).toHaveLength(1);
    expect(await store.readEntries(RUN)).toHaveLength(1);
    expect(existsSync(join(current.dir, '.agent-flow', 'runs', RUN, 'collaboration'))).toBe(true);
  });
});
