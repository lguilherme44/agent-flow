import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { initProject, registerProject } from '../../src/app/init-project.js';
import { StateStore } from '../../src/app/state-store.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { ProjectConfigSchema, type RunStatus } from '../../src/contracts/index.js';

const PROJECT = '/repo';

function seeded(files: Record<string, string> = {}): InMemoryFileSystem {
  const fs = new InMemoryFileSystem();
  for (const [path, content] of Object.entries(files)) fs.seed(`${PROJECT}/${path}`, content);
  return fs;
}

const nodeRepo = {
  'package.json': JSON.stringify({ name: 'booking-api', scripts: { test: 'vitest', lint: 'eslint .' } }),
};

describe('a fresh repository', () => {
  it('creates the config, AGENTS.md and a gitignore block', async () => {
    const fs = seeded(nodeRepo);
    const result = await initProject({ fs, projectDir: PROJECT });

    expect(result.created).toEqual(
      expect.arrayContaining([
        '/repo/.agent-flow/config.yaml',
        '/repo/AGENTS.md',
        '/repo/.gitignore',
      ]),
    );
  });

  it('writes a config that validates against the schema', async () => {
    // A file this tool generates must not be one this tool then rejects.
    const fs = seeded(nodeRepo);
    await initProject({ fs, projectDir: PROJECT });

    const raw = await fs.readFile('/repo/.agent-flow/config.yaml');
    expect(() => ProjectConfigSchema.parse(parseYaml(raw))).not.toThrow();
  });

  it('fills in the commands the repository actually declares', async () => {
    const fs = seeded(nodeRepo);
    await initProject({ fs, projectDir: PROJECT });

    const config = ProjectConfigSchema.parse(
      parseYaml(await fs.readFile('/repo/.agent-flow/config.yaml')),
    );

    expect(config.commands.test).toBe('npm run test');
    expect(config.commands.lint).toBe('npm run lint');
    expect(config.commands.build).toBeUndefined();
  });

  it('ignores run state but keeps the config versioned', async () => {
    // config.yaml is a team convention and belongs in git; runs are local noise.
    const fs = seeded(nodeRepo);
    await initProject({ fs, projectDir: PROJECT });

    const gitignore = await fs.readFile('/repo/.gitignore');
    expect(gitignore).toContain('.agent-flow/runs/');
    expect(gitignore).not.toContain('.agent-flow/config.yaml');
  });
});

describe('an unrecognised stack', () => {
  it('still produces a usable config instead of failing (§7)', async () => {
    const fs = seeded({ 'README.md': '# something' });
    const result = await initProject({ fs, projectDir: PROJECT });

    expect(result.stack.type).toBe('unknown');
    expect(result.created).toContain('/repo/.agent-flow/config.yaml');
  });

  it('says why the commands are empty', async () => {
    const fs = seeded({ 'README.md': '# something' });
    await initProject({ fs, projectDir: PROJECT });

    const raw = await fs.readFile('/repo/.agent-flow/config.yaml');
    expect(raw).toMatch(/not recognised/i);
  });
});

