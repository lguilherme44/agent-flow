import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diagnose } from '../../src/app/diagnostics.js';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { NodeProcessRunner } from '../../src/adapters/process/node-process-runner.js';
import { loadConfig } from '../../src/config/loader.js';
import { en } from '../../src/core/phrases/index.js';
import type { ProcessRunner } from '../../src/ports/index.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';

const READ_ONLY_PROMPTS = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
  'code-review',
  'verification',
  'final-review',
];

/**
 * FR-018 rule (b) against real Git (AC-16): `**` + `/*` names no `.env`, so only what the
 * repository actually holds can make it warn — and only Git's own listing says what that is.
 *
 * Git is real and nothing else is: node and every runner CLI answer from a fake, so the test
 * spawns no coding agent and depends on none being installed.
 */
describe('doctor rule (b) on real Git (FR-018)', () => {
  let repo: TempRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
    repo = undefined;
  });

  /** A repository whose one ignored file is `ignored`, diagnosed with `worktree.copy: ['**' + '/*']`. */
  async function diagnoseWithIgnored(ignored: string) {
    const created = await makeTempRepoWithCommit();
    repo = created;
    created.initAgentFlow();
    created.write('.gitignore', `${ignored}\n`);
    created.commitAll('ignore one file');
    created.write(ignored, 'SECRET=1\n');

    const prompts = join(created.home, 'prompts');
    mkdirSync(prompts, { recursive: true });
    for (const name of READ_ONLY_PROMPTS) {
      writeFileSync(
        join(prompts, `${name}.md`),
        `---\npermissions: read-only\noutputFormat: markdown\nrequiredVars: [repositoryMap]\n---\n\n# ${name}\n`,
      );
    }
    writeFileSync(
      join(prompts, 'implementation.md'),
      '---\npermissions: write\nworkingDirectory: true\noutputFormat: json\nrequiredVars: [repositoryMap]\n---\n\n# implementation\n',
    );

    const globalConfigPath = join(created.home, '.agent-flow', 'config.yaml');
    mkdirSync(join(created.home, '.agent-flow'), { recursive: true });
    writeFileSync(
      globalConfigPath,
      "runners:\n  claude:\n    type: claude-code-cli\nroles:\n  architect:\n    runner: claude\nworktree:\n  copy: ['**/*']\n",
    );

    const fs = new NodeFileSystem();
    const real = new NodeProcessRunner();
    const fake = new FakeProcessRunner().always({ exitCode: 0, stdout: 'v20.11.0' });
    const processRunner: ProcessRunner = {
      run: (options) => (options.command === 'git' ? real.run(options) : fake.run(options)),
    };
    const config = await loadConfig({ fs, globalConfigPath, projectDir: created.dir });

    const diagnosis = await diagnose({
      fs,
      processRunner,
      host: new FakeHost(1000, 'test-host', [1000], created.home),
      config,
      projectDir: created.dir,
      promptsDir: prompts,
      installProbe: false,
    });
    return { diagnosis, repo: created };
  }

  const envNotes = (notes: readonly string[]) => notes.filter((note) => note.includes('`worktree.copy`'));

  it('warns for **/* in a repository that holds an ignored .env', async () => {
    const { diagnosis } = await diagnoseWithIgnored('.env');

    expect(envNotes(diagnosis.notes)).toEqual([en.doctor.worktreeCopyExposesEnv('**/*')]);
  });

  it('does not warn for **/* in a repository whose only ignored file is not a .env', async () => {
    const { diagnosis, repo: created } = await diagnoseWithIgnored('local.json');

    // Neither the warning nor the unchecked note.
    expect(envNotes(diagnosis.notes)).toEqual([]);
    // Positive control: the same listing does see the ignored file, so the silence above is
    // Git's answer about a repository with no `.env`, not a listing that found nothing.
    const listed = await created.workspaces.listIgnoredFiles({ cwd: created.dir, patterns: ['**/*'] });
    expect(listed.ok && listed.value).toContain('local.json');
  });
});
