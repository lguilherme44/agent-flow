import { test, expect, type Page } from '@playwright/test';
import { DAG, FIXTURE_RUN_ID, TASKS } from './fixtures';
import { settle, stubApi } from './harness';

/**
 * The dependency graph, in a browser (UI-28).
 *
 * This is where the graph is actually tested. jsdom has no layout, so a unit test
 * can prove a node exists and nothing about whether the picture is readable —
 * which is the only property a graph has. The maths is covered in
 * `lib/dag-layout.test.ts`; everything here needs a real viewport.
 */

async function openGraph(
  page: Page,
  overrides: Record<string, unknown> = {},
  options: { settled?: boolean } = {},
): Promise<void> {
  await stubApi(page, overrides);
  await page.goto('/dashboard');
  // The shared settle waits on the reference run's first row. A spec that
  // replaces the task list has no such row, and waiting for one would fail for a
  // reason that has nothing to do with the graph.
  if (options.settled ?? true) await settle(page);
  else await expect(page.getByRole('heading', { level: 1 })).toHaveText(FIXTURE_RUN_ID);

  await page.getByRole('button', { name: 'View as DAG' }).click();
  await expect(page.getByText('Task dependencies')).toBeVisible();
  // React Flow measures the pane and fits the view on the next frame.
  await page.waitForTimeout(400);
}

/** The status filter, scoped: a node's accessible name mentions its status too. */
function statusFilter(page: Page, status: string) {
  return page.getByRole('group', { name: 'Filter by status' }).getByRole('button', { name: status });
}

