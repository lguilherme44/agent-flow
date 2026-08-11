import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildHarness, heldIntervals, overlaps, type Harness } from './lock-race-harness.js';

/**
 * AF-L01 — the same race, many times over.
 *
 * A lock race is not a test that passes; it is a test that passes *often enough*. The
 * design this one replaced failed two runs in five, which means a single green run of
 * the race suite would have cleared it. Volume is the only thing that separates "no
 * overlap" from "no overlap today", so this file runs the fresh race and the stale
 * race forty rounds each — 640 processes — and asserts zero overlapping holds across
 * all of them.
 *
 * Opt-in, because 640 spawns is minutes rather than seconds and no ordinary `npm test`
 * should pay for it:
 *
 *     AF_LOCK_STRESS=1 npx vitest run test/app/run-execution-lock.stress.test.ts
 *
 * Run it when the lock changes. The race suite is what runs every time.
 */

const ENABLED = process.env.AF_LOCK_STRESS === '1';
const ROUNDS = 40;
const PROCESSES = 8;

let harness: Harness;

beforeAll(async () => {
  if (!ENABLED) return;
  harness = await buildHarness(join(import.meta.dirname, '../..'));
}, 120_000);

afterAll(async () => {
  if (!ENABLED) return;
  await rm(harness.dir, { recursive: true, force: true });
});

/** One round: N processes at one run, returning every overlap they produced. */
async function round(options: { stale: boolean }): Promise<{
  holders: number;
  overlaps: string[];
}> {
  const projectDir = harness.project();

  if (options.stale) {
    // A holder that exits without releasing, so every one of the N below judges the
    // claim stale and races to supersede it. This is the harder of the two races and
    // the one the previous design lost.
    await harness.attempt(projectDir, 0, 'abandon');
  }

  const results = await Promise.all(
    Array.from({ length: PROCESSES }, () => harness.attempt(projectDir, 60)),
  );

  const held = heldIntervals(results);
  return { holders: held.length, overlaps: overlaps(held) };
}

describe.skipIf(!ENABLED)('the race, forty times', () => {
  it('never lets two processes into a fresh run', async () => {
    const found: string[] = [];
    let holders = 0;

    for (let index = 0; index < ROUNDS; index += 1) {
      const result = await round({ stale: false });
      holders += result.holders;
      found.push(...result.overlaps);
    }

    expect(found).toEqual([]);
    // Exactly one holder per round, every round: with a live holder the refusal is
    // immediate, so nobody gets a legitimate second acquisition here.
    expect(holders).toBe(ROUNDS);
  }, 600_000);

  it('never lets two processes into a run whose holder died', async () => {
    const found: string[] = [];

    for (let index = 0; index < ROUNDS; index += 1) {
      const result = await round({ stale: true });
      // At least one gets in — a dead holder must not block the run forever — and a
      // refused claimant retrying after the winner released is legitimate, so the count
      // is not the assertion. Overlap is.
      expect(result.holders).toBeGreaterThanOrEqual(1);
      found.push(...result.overlaps);
    }

    expect(found).toEqual([]);
  }, 600_000);
});
