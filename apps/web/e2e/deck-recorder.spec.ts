import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect, recordConsole, test } from './support/harness.js';
import { REPO_ROOT, type World } from './support/world.js';

const project = 'booking-api';
const OUT = join(REPO_ROOT, 'apps/web/e2e/.results');

/**
 * The recorder, read off a run the product itself produced.
 *
 * `Recorder.test.tsx` proves the drawing against a log a test wrote. This proves the
 * things that harness cannot: that the event names the real coordinator writes land on
 * the marks the legend knows how to name — a kind the fold has never seen falls to
 * `other`, and a legend full of "outro evento" is the failure to look for — that the
 * titles the plan carries reach the lanes, and that a run with agents genuinely parked
 * draws as *live*. Every screenshot is attached, because the question the recorder answers
 * is a visual one and an assertion on the DOM cannot see a bar under a mark.
 */

// The reader's language and the width the panel was designed against.
test.use({ locale: 'pt-BR', viewport: { width: 1900, height: 1000 } });

async function openRun(page: Page, world: World): Promise<{ runId: string; recorder: Locator }> {
  const runId = await world.runIdOf(project);
  await page.goto(`${world.url}/p/${project}/runs/${runId}`);
  await expect(page.getByRole('heading', { name: runId })).toBeVisible();
  const recorder = page.locator('.recorder');
  await expect(recorder.locator('.recorder__legend')).toBeVisible();
  return { runId, recorder };
}

/** The whole page for context and the recorder alone for reading, both attached. */
async function snap(page: Page, recorder: Locator, testInfo: TestInfo, name: string): Promise<void> {
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  const strip = await recorder.screenshot({ path: join(OUT, `${name}-recorder.png`) });
  await testInfo.attach(name, { body: strip, contentType: 'image/png' });
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((done) => {
    if (child.exitCode !== null) return done();
    child.once('exit', () => done());
  });
}

test.describe('Deck recorder, on a real run', () => {
  test('a parallel run: live with agents parked, then recorded', async ({ page, makeWorld }, testInfo) => {
    test.setTimeout(240_000);
    const world = await makeWorld({ dashboard: 'deck', worktrees: true, wavePlan: true, maxTasks: 2, hold: true });
    const problems = recordConsole(page);
    await world.cli(project, ['approve']);

    // The coordinator is held by the test, not awaited: the agents park, so `run` will
    // not return until they are released.
    const coordinator = world.spawnCli(project, ['run']);
    await expect.poll(() => world.parked(), { timeout: 90_000 }).not.toEqual([]);
    // Let the running bars grow to something a person can see beside the seconds of planning.
    await page.waitForTimeout(8_000);

    const { recorder } = await openRun(page, world);
    await expect(recorder.getByText('AO VIVO').first()).toBeVisible();
    // Two agents parked means two lanes with a bar still open at the playhead.
    await expect(recorder.locator('.svg-attempt[data-outcome="running"]')).toHaveCount(2);
    await snap(page, recorder, testInfo, 'recorder-live');

    await world.release();
    await exited(coordinator);
    await page.reload();
    await expect(page.getByRole('heading', { name: await world.runIdOf(project) })).toBeVisible();
    await expect(recorder.locator('.svg-attempt[data-outcome="running"]')).toHaveCount(0);
    await snap(page, recorder, testInfo, 'recorder-recorded');

    // The plan's titles reach the lanes; the legend names what the coordinator wrote.
    await expect(recorder.locator('.svg-lane-title').first()).toHaveText(/Add recurrence types/);
    const legend = recorder.getByRole('list', { name: 'Legenda' });
    await expect(legend).toContainText('concluído');
    // Every mark on screen has a name. A run drawn mostly as "outro evento" is a fold
    // that has fallen behind the coordinator's vocabulary.
    const kinds = await recorder.locator('.svg-mark').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-kind')));
    const unnamed = kinds.filter((kind) => kind === 'other').length;
    expect(unnamed, `marks the legend cannot name: ${String(unnamed)} of ${String(kinds.length)}`).toBeLessThanOrEqual(kinds.length / 4);
    expect(problems, 'the browser logged an error').toEqual([]);
  });

  test('a run whose agents fail: retries, recovery and exhaustion on the tape', async ({ page, makeWorld }, testInfo) => {
    test.setTimeout(240_000);
    const world = await makeWorld({ dashboard: 'deck' });
    const problems = recordConsole(page);
    await world.cli(project, ['approve']);
    // A process that fails, every time. The exit code is not the point; the tape is.
    await world.cli(project, ['run'], { AF_FAKE_IMPL: 'failed' });

    const { recorder } = await openRun(page, world);
    await snap(page, recorder, testInfo, 'recorder-failed');

    const legend = recorder.getByRole('list', { name: 'Legenda' });
    await expect(legend).toContainText('falhou');
    await expect(recorder.locator('.svg-attempt[data-outcome="failed"]').first()).toBeVisible();
    expect(problems, 'the browser logged an error').toEqual([]);
  });
});
