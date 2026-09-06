import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, recordConsole, test } from './support/harness.js';
import { REPO_ROOT } from './support/world.js';

const project = 'booking-api';

async function openCrew(page: import('@playwright/test').Page, url: string): Promise<void> {
  await page.goto(`${url}/crew?project=${project}`);
  await expect(page.getByRole('heading', { name: 'Configure the active crew' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'global source' })).toBeVisible();
}

async function waitForPreview(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('.crew-actions')).toContainText(/unsaved change/);
  await expect(page.getByRole('button', { name: 'Save configuration' })).toBeEnabled();
}

test.describe('Deck active crew configuration', () => {
  test('declares a runner of a type the server supports, without a secret reaching the file', async ({
    page,
    makeWorld,
  }, testInfo) => {
    const world = await makeWorld({ dashboard: 'deck', plan: false });
    const problems = recordConsole(page);

    await openCrew(page, world.url);
    await expect(page.locator('body')).not.toContainText('resolved-super-secret');
    await expect(page.locator('body')).not.toContainText('unknown-secret-value');

    // The types come from the registry, so this is the same list `agent-flow` can build —
    // not a list of runner names shipped inside the browser.
    await page.getByRole('button', { name: /Add runner/ }).click();
    await page.getByLabel('id', { exact: true }).fill('local');
    await page.getByLabel('type', { exact: true }).selectOption('openai-compatible');
    await page.getByLabel('baseUrl *').fill('http://127.0.0.1:8080/v1');
    await page.getByLabel('apiKeyEnv', { exact: true }).fill('LOCAL_LLM_API_KEY');
    const png = await page.screenshot({ path: join(REPO_ROOT, 'apps/web/e2e/.results', 'deck-crew-add-runner.png') });
    await testInfo.attach('add-runner', { body: png, contentType: 'image/png' });
    await page.getByRole('button', { name: 'Add runner', exact: true }).click();

    await waitForPreview(page);
    await page.getByRole('button', { name: 'Save configuration' }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();

    const source = await readFile(world.globalConfigPath, 'utf8');
    expect(source).toContain('type: openai-compatible');
    expect(source).toContain('baseUrl: http://127.0.0.1:8080/v1');
    // The variable's name, never a key (§7.1) — and the unknown block the codec preserves.
    expect(source).toContain('apiKeyEnv: LOCAL_LLM_API_KEY');
    expect(source).toContain('unknown-secret-value');
    expect(problems, 'the browser logged an error').toEqual([]);

    // The new runner is now a card, and the roles can be pointed at it.
    await expect(page.locator('.runner-card').filter({ hasText: 'local' })).toBeVisible();
  });

  test('saves a project override and restores inheritance by removing it', async ({ page, makeWorld }) => {
    const world = await makeWorld({ dashboard: 'deck', plan: false, maxTasks: 3 });
    await openCrew(page, world.url);
    await page.getByRole('button', { name: /This project/ }).click();
    await expect(page.getByRole('heading', { name: 'project source' })).toBeVisible();

    // Machine settings live behind Advanced; inherited ones are folded away inside it.
    await page.getByRole('tab', { name: /Advanced/ }).click();
    await page.getByLabel('Show inherited').check();
    const field = page.locator('.crew-field').filter({ hasText: 'parallelism.maxTasks' });
    await field.getByRole('spinbutton').fill('2');
    await waitForPreview(page);
    await page.getByRole('button', { name: 'Save configuration' }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    expect(await world.readProjectFile(project, '.agent-flow/config.yaml')).toContain('maxTasks: 2');

    await field.getByRole('button', { name: 'Inherit' }).click();
    await waitForPreview(page);
    await page.getByRole('button', { name: 'Save configuration' }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    expect(await world.readProjectFile(project, '.agent-flow/config.yaml')).not.toContain('maxTasks:');

    await page.getByText('Dynamic configuration').click();
    await page.getByLabel('Known field').selectOption('validationCommands.*');
    await page.getByLabel('Identifier validationCommands').fill('contract');
    await page.getByLabel('Value').fill('npm run test:contract');
    await page.getByRole('button', { name: 'Add configuration field' }).click();
    await waitForPreview(page);
    await page.getByRole('button', { name: 'Save configuration' }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    expect(await world.readProjectFile(project, '.agent-flow/config.yaml')).toContain('contract: npm run test:contract');
  });

  test('offers every value in the control its declared type deserves', async ({ page, makeWorld }, testInfo) => {
    const world = await makeWorld({ dashboard: 'deck', plan: false });
    await openCrew(page, world.url);
    // Folded away by default: the count says how many of the machine settings are set.
    await page.getByRole('tab', { name: /Advanced/ }).click();
    await expect(page.getByText(/of \d+ fields are set in this source/)).toBeVisible();
    await page.getByLabel('Show inherited').check();
    await page.getByRole('heading', { name: 'Git', exact: true }).click();

    // A boolean is a switch and a closed field is its own values: neither is a text box
    // a person can spell wrong, which is the whole point of the server sending the type.
    const worktrees = page.locator('.crew-field').filter({ hasText: 'git.useWorktrees' }).getByRole('switch');
    await expect(worktrees).toBeVisible();
    // Measured, not assumed. `run.css` styles `input[type='checkbox']` at 15px, which
    // outranks a class selector and squashed this control to a checkbox with its thumb
    // spilling over the label — visible to a person, invisible to every other assertion
    // here. The number is the switch's own width, not a checkbox's.
    expect((await worktrees.boundingBox())?.width).toBeGreaterThan(24);
    // Effort lives in the role table now, one row per post.
    await page.getByRole('tab', { name: 'Crew' }).click();
    const effort = page.getByLabel('roles.planner.effort');
    await expect(effort).toBeVisible();
    await effort.selectOption('very_high');

    await waitForPreview(page);
    await page.getByRole('button', { name: 'Save configuration' }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    expect(await readFile(world.globalConfigPath, 'utf8')).toContain('effort: very_high');

    // Evidence a person can read: the controls as they render, not as they measure.
    for (const [name, target] of [['select', effort]] as const) {
      await target.scrollIntoViewIfNeeded();
      const png = await page.screenshot({ path: join(REPO_ROOT, 'apps/web/e2e/.results', `deck-crew-typed-${name}.png`) });
      await testInfo.attach(`typed-${name}`, { body: png, contentType: 'image/png' });
    }
  });

  test('offers the models the runner reports, and still takes one it has never heard of', async ({ page, makeWorld }, testInfo) => {
    const world = await makeWorld({ dashboard: 'deck', plan: false });
    await openCrew(page, world.url);

    // `architect` routes to `claude`, so the ids offered are the ones that runner reports.
    const model = page.getByLabel('roles.architect.model');
    const listId = await model.getAttribute('list');
    expect(listId, 'the model field offers no suggestions').not.toBeNull();
    // Attribute selector, not `#id`: the id is `route-roles.architect.model-suggestions`
    // and CSS would read every dot in it as a class.
    expect(await page.locator(`datalist[id="${String(listId)}"] option`).evaluateAll((options) =>
      options.map((option) => option.getAttribute('value')))).toEqual(['opus', 'sonnet', 'haiku']);

    const png = await page.screenshot({ path: join(REPO_ROOT, 'apps/web/e2e/.results', 'deck-crew-models.png') });
    await testInfo.attach('models', { body: png, contentType: 'image/png' });

    // A suggestion, never a constraint (AD-13): a model released this morning still saves.
    await model.fill('a-model-released-this-morning');
    await waitForPreview(page);
    await page.getByRole('button', { name: 'Save configuration' }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    expect(await readFile(world.globalConfigPath, 'utf8')).toContain('model: a-model-released-this-morning');
  });

  test('routes a role from its own row and re-resolves it after saving', async ({ page, makeWorld }, testInfo) => {
    const world = await makeWorld({ dashboard: 'deck', plan: false });
    await openCrew(page, world.url);

    const row = page.locator('.crew-roles__table tbody tr').filter({ hasText: 'executor.normal' });
    await expect(row.getByText('writes')).toBeVisible();
    await expect(row.locator('.crew-roles__resolved')).toContainText('codex');

    // The runner column offers the runners this source declares, not free text.
    const runner = row.getByLabel('roles.executors.normal.runner');
    expect(await runner.locator('option').allInnerTexts()).toEqual(expect.arrayContaining(['claude', 'codex']));
    await runner.selectOption('claude');
    await expect(row.locator('.crew-roles__pending')).toBeVisible();

    await waitForPreview(page);
    const png = await page.screenshot({ path: join(REPO_ROOT, 'apps/web/e2e/.results', 'deck-crew-role-routing.png') });
    await testInfo.attach('role-routing', { body: png, contentType: 'image/png' });

    await page.getByRole('button', { name: 'Save configuration' }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    // The codec keeps the source's own style, so `normal:` stays the flow map it was.
    expect(await readFile(world.globalConfigPath, 'utf8')).toMatch(/normal:\s*\{[^}]*runner: claude/);

    // The resolved column is the server's, so it changes only once the file has.
    await expect(row.locator('.crew-roles__resolved')).toContainText('claude');
    await expect(row.locator('.crew-roles__pending')).toHaveCount(0);
  });

  test('shows the diff it is about to write, and the CLI line that does the same', async ({ page, makeWorld }, testInfo) => {
    const world = await makeWorld({ dashboard: 'deck', plan: false });
    await openCrew(page, world.url);

    await page.locator('.crew-roles__table tbody tr').filter({ hasText: 'planner' })
      .getByLabel('roles.planner.effort').selectOption('low');
    await waitForPreview(page);

    const bar = page.locator('.crew-actions');
    await expect(bar).toContainText('1 unsaved change');
    await expect(bar.getByText(/takes effect/)).toBeVisible();
    await bar.getByRole('button', { name: 'Show diff' }).click();

    const diff = page.locator('.crew-diff');
    await expect(diff.locator('.crew-diff__del')).toHaveText('- roles.planner.effort: high');
    await expect(diff.locator('.crew-diff__add')).toHaveText('+ roles.planner.effort: low');
    const command = (await diff.locator('.crew-diff__cli').innerText()).replace(/^\$\s*/, '');
    expect(command).toBe('agent-flow config set roles.planner.effort low --global');

    const png = await page.screenshot({ path: join(REPO_ROOT, 'apps/web/e2e/.results', 'deck-crew-change-bar.png') });
    await testInfo.attach('change-bar', { body: png, contentType: 'image/png' });

    // The point of printing it: the command has to be the one that does this. Run it
    // against the same file and the result must match what saving here would produce.
    const ran = await world.cli(project, command.replace(/^agent-flow /, '').split(' '));
    expect(ran.code, ran.stderr).toBe(0);
    expect(await readFile(world.globalConfigPath, 'utf8')).toMatch(/planner:[\s\S]*?effort: low/);
  });

  test('blocks invalid values and refuses a stale overwrite with fresh state', async ({ page, makeWorld }) => {
    const world = await makeWorld({ dashboard: 'deck', plan: false, maxTasks: 3 });
    await openCrew(page, world.url);
    await page.getByRole('button', { name: /This project/ }).click();
    await page.getByRole('tab', { name: /Advanced/ }).click();
    await page.getByLabel('Show inherited').check();
    const field = page.locator('.crew-field').filter({ hasText: 'parallelism.maxTasks' });

    await field.getByRole('spinbutton').fill('0');
    await expect(page.getByRole('alert')).toContainText('parallelism.maxTasks');
    await expect(page.getByRole('button', { name: 'Save configuration' })).toBeDisabled();

    await field.getByRole('spinbutton').fill('2');
    await waitForPreview(page);
    const before = await world.readProjectFile(project, '.agent-flow/config.yaml');
    await world.writeFile(project, '.agent-flow/config.yaml', `${before}\n# external edit\n`);
    await page.getByRole('button', { name: 'Save configuration' }).click();

    await expect(page.getByText('Conflict.', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('fresh server state');
    await expect(page.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
    expect(await world.readProjectFile(project, '.agent-flow/config.yaml')).toBe(`${before}\n# external edit\n`);
  });

  test('fits desktop and mobile viewports and captures full-page evidence', async ({ page, makeWorld }, testInfo) => {
    const world = await makeWorld({ dashboard: 'deck', plan: false });
    for (const viewport of [
      { name: 'desktop-1280x720', width: 1280, height: 720 },
      { name: 'mobile-375x667', width: 375, height: 667 },
    ] as const) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openCrew(page, world.url);
      expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({
        width: viewport.width,
        height: viewport.height,
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const path = join(REPO_ROOT, 'apps/web/e2e/.results', `deck-crew-${viewport.name}.png`);
      const png = await page.screenshot({ fullPage: true, path });
      await testInfo.attach(viewport.name, { body: png, contentType: 'image/png' });
    }
  });
});
