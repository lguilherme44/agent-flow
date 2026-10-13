import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { review } from '../../src/app/run-actions.js';
import { fakeRunActionDeps } from '../fakes/run-action-deps.js';
import { renderOutcome } from '../../src/cli/review.js';

/**
 * Dogfood 09/10 — e2e evidence the human can look at.
 *
 * "Prints dos testes e2e … na task de e2e do agent-flow … e, caso tenha artefato, nos dois
 * lugares." The e2e stage kept text only, and its prompt sent screenshots to `$TMPDIR`, where
 * nothing could find them. Now the stage is handed a folder in the run, and what it saved there
 * is listed in `e2e.json`; a human's observation can carry its own files with `--evidence`.
 */

const PROMPTS = ['verification', 'e2e', 'final-review'];

async function setup(options: { e2eVerdict?: 'PASS' | 'NOT_RUN'; screenshots?: readonly string[] } = {}) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const host = new FakeHost();

  fs.seed(
    '/install/config.yaml',
    'runners:\n  claude:\n    type: claude-code-cli\n    enabled: true\nroles:\n  e2e:\n    enabled: true\n    runner: claude\n',
  );
  for (const name of PROMPTS) {
    const required = name === 'e2e' ? ['sdd', 'changedFiles', 'agentsMd'] : [];
    const body = name === 'e2e' ? '# e2e\n\nSave screenshots into {{evidenceDir}}.\n' : `# ${name}\n`;
    fs.seed(
      `/install/prompts/${name}.md`,
      `---\npermissions: write\noutputFormat: json\nrequiredVars: [${required.join(', ')}]\n---\n\n${body}`,
    );
  }
  fs.seed('/shots/phone-1.png', 'PNG');
  fs.seed('/shots/notes.txt', 'not an image');

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('login', () => ({ isolationMode: 'none' as const }));
  await store.writeArtifact(run.runId, 'sdd', '# SDD\n');
  await store.writeArtifact(
    run.runId,
    'plan',
    JSON.stringify({
      feature: 'login',
      tasks: [
        {
          id: 'TASK-001',
          title: 'Login',
          description: 'Login page.',
          complexity: 'normal',
          risk: 'low',
          dependencies: [],
          requirements: ['FR-001'],
          acceptanceCriteria: ['User can log in.'],
          validation: [],
        },
      ],
    }),
  );
  await store.updateRun(run.runId, (state) => ({
    ...state,
    approved: true,
    tasks: [{ id: 'TASK-001', state: 'completed', attempts: 1, infrastructureFailures: 0 }],
  }));

  const pass = { verdict: 'PASS', summary: 'ok', findings: [] };
  const e2e =
    options.e2eVerdict === 'NOT_RUN'
      ? {
          verdict: 'NOT_RUN',
          summary: 'NOT RUN: native only',
          findings: [
            { severity: 'info', type: 'other', description: 'Only observable in the iOS app.', suggestedAction: 'Test it on a device.' },
          ],
        }
      : { verdict: 'PASS', summary: 'Logged in and saw the home page.', findings: [] };
  const envelope = (answer: unknown) => ({
    exitCode: 0,
    stdout: JSON.stringify({ is_error: false, subtype: 'success', result: JSON.stringify(answer), structured_output: answer }),
  });
  const prompts: string[] = [];
  const runner = new FakeProcessRunner().always((call) => {
    const stdin = call.stdin ?? '';
    if (!stdin.includes('# e2e')) return envelope(pass);
    prompts.push(stdin);
    // The agent saves what it saw into the folder its prompt names, as agent-browser would.
    const dir = /Save screenshots into (\S+)\./.exec(stdin)?.[1];
    if (dir !== undefined) {
      for (const name of options.screenshots ?? []) fs.seed(`${dir}/${name}`, 'PNG');
    }
    return envelope(e2e);
  });

  const deps = fakeRunActionDeps({
    fs,
    clock,
    processRunner: runner,
    projectDir: '/repo',
    globalConfigPath: '/install/config.yaml',
    promptsDir: '/install/prompts',
    host,
    owner: 'cli',
  });
  return { fs, store, deps, prompts, runId: run.runId };
}

