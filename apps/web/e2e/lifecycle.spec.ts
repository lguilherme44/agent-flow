import { expect, test } from './support/harness';

/**
 * E2E — pause, resume and cancel, through the real CLI against a real repository.
 *
 * `test/app/run-lifecycle.test.ts` proves the semantics against an in-memory filesystem.
 * This proves the three things that harness cannot: the commands exist on the built
 * binary, the intent survives on disk between two separate invocations of it, and a run
 * paused in one process is refused in another.
 *
 * That last one is the whole feature. An operator types `pause` in a second terminal while
 * the first is running — so a pause the CLI only honoured inside the process that set it
 * would be no pause at all.
 */

test.describe('lifecycle', () => {
  test('a pause survives the process that set it, and run refuses until resume', async ({
    makeWorld,
  }) => {
    const world = await makeWorld();
    await world.cli('booking-api', ['approve']);

    // One process asks.
    const paused = await world.cli('booking-api', ['pause']);
    expect(paused.code, `pause failed: ${paused.stderr}`).toBe(0);
    expect(paused.stdout).toMatch(/paused/i);

    // Another reads it off disk and refuses. `agent-flow run` typed after a pause must
    // meet the request rather than quietly overriding it.
    const refused = await world.cli('booking-api', ['run']);
    expect(refused.code, 'run ignored the pause').not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toMatch(/resume/i);

    // And it says so rather than "nothing to run", which is true of the projection and
    // useless to somebody holding the one command that fixes it.
    expect(`${refused.stdout}${refused.stderr}`).not.toMatch(/nothing to run/i);

    // Nothing was interrupted: pause starts nothing, it stops nothing.
    const state = (await world.stateOf('booking-api')) as {
      tasks: { state: string }[];
      pauseRequestedAt?: string;
    };
    expect(state.pauseRequestedAt).toBeDefined();
    expect(state.tasks.every((task) => task.state !== 'interrupted')).toBe(true);

    // Resume clears it and runs the plan through the same gates `run` uses.
    const resumed = await world.cli('booking-api', ['resume']);
    expect(resumed.code, `resume failed: ${resumed.stderr}`).toBe(0);

    const after = (await world.stateOf('booking-api')) as { pauseRequestedAt?: string };
    expect(after.pauseRequestedAt).toBeUndefined();
  });

  test('pausing twice keeps the first answer to "when did somebody ask"', async ({
    makeWorld,
  }) => {
    const world = await makeWorld();
    await world.cli('booking-api', ['approve']);

    await world.cli('booking-api', ['pause']);
    const first = ((await world.stateOf('booking-api')) as { pauseRequestedAt?: string })
      .pauseRequestedAt;

    const again = await world.cli('booking-api', ['pause']);
    expect(again.code).toBe(0);

    const second = ((await world.stateOf('booking-api')) as { pauseRequestedAt?: string })
      .pauseRequestedAt;
    expect(second).toBe(first);
  });

  test('resume refuses a run nobody paused', async ({ makeWorld }) => {
    // `resume` and `run` are not aliases. A command that silently did the other's job
    // would make "did my pause take effect" unanswerable.
    const world = await makeWorld();
    await world.cli('booking-api', ['approve']);

    const outcome = await world.cli('booking-api', ['resume']);

    expect(outcome.code).not.toBe(0);
    expect(`${outcome.stdout}${outcome.stderr}`).toMatch(/not paused/i);
  });

  test('cancel asks before it does something irreversible', async ({ makeWorld }) => {
    const world = await makeWorld();
    await world.cli('booking-api', ['approve']);

    const asked = await world.cli('booking-api', ['cancel']);

    expect(asked.code, 'cancel went ahead without confirmation').not.toBe(0);
    expect(`${asked.stdout}${asked.stderr}`).toMatch(/--yes/);

    // And it changed nothing.
    expect(((await world.stateOf('booking-api')) as { status: string }).status).not.toBe(
      'cancelled',
    );
  });

  test('cancel is terminal, keeps every artifact, and says so', async ({ makeWorld }) => {
    const world = await makeWorld();
    await world.cli('booking-api', ['approve']);

    const runId = await world.runIdOf('booking-api');
    const planBefore = await world.readProjectFile(
      'booking-api',
      `.agent-flow/runs/${runId}/plan.json`,
    );
    expect(planBefore, 'the fixture has no plan to keep').not.toBe('');

    const cancelled = await world.cli('booking-api', ['cancel', '--yes']);
    expect(cancelled.code, `cancel failed: ${cancelled.stderr}`).toBe(0);
    // An operator who is not told what survived will assume the opposite and redo work
    // that is still on disk.
    expect(cancelled.stdout).toMatch(/nothing was deleted/i);

    expect(((await world.stateOf('booking-api')) as { status: string }).status).toBe('cancelled');

    // Byte-for-byte. Cancel retains evidence; it does not erase it.
    expect(
      await world.readProjectFile('booking-api', `.agent-flow/runs/${runId}/plan.json`),
    ).toBe(planBefore);

    // Terminal in both directions: neither `run` nor `resume` reopens it.
    for (const command of ['run', 'resume']) {
      const refused = await world.cli('booking-api', [command]);
      expect(refused.code, `${command} reopened a cancelled run`).not.toBe(0);
      expect(`${refused.stdout}${refused.stderr}`, command).toMatch(/cancel/i);
    }
  });

  test('cancel is idempotent', async ({ makeWorld }) => {
    const world = await makeWorld();
    await world.cli('booking-api', ['approve']);

    await world.cli('booking-api', ['cancel', '--yes']);
    const at = ((await world.stateOf('booking-api')) as { cancelledAt?: string }).cancelledAt;

    const again = await world.cli('booking-api', ['cancel', '--yes']);
    expect(again.code).toBe(0);

    expect(((await world.stateOf('booking-api')) as { cancelledAt?: string }).cancelledAt).toBe(at);
  });
});