describe('existing files are not clobbered (§7.7)', () => {
  it('leaves an existing config alone', async () => {
    // init is the first command run in a repository someone cares about.
    const fs = seeded({ ...nodeRepo, '.agent-flow/config.yaml': 'project:\n  name: mine\n' });
    const result = await initProject({ fs, projectDir: PROJECT });

    expect(result.skipped).toContain('/repo/.agent-flow/config.yaml');
    expect(await fs.readFile('/repo/.agent-flow/config.yaml')).toContain('name: mine');
  });

  it('does not upgrade an existing project to the lockfile-respecting install (§8.4)', async () => {
    // §8.4 changes what a *new* Node project is given — `npm ci` rather than
    // `npm install` — and says in the same breath that it MUST NOT rewrite an
    // existing `.agent-flow/config.yaml`. Worth its own case rather than trusting
    // the general skip rule above: "how do I install this project" is the one
    // setting where a silent upgrade would change what runs on someone's machine,
    // and `npm ci` deletes `node_modules` before it starts.
    const existing = 'project:\n  name: mine\n  type: node\ncommands:\n  install: npm install\n';
    const fs = seeded({
      ...nodeRepo,
      'package-lock.json': '{"lockfileVersion":3}',
      '.agent-flow/config.yaml': existing,
    });

    const result = await initProject({ fs, projectDir: PROJECT });

    expect(result.skipped).toContain('/repo/.agent-flow/config.yaml');
    expect(await fs.readFile('/repo/.agent-flow/config.yaml')).toBe(existing);
    // And the detection itself did notice the lockfile — so the config survived
    // on purpose rather than because nothing wanted to change it.
    expect(result.stack.commands.install).toBe('npm ci');
  });

  it('overwrites only when explicitly asked', async () => {
    const fs = seeded({ ...nodeRepo, '.agent-flow/config.yaml': 'project:\n  name: mine\n' });
    const result = await initProject({ fs, projectDir: PROJECT, force: true });

    expect(result.updated).toContain('/repo/.agent-flow/config.yaml');
    expect(await fs.readFile('/repo/.agent-flow/config.yaml')).toContain('booking-api');
  });

  it('does not duplicate the gitignore block on a second run', async () => {
    const fs = seeded(nodeRepo);
    await initProject({ fs, projectDir: PROJECT });
    await initProject({ fs, projectDir: PROJECT });

    const gitignore = await fs.readFile('/repo/.gitignore');
    expect(gitignore.match(/\.agent-flow\/runs\//g)).toHaveLength(1);
  });

  it('preserves existing gitignore entries', async () => {
    const fs = seeded({ ...nodeRepo, '.gitignore': 'node_modules/\ndist/\n' });
    await initProject({ fs, projectDir: PROJECT });

    const gitignore = await fs.readFile('/repo/.gitignore');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('.agent-flow/runs/');
  });
});

describe('AGENTS.md is appended to, never replaced (§37)', () => {
  it('keeps hand-written rules and adds a marked block', async () => {
    // AGENTS.md holds the standing rules the whole workflow depends on.
    // Overwriting it would destroy exactly the context that makes agent-flow
    // useful in a real repository.
    const fs = seeded({
      ...nodeRepo,
      'AGENTS.md': '# Project Instructions\n\n## Architecture\n\n- Controllers stay thin.\n',
    });

    await initProject({ fs, projectDir: PROJECT });
    const agents = await fs.readFile('/repo/AGENTS.md');

    expect(agents).toContain('Controllers stay thin.');
    expect(agents).toContain('agent-flow:begin');
  });

  it('replaces only its own block on a second run', async () => {
    const fs = seeded({
      ...nodeRepo,
      'AGENTS.md': '# Rules\n\n- Never touch production.\n',
    });

    await initProject({ fs, projectDir: PROJECT });
    await initProject({ fs, projectDir: PROJECT });

    const agents = await fs.readFile('/repo/AGENTS.md');
    expect(agents.match(/agent-flow:begin/g)).toHaveLength(1);
    expect(agents).toContain('Never touch production.');
  });

  it('refreshes the block when the commands change', async () => {
    const fs = seeded(nodeRepo);
    await initProject({ fs, projectDir: PROJECT });

    fs.seed(
      `${PROJECT}/package.json`,
      JSON.stringify({ name: 'booking-api', scripts: { test: 'vitest', build: 'tsc' } }),
    );
    await initProject({ fs, projectDir: PROJECT });

    const agents = await fs.readFile('/repo/AGENTS.md');
    expect(agents).toContain('npm run build');
    expect(agents).not.toContain('npm run lint');
  });

  it('creates a starting point when there is none', async () => {
    const fs = seeded(nodeRepo);
    await initProject({ fs, projectDir: PROJECT });

    const agents = await fs.readFile('/repo/AGENTS.md');
    expect(agents).toContain('# Project Instructions');
    expect(agents).toContain('## Architecture');
  });
});

/**
 * Rules kept where agent-flow never looks (§37).
 *
 * Every stage prompt receives AGENTS.md and no other instruction file, so a repository
 * whose real rules live elsewhere is planned against rules nobody wrote. Measured: a
 * monorepo's AGENTS.md had drifted 641 lines behind its CLAUDE.md, and the drift included
 * the section naming the repository's own code index — discovery read the tree by hand
 * until its timeout killed it.
 */
describe('instruction files agent-flow does not read', () => {
  it('names a CLAUDE.md that says something a person-written AGENTS.md does not', async () => {
    // The case the warning still exists for: the repository chose an AGENTS.md, so that is
    // what stages receive, and a diverging CLAUDE.md beside it really is unread.
    const fs = seeded({
      ...nodeRepo,
      'AGENTS.md': '# Rules\n\n- services never import routes.\n',
      'CLAUDE.md': '# Rules\n\nUse the codegraph index first.\n',
    });
    const result = await initProject({ fs, projectDir: PROJECT });

    expect(result.warnings).toContainEqual({
      kind: 'instructions_unread',
      paths: ['CLAUDE.md'],
    });
  });

  it('says CLAUDE.md is what stages read when AGENTS.md is only the scaffold it just wrote', async () => {
    // Measured on a Python service: this used to warn "CLAUDE.md is never read" — true then,
    // and the repository's 227 lines of rules were invisible. Now it is read in the
    // scaffold's place, and the operator is told so instead of being told the opposite.
    const fs = seeded({ ...nodeRepo, 'CLAUDE.md': '# Rules\n\nUse the codegraph index first.\n' });
    const result = await initProject({ fs, projectDir: PROJECT });

    expect(result.warnings.map((warning) => warning.kind)).not.toContain('instructions_unread');
    expect(result.warnings).toContainEqual({ kind: 'instructions_fallback', path: 'CLAUDE.md' });
  });

  it('says nothing about a mirror that agrees', async () => {
    // Positive control for the assertion above: the warning has to be about *drift*, not
    // about a second file existing. Two identical copies — one per tool — is the healthy
    // arrangement, and nagging about it trains people past the warning that matters.
    const fs = seeded(nodeRepo);
    await initProject({ fs, projectDir: PROJECT });

    const agents = await fs.readFile(`${PROJECT}/AGENTS.md`);
    fs.seed(`${PROJECT}/CLAUDE.md`, agents);
    const result = await initProject({ fs, projectDir: PROJECT });

    expect(result.warnings.map((warning) => warning.kind)).not.toContain('instructions_unread');
  });

  it('ignores a difference that is only whitespace', async () => {
    const fs = seeded(nodeRepo);
    await initProject({ fs, projectDir: PROJECT });

    const agents = await fs.readFile(`${PROJECT}/AGENTS.md`);
    fs.seed(`${PROJECT}/CLAUDE.md`, `${agents}\n\n\n`);
    const result = await initProject({ fs, projectDir: PROJECT });

    expect(result.warnings.map((warning) => warning.kind)).not.toContain('instructions_unread');
  });

  it('names every unread file, in one warning', async () => {
    const fs = seeded({
      ...nodeRepo,
      'AGENTS.md': '# Rules of our own\n',
      'CLAUDE.md': '# One\n',
      'GEMINI.md': '# Two\n',
    });
    const result = await initProject({ fs, projectDir: PROJECT });

    const unread = result.warnings.find((warning) => warning.kind === 'instructions_unread');
    expect(unread).toMatchObject({ paths: ['CLAUDE.md', 'GEMINI.md'] });
  });

  it('says nothing when there is nothing beside AGENTS.md', async () => {
    const fs = seeded(nodeRepo);
    const result = await initProject({ fs, projectDir: PROJECT });

    expect(result.warnings.map((warning) => warning.kind)).not.toContain('instructions_unread');
  });
});

/**
 * The AR-01 gate, which had no test at all — which is how `cancelled` slipped past it.
 *
 * `init` writes files that have to be committed, and that commit moves HEAD. A run's
 * planningBase is frozen when the run is created, so writing while one is open leaves it
 * planning against one base and executing against another. The gate is the defence.
 *
 * Measured, on a real repository: a warm-up's process died, its run stayed at `running`,
 * and `init` refused — correctly. `cancel`, the one supported way to close a run, wrote
 * `cancelled`, which the gate also read as open. There was no path out but `--force`,
 * which bypasses the gate rather than satisfying it.
 */
describe('the gate that protects a run’s planningBase (AR-01)', () => {
  async function withRun(status: RunStatus) {
    const fs = seeded(nodeRepo);
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: PROJECT });
    const run = await store.createRun('a feature');
    await store.updateRun(run.runId, (state) => ({ ...state, status }));

    return { fs, store, runId: run.runId };
  }

  it('refuses to write while a run is still open', async () => {
    const { store, fs } = await withRun('running');
    const outcome = await registerProject({ store, fs, projectDir: PROJECT });

    expect(outcome).toMatchObject({ ok: false, reason: 'active_run' });
    // "It writes nothing" is half the contract, so the refusal is asserted by absence too.
    expect(await fs.exists(`${PROJECT}/.agent-flow/config.yaml`)).toBe(false);
  });

  it('writes once the run has ended', async () => {
    for (const status of ['completed', 'failed'] as const) {
      const { store, fs } = await withRun(status);
      expect(await registerProject({ store, fs, projectDir: PROJECT })).toMatchObject({ ok: true });
    }
  });

  it('treats a cancelled run as ended, because it is', async () => {
    // `state.schema.ts`: "the one terminal outcome that is neither completed nor failed …
    // what is gone is the intent to continue". The gate read the complement and disagreed
    // with it, so cancelling released nothing.
    const { store, fs } = await withRun('cancelled');

    expect(await registerProject({ store, fs, projectDir: PROJECT })).toMatchObject({ ok: true });
  });

  it('still refuses every status that has not ended', async () => {
    // Positive control for the test above: `cancelled` was added to a list, not the list
    // replaced by a blanket. A run waiting for a human is still a run.
    for (const status of ['running', 'waiting_for_approval', 'plan_rejected', 'approved'] as const) {
      const { store, fs } = await withRun(status);
      expect(await registerProject({ store, fs, projectDir: PROJECT })).toMatchObject({
        ok: false,
        reason: 'active_run',
      });
    }
  });

  it('writes anyway under --force, and records the override on the run', async () => {
    const { store, fs, runId } = await withRun('running');
    const outcome = await registerProject({ store, fs, projectDir: PROJECT, force: true });

    expect(outcome).toMatchObject({ ok: true });
    const events = await store.readEvents(runId);
    expect(events.find((event) => event.type === 'init_during_active_run')?.detail).toMatchObject({
      forced: true,
      status: 'running',
    });
  });
});