test.describe('the dependency graph', () => {
  test('the fixture describes the same graph the tasks do', () => {
    // A fixture that drifted from the task list would draw a plan that does not
    // exist, and every screenshot below would agree with it.
    const fromTasks = TASKS.flatMap((task) =>
      task.dependencies.map((dependency) => `${dependency}->${task.id}`),
    ).sort();
    const fromDag = DAG.edges.map((edge) => `${edge.from}->${edge.to}`).sort();

    expect(fromDag).toEqual(fromTasks);
    expect(DAG.nodes.map((node) => node.taskId).sort()).toEqual(
      TASKS.map((task) => task.id).sort(),
    );
  });

  test('draws the whole plan, with the run panel still above it', async ({ page }) => {
    await openGraph(page);

    // Every task is a node. A graph that quietly dropped one is a graph that
    // says a task does not exist.
    await expect(page.locator('.react-flow__node')).toHaveCount(TASKS.length);
    await expect(page.locator('.react-flow__edge')).toHaveCount(DAG.edges.length);

    // The run is still identified. Losing the header would make the graph read
    // as a different page rather than as another view of this run.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(FIXTURE_RUN_ID);

    // The opening view has a legibility floor; the reader does not. At 1024 the
    // fit is clamped and the graph opens clipped on both sides — which is the
    // right trade — but somebody who wants the shape must still be able to ask.
    await expect(page.getByRole('button', { name: 'zoom out' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'fit view' })).toBeEnabled();

    await expect(page).toHaveScreenshot('dag.png', { fullPage: false });
  });

  test('never scrolls the page, whatever the graph is doing', async ({ page }) => {
    // The failure a canvas makes easy: a 1600px-wide graph pushing the layout
    // instead of panning inside its own pane.
    await openGraph(page);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    }));

    expect(overflow.scrollWidth).toBe(overflow.clientWidth);
    expect(overflow.scrollHeight).toBe(overflow.clientHeight);
  });

  test('every edge points forwards', async ({ page }) => {
    // The property the column ranking exists for. An edge drawn right-to-left
    // reads as a dependency in the opposite direction, which is the one mistake
    // a dependency graph must not make.
    await openGraph(page);

    const positions = await page.evaluate(() =>
      [...document.querySelectorAll('.react-flow__node')].map((node) => ({
        id: node.getAttribute('data-id') ?? '',
        left: node.getBoundingClientRect().left,
      })),
    );

    const leftOf = new Map(positions.map((entry) => [entry.id, entry.left]));

    for (const edge of DAG.edges) {
      expect(
        leftOf.get(edge.to) ?? 0,
        `${edge.from} → ${edge.to} points backwards`,
      ).toBeGreaterThan(leftOf.get(edge.from) ?? 0);
    }
  });

  test('selecting a node opens it in the inspector and lights its path', async ({ page }) => {
    await openGraph(page);

    await page.locator('[data-id="TASK-003"]').click();

    // One selection: the graph, the inspector and the table all mean TASK-003.
    // The description is the inspector's own — the node shows only a title.
    await expect(
      page.getByText('Implementar repositório para recorrências, com expansão por janela.'),
    ).toBeVisible();

    // Its ancestors and descendants stay lit; the rest falls back.
    const dimmed = await page.evaluate(() =>
      [...document.querySelectorAll('.react-flow__node')]
        .filter((node) =>
          (node.firstElementChild as HTMLElement | null)?.className.includes('opacity-30'),
        )
        .map((node) => node.getAttribute('data-id') ?? ''),
    );

    // FIX-001 is the second root and is connected to nothing. Everything on the
    // chain, in both directions, stays lit.
    expect(dimmed).toEqual(['FIX-001']);

    await expect(page).toHaveScreenshot('dag-selected.png', { fullPage: false });
  });

  test('a filter dims what it excludes rather than deleting it', async ({ page }) => {
    // Removing a node takes its edges with it, and a chain with a hole in the
    // middle describes a dependency that does not exist.
    await openGraph(page);

    await statusFilter(page, 'completed').click();
    await page.waitForTimeout(200);

    await expect(page.locator('.react-flow__node')).toHaveCount(TASKS.length);
    await expect(page.locator('.react-flow__edge')).toHaveCount(DAG.edges.length);

    await expect(page).toHaveScreenshot('dag-filtered.png', { fullPage: false });
  });

  test('says what it could not draw, and draws the rest', async ({ page }) => {
    await openGraph(page, {
      [`/api/v1/runs/${FIXTURE_RUN_ID}/dag`]: {
        ...DAG,
        unresolved: [{ taskId: 'TASK-002', dependsOn: 'TASK-000' }],
        invalid: {
          kind: 'cycle',
          message: 'dependency cycle: TASK-006 → TASK-007 → TASK-006',
          cycle: ['TASK-006', 'TASK-007', 'TASK-006'],
        },
      },
    });

    await expect(page.getByRole('status')).toContainText('cycle');
    await expect(page.getByRole('status')).toContainText('TASK-000');
    // And the nodes are still there. A blank canvas explains nothing, and this
    // is exactly the plan somebody needs to look at.
    await expect(page.locator('.react-flow__node')).toHaveCount(TASKS.length);

    await expect(page).toHaveScreenshot('dag-invalid.png', { fullPage: false });
  });

  test('draws five hundred tasks without falling over', async ({ page }) => {
    // §96's target. Not a benchmark — a check that the view opens, fits and
    // stays usable at the size the spec names.
    const many = Array.from({ length: 500 }, (_, index) => {
      const id = `TASK-${String(index).padStart(3, '0')}`;
      return {
        id,
        title: `Task number ${String(index)}`,
        complexity: 'normal',
        risk: 'low',
        state: index < 120 ? 'completed' : index === 120 ? 'running' : 'queued',
        attempts: index <= 120 ? 1 : 0,
        requirements: ['FR-001'],
        dependencies: index < 10 ? [] : [`TASK-${String(index - 10).padStart(3, '0')}`],
        runner: 'codex',
        model: 'GPT-5.6 Terra',
        ...(index < 120 ? { durationMs: 60_000 + index * 100 } : {}),
      };
    });

    const started = Date.now();
    await openGraph(
      page,
      {
        [`/api/v1/runs/${FIXTURE_RUN_ID}/tasks`]: many,
        [`/api/v1/runs/${FIXTURE_RUN_ID}/dag`]: {
          runId: FIXTURE_RUN_ID,
          projectId: 'beahub-api',
          nodes: many.map((task, index) => ({ taskId: task.id, depth: Math.floor(index / 10) })),
          edges: many.flatMap((task) =>
            task.dependencies.map((dependency) => ({ from: dependency, to: task.id })),
          ),
          unresolved: [],
        },
      },
      { settled: false },
    );

    // Off-screen nodes are not in the document at this size, which is the whole
    // point of the threshold — so the assertion is that *some* were drawn and
    // that the pane is alive, not that all five hundred exist as DOM nodes.
    expect(await page.locator('.react-flow__node').count()).toBeGreaterThan(0);
    await expect(page.getByText('Task dependencies')).toBeVisible();
    expect(Date.now() - started).toBeLessThan(20_000);

    // And it still responds. At this size the view opens fitted — which is to
    // say unreadably small — and zooming in is how anybody actually uses it, so
    // that is the control that has to work rather than the one that looks nice.
    await page.getByRole('button', { name: 'zoom in' }).click();
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
    // Fitting was not clamped: the control that undoes the zoom is available.
    await expect(page.getByRole('button', { name: 'zoom out' })).toBeEnabled();
  });
});