describe('e2e screenshots as run evidence (dogfood 09/10)', () => {
  it('hands the e2e agent a folder in the run, outside the repository tree it tests', async () => {
    const { deps, prompts, runId } = await setup();

    await review(deps, runId);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`/repo/.agent-flow/runs/${runId}/evidence/e2e/`);
    expect(prompts[0]).not.toContain('{{evidenceDir}}');
  });

  it('lists the images the agent saved in e2e.json and in the outcome, and nothing else', async () => {
    const { store, deps, runId } = await setup({ screenshots: ['01-login.png', '02-home.png', 'trace.zip'] });

    const outcome = await review(deps, runId);
    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    if (!outcome.ok) return;

    const listed = outcome.value.e2eEvidence ?? [];
    expect(listed.map((path) => path.split('/').at(-1))).toEqual(['01-login.png', '02-home.png']);
    for (const path of listed) expect(path.startsWith('evidence/e2e/')).toBe(true);
    const artifact = JSON.parse((await store.readArtifact(runId, 'e2e')) ?? '{}') as { evidence?: string[] };
    expect(artifact.evidence).toEqual(listed);

    // And the terminal says where they are, which is where a person reads the outcome.
    const printed = renderOutcome(outcome.value);
    expect(printed).toContain(`.agent-flow/runs/${runId}/${listed[0] ?? ''}`);
  });

  it('keeps the screenshots of a NOT_RUN too: what the agent saw before it stopped', async () => {
    const { store, deps, runId } = await setup({ e2eVerdict: 'NOT_RUN', screenshots: ['blocked.png'] });

    await review(deps, runId);

    const artifact = JSON.parse((await store.readArtifact(runId, 'e2e')) ?? '{}') as { evidence?: string[] };
    expect(artifact.evidence?.map((path) => path.split('/').at(-1))).toEqual(['blocked.png']);
  });
});

describe('review --e2e-observed --evidence (dogfood 09/10)', () => {
  it('copies the human’s images into the run and records them on the observation', async () => {
    const { fs, store, deps, runId } = await setup({ e2eVerdict: 'NOT_RUN' });

    const outcome = await review(deps, runId, {
      e2eObservation: { by: 'Luis', words: 'vi o popup no iPhone', evidence: ['/shots/phone-1.png'] },
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);

    const observation = (await store.loadRun(runId)).amendments?.find((a) => a.kind === 'e2e_observation');
    expect(observation?.evidence).toHaveLength(1);
    const copied = observation?.evidence?.[0] ?? '';
    expect(copied.startsWith('evidence/observed/')).toBe(true);
    expect(copied.endsWith('phone-1.png')).toBe(true);
    expect(await fs.exists(`/repo/.agent-flow/runs/${runId}/${copied}`)).toBe(true);
  });

  it('keeps two files whose names differ only in case apart', async () => {
    // Windows and macOS file systems ignore case, so `Shot.png` would overwrite `shot.png`.
    const { fs, store, deps, runId } = await setup({ e2eVerdict: 'NOT_RUN' });
    fs.seed('/a/Shot.png', 'PNG-A');
    fs.seed('/b/shot.png', 'PNG-B');

    await review(deps, runId, {
      e2eObservation: { by: 'Luis', words: 'vi nos dois aparelhos', evidence: ['/a/Shot.png', '/b/shot.png'] },
    });

    const kept = (await store.loadRun(runId)).amendments?.find((a) => a.kind === 'e2e_observation')?.evidence ?? [];
    const names = kept.map((path) => path.split('/').at(-1)?.toLowerCase());
    expect(new Set(names).size).toBe(2);
  });

  it('refuses a file that is not an image, is not there, or is not a local absolute path', async () => {
    // A network path makes the hub reach for a share (and, on Windows, offer its credentials);
    // a relative one resolves against wherever the hub happens to run (adversarial review).
    for (const evidence of [['/shots/notes.txt'], ['/shots/missing.png'], ['\\\\host\\share\\x.png'], ['//host/share/x.png'], ['shots/phone-1.png']]) {
      const { store, deps, runId } = await setup({ e2eVerdict: 'NOT_RUN' });

      const outcome = await review(deps, runId, {
        e2eObservation: { by: 'Luis', words: 'vi funcionando', evidence },
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.code).toBe('invalid_input');
        // Judged by its shape, before anything touches the path.
        if (!evidence[0]?.startsWith('/shots/')) expect(outcome.error.message).toMatch(/absolute path on this machine/);
      }
      expect((await store.loadRun(runId)).amendments ?? []).toEqual([]);
    }
  });
});
