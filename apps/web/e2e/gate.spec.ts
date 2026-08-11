import { expect, openDashboard, recordRequests, test } from './support/harness';

/**
 * E2E-02 and E2E-03 — the human gate, opened and closed for real.
 *
 * The load-bearing assertion is a *negative* one about the network: the approve
 * request carries no plan hash. The gate is a statement about one specific plan,
 * so the identity of that plan has to be established by the side that grants the
 * approval. A client that could name the hash could approve a plan nobody read,
 * and no amount of server-side checking afterwards would notice.
 */
test.describe('approval', () => {
  test('approves the plan on disk, and never names it in the request', async ({
    page,
    makeWorld,
  }) => {
    const world = await makeWorld();
    const requests = recordRequests(page);

    const runId = await openDashboard(page, world);

    // The gate as the server computes it, right now — hash included, so a reader
    // can see what they are about to approve.
    await page.getByRole('button', { name: 'Review & approve' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Plan review: PASS')).toBeVisible();

    const before = await world.stateOf('booking-api');
    expect(before['approved']).toBe(false);

    await dialog.getByRole('button', { name: 'Approve Plan' }).click();
    await expect(dialog).toHaveCount(0);

    // The StateStore is what changed, and the screen followed it rather than the
    // other way round: the run offers execution because it is approved on disk.
    await expect(page.getByRole('button', { name: 'Start run' })).toBeVisible();

    const after = await world.stateOf('booking-api');
    expect(after['approved']).toBe(true);
    expect(after['approvedPlanHash']).toEqual(expect.any(String));
    expect(after['approvedAt']).toEqual(expect.any(String));

    const approve = requests.all.find(
      (entry) =>
        entry.method === 'POST' && new URL(entry.url).pathname.endsWith(`/${runId}/approve`),
    );

    expect(approve, 'the browser never asked the server to approve').toBeDefined();
    expect(approve?.body ?? '', 'a client-supplied plan hash reached the write API').not.toMatch(
      /planHash/i,
    );
    // And no hash-shaped value smuggled in under another name.
    expect(approve?.body ?? '').not.toMatch(/[0-9a-f]{32,}/);
  });

  test('does not offer the gate again once it is open', async ({ page, makeWorld }) => {
    const world = await makeWorld();
    await world.cli('booking-api', ['approve']);

    await openDashboard(page, world);

    await expect(page.getByRole('button', { name: 'Review & approve' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start run' })).toBeVisible();
  });
});

test.describe('rejection', () => {
  test('closes the run, and execution is no longer on offer', async ({ page, makeWorld }) => {
    const world = await makeWorld();

    const runId = await openDashboard(page, world);

    await page.getByRole('button', { name: 'Reject' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill('The SDD misread the requirement.');
    await dialog.getByRole('button', { name: 'Reject run' }).click();
    await expect(dialog).toHaveCount(0);

    // The status came back from the run, through the stream.
    await expect(page.getByText('PLAN REJECTED').first()).toBeVisible();

    const state = await world.stateOf('booking-api');
    expect(state['status']).toBe('plan_rejected');

    // A rejected run is terminal: neither the gate nor Start is offered, because
    // the only outcome either could have is a refusal.
    await expect(page.getByRole('button', { name: 'Start run' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Review & approve' })).toHaveCount(0);

    // And the refusal is real, not merely hidden: the same use case says no to the
    // CLI, which is the other adapter over it.
    const started = await world.cli('booking-api', ['run']);
    expect(started.code).not.toBe(0);
    expect(`${started.stdout}${started.stderr}`).toMatch(/rejected/i);

    // The audit trail records who closed it.
    const events = await world.cli('booking-api', ['status']);
    expect(events.stdout).toContain(runId);
  });
});
