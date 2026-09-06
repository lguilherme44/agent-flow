import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInitCommand } from '../../src/cli/init.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';

/**
 * `init` names the wall the project is about to walk into (PRI-25).
 *
 * `stack-detection.ts` already knows about it: it prefers `npm ci` precisely because
 * `npm install` rewrites `package-lock.json`, which fails the post-setup cleanliness
 * assertion and makes worktree mode refuse every task. It falls back to `npm install` when
 * there is no lockfile to respect — correctly, since `npm ci` refuses without one.
 *
 * So a project with no committed lockfile was handed a command known to break it, and
 * nothing said so. A live run found out the expensive way: five planning stages completed,
 * four tasks were dispatched, and every one was refused at the setup check — after the
 * planning had been paid for. The remedy is one commit, and it is worth a sentence before
 * the money rather than a diagnosis after it.
 */

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

const globalsFor = (cwd: string) => ({
  cwd,
  globalConfigPath: join(cwd, 'global.yaml'),
  strict: false,
  verbose: false,
  json: false,
  dryRun: false,
});

async function capture(body: () => Promise<number>) {
  let stdout = '';
  const originalOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    return { exitCode: await body(), stdout };
  } finally {
    process.stdout.write = originalOut;
  }
}

describe('`init` on a Node project with no lockfile', () => {
  it('warns that every task will be refused until the lockfile is committed', async () => {
    repo = await makeTempRepoWithCommit();
    writeFileSync(
      join(repo.dir, 'package.json'),
      JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }),
    );

    const { exitCode, stdout } = await capture(() => runInitCommand({}, globalsFor(repo!.dir)));

    expect(exitCode).toBe(ExitCode.OK);
    // The command it wrote, quoted back, so the sentence is about this project.
    expect(stdout).toContain('npm install');
    expect(stdout).toContain('setup check');
    expect(stdout).toContain('commit the lockfile');
  });

  it('says nothing when the lockfile is already there', async () => {
    // `stack-detection.ts` writes `npm ci` in that case, which respects the lock and
    // leaves the tree identical. A warning here would be noise on every healthy project,
    // and a warning that fires on everything is a warning nobody reads.
    repo = await makeTempRepoWithCommit();
    writeFileSync(join(repo.dir, 'package.json'), JSON.stringify({ name: 'demo' }));
    writeFileSync(join(repo.dir, 'package-lock.json'), '{"lockfileVersion":3}');

    const { stdout } = await capture(() => runInitCommand({}, globalsFor(repo!.dir)));

    // Asserted on what was written rather than on what was printed: `init` prints the
    // files it created, and the install command only reaches the screen when it is the
    // subject of the warning — which is the whole point of this case.
    expect(readFileSync(join(repo.dir, '.agent-flow', 'config.yaml'), 'utf8')).toContain('npm ci');
    expect(stdout).not.toContain('setup check');
  });

  it('says nothing for a stack whose install command was never observed to do this', async () => {
    // A Go project installs nothing that rewrites a tracked file, and guessing at other
    // managers' behaviour is the kind of unprobed claim `installCommand` refuses to make.
    repo = await makeTempRepoWithCommit();
    writeFileSync(join(repo.dir, 'go.mod'), 'module demo\n\ngo 1.22\n');

    const { stdout } = await capture(() => runInitCommand({}, globalsFor(repo!.dir)));

    expect(stdout).not.toContain('setup check');
  });
});
