import { test, expect } from '@playwright/test';
import { FIXTURE_RUN_ID, RUN, RUNNER_HEALTH, TASKS } from './fixtures';
import { settle, stubApi } from './harness';

/**
 * UI-30 — what the control plane says when things are missing or wrong.
 *
 * The dashboard is easy to judge on a healthy run, and a healthy run is the one
 * state it will spend the least time in. Every shot here is a state somebody
 * actually opens the tool because of.
 *
 * §95 asks each of them for four things: what happened, where, whether the
 * workflow stopped, and what to do about it. The third is the one that keeps
 * getting dropped and the one that matters most — "the review used the same
 * provider" and "the run stopped" mean entirely different things about whether
 * anybody needs to act right now.
 */

const FAILED_TASK = {
  ...TASKS[3],
  state: 'failed',
  attempts: 2,
};

const FAILED_DETAIL = {
  ...FAILED_TASK,
  description: 'Implementar o serviço de recorrências e as regras de expansão.',
  acceptanceCriteria: ['A janela respeita o limite configurado.'],
  validation: ['test'],
  validationExpectation: 'pass',
  files: ['src/recurrence/service.ts'],
  filesChanged: ['src/recurrence/service.ts'],
  notes: [],
  startedAt: '2026-08-10T20:02:00.000Z',
  finishedAt: '2026-08-10T20:10:11.000Z',
  reasoningClamped: false,
  commands: [
    {
      command: 'npm test -- recurrence',
      exitCode: 1,
      durationMs: 22_800,
      stdout: '17 passing, 1 failing\n  1) expands past the occurrence limit',
      stderr: '',
    },
  ],
  log: [
    '[20:02:00] Task started',
    '[20:09:40] Running tests...',
    '[20:10:11] 1 failing',
  ],
};

test.describe('a failed task', () => {
  test('says what failed, where, that the run stopped, and what to do', async ({ page }) => {
    await stubApi(page, {
      [`/api/v1/runs/${FIXTURE_RUN_ID}`]: { ...RUN, status: 'failed', progress: 33 },
      [`/api/v1/runs/${FIXTURE_RUN_ID}/tasks`]: TASKS.map((task) =>
        task.id === 'TASK-004' ? FAILED_TASK : task,
      ),
      [`/api/v1/runs/${FIXTURE_RUN_ID}/tasks/TASK-004`]: FAILED_DETAIL,
    });

    await page.goto('/dashboard');
    await settle(page);

    const row = page.getByText('Recurrence Service');
    await row.scrollIntoViewIfNeeded();
    await row.click();

    await expect(page.getByText('TASK-004 failed validation.')).toBeVisible();
    await expect(page.getByText(/The run stopped here/)).toBeVisible();
    await expect(page.getByText('npm test -- recurrence')).toBeVisible();

    await expect(page).toHaveScreenshot('failed-task.png', { fullPage: false });
  });
});

test.describe('a plan waiting for review', () => {
  test('opens the gate from the card that says it is waiting', async ({ page }) => {
    await stubApi(page, {
      [`/api/v1/runs/${FIXTURE_RUN_ID}`]: {
        ...RUN,
        status: 'waiting_for_approval',
        approved: false,
        progress: 0,
        completedTasks: 0,
      },
    });

    await page.goto('/dashboard');
    await settle(page);

    // Scoped: the run header, the pipeline and the task rows all say WAITING.
    const card = page.locator('section').filter({ hasText: 'Plan approval' });
    await expect(card.getByText('WAITING')).toBeVisible();
    await expect(page).toHaveScreenshot('waiting-approval.png', { fullPage: false });

    // §94 asks for this state to be operational, not to point at another control.
    await page.getByRole('button', { name: 'Review the plan' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
});

test.describe('a runner that is not there', () => {
  test('names it, links to the routing, and promises no fallback', async ({ page }) => {
    // §94's example reads "Workflow can continue using Claude fallback", and that
    // is a claim the sidebar cannot make: a fallback is configured per role, must
    // satisfy that role's requirements, and may be off entirely.
    await stubApi(page, {
      '/api/v1/runners/health': [
        { ...RUNNER_HEALTH[0], installed: false, executable: false, auth: 'not_configured' },
        RUNNER_HEALTH[1],
      ],
    });

    await page.goto('/dashboard');
    await settle(page);

    const warning = page.getByRole('link', { name: /1 runner unavailable/ });
    await expect(warning).toBeVisible();
    await expect(page.locator('aside').getByText(/fallback/i)).toHaveCount(0);

    await expect(page).toHaveScreenshot('runner-unavailable.png', { fullPage: false });
  });
});

test.describe('a workspace with nothing in it', () => {
  test('says no project was found, on every surface that lists them', async ({ page }) => {
    await stubApi(page, { '/api/v1/projects': [], '/api/v1/runs': [] });

    await page.goto('/projects');
    // The sidebar has a Projects heading of its own, and so does the page.
    await expect(page.getByRole('heading', { name: 'Projects', level: 2 }).last()).toBeVisible();
    await expect(page.getByText('No Agent Flow project found.')).toHaveCount(2);

    await expect(page).toHaveScreenshot('no-projects.png', { fullPage: false });
  });

  test('says a project id is unknown once, rather than once per query', async ({ page }) => {
    await stubApi(page);

    await page.goto('/dashboard?project=gone');

    await expect(page.getByText('This server has no project called gone.')).toBeVisible();
    await expect(page).toHaveScreenshot('unknown-project.png', { fullPage: false });

    await page.getByRole('button', { name: 'Show the whole workspace' }).click();
    await expect(page.getByText('This server has no project called gone.')).toHaveCount(0);
  });
});

test.describe('a server that stopped answering', () => {
  test('says the run could not be read, and that the run itself is fine', async ({ page }) => {
    await stubApi(page);
    // Everything about the run fails from here on: the shape of a server that
    // went away, rather than of a run that failed.
    await page.route(`**/api/v1/runs/${FIXTURE_RUN_ID}`, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'internal', message: 'the reader threw' }),
      });
    });

    await page.goto(`/runs/${FIXTURE_RUN_ID}`);

    await expect(page.getByText(`${FIXTURE_RUN_ID} could not be read.`)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/this is the dashboard failing to read it/)).toBeVisible();

    await expect(page).toHaveScreenshot('run-unreadable.png', { fullPage: false });
  });
});
