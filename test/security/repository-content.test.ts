import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { TaskExecutor } from '../../src/app/task-executor.js';

/**
 * T6 — repository content, read by the orchestrator on the agent's behalf.
 *
 * The threat model says a model influenced by repository content is still influenced: it
 * reads the repository, that is the job. What is *not* covered is the orchestrator reading
 * a file **for** it — with the orchestrator's privileges, outside whatever sandbox the
 * vendor applies to the agent.
 *
 * `AGENTS.md` is exactly that path, and until this suite existed both of its properties
 * were untested. Measured before the fix: a symlink to a file outside the workspace was
 * followed and its contents interpolated into the implementation prompt.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-flow-adversarial-'));
  roots.push(root);
  return root;
}

/**
 * `readAgentsMd`, reached the way the implementation stage reaches it.
 *
 * Private, so it is called through the instance rather than re-implemented here — a test
 * that re-implemented the containment check would pass by agreeing with itself.
 */
function readAgentsMd(fs: InMemoryFileSystem | NodeFileSystem, workingDirectory: string) {
  const executor = new TaskExecutor({
    fs,
    clock: new FixedClock(),
    projectDir: workingDirectory,
  } as unknown as ConstructorParameters<typeof TaskExecutor>[0]);

  return (
    executor as unknown as { readAgentsMd(dir: string): Promise<string> }
  ).readAgentsMd(workingDirectory);
}

describe('AGENTS.md, which this process opens and the agent does not', () => {
  it('is not followed out of the workspace', async () => {
    // The finding. A repository ships `AGENTS.md` as a symlink to a file the operator can
    // read and the agent cannot; before the fix, this process opened it and pasted the
    // contents into the prompt. The agent could not have reached it — this could.
    const root = scratch();
    const secret = join(root, 'outside-the-workspace.txt');
    const workspace = join(root, 'repo');

    mkdirSync(workspace);
    writeFileSync(secret, 'PRIVATE-KEY-MATERIAL', 'utf8');
    symlinkSync(secret, join(workspace, 'AGENTS.md'));

    const rendered = await readAgentsMd(new NodeFileSystem(), workspace);

    expect(rendered).not.toContain('PRIVATE-KEY-MATERIAL');
    // And says why, because a task that silently lost its instructions is worse than one
    // told the repository shipped a strange file.
    expect(rendered).toMatch(/outside/i);
  });

  it('is still read when it is an ordinary file', async () => {
    // The fix must not cost the feature. A repository's real instructions still arrive.
    const root = scratch();
    const workspace = join(root, 'repo');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'AGENTS.md'), '# House rules\n\nUse tabs.', 'utf8');

    expect(await readAgentsMd(new NodeFileSystem(), workspace)).toContain('Use tabs.');
  });

  it('is still read through a symlink that stays inside the workspace', async () => {
    // A repository that keeps its docs in `docs/` and links to them is doing something
    // ordinary. Containment is about leaving the workspace, not about symlinks.
    const root = scratch();
    const workspace = join(root, 'repo');
    mkdirSync(join(workspace, 'docs'), { recursive: true });
    writeFileSync(join(workspace, 'docs', 'agents.md'), 'linked but inside', 'utf8');
    symlinkSync(join(workspace, 'docs', 'agents.md'), join(workspace, 'AGENTS.md'));

    expect(await readAgentsMd(new NodeFileSystem(), workspace)).toContain('linked but inside');
  });

  it('is bounded, and says how much is missing', async () => {
    // `measurePromptComposition` measures and does not enforce, and it runs after this —
    // so before the ceiling, a repository decided how large every implementation prompt
    // was. Truncation is explicit: a prompt that quietly stopped carrying the instructions
    // it claims to carry is worse than a bounded one.
    const fs = new InMemoryFileSystem();
    fs.seed('/repo/AGENTS.md', 'x'.repeat(200_000));

    const rendered = await readAgentsMd(fs, '/repo');

    expect(rendered.length).toBeLessThan(200_000);
    expect(rendered).toMatch(/truncated/i);
    expect(rendered).toContain('200000');
  });

  it('says so plainly when there is none', async () => {
    const fs = new InMemoryFileSystem();

    expect(await readAgentsMd(fs, '/repo')).toMatch(/No AGENTS\.md/);
  });
});
