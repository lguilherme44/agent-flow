#!/usr/bin/env node
/**
 * Run one lane of the repository's gate contract, and say what it did not run.
 *
 * The second half is the point. `npm run check` used to exit 0 having run six of the
 * eleven things that block a delivery, and nothing on screen distinguished that from
 * having run all eleven — which is how `test:packaging` stayed red for a milestone. So
 * every invocation here ends by naming the required lanes it did not touch and the
 * required evidence only GitHub can produce. A green line and a list of what was skipped
 * cannot be misread as a finished contract.
 *
 * Usage:
 *   node scripts/gate.mjs <lane> [--ci] [--release]
 *   node scripts/gate.mjs verify [--release]
 *   node scripts/gate.mjs --describe
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GATES,
  LANES,
  gatesInLane,
  laneById,
  requiredLocalLanes,
  requiredReleaseLanes,
  verifyOrder,
} from './gates.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const colour = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;
const paint = (code, text) => (colour ? `${code}${text}${RESET}` : text);

const out = (line = '') => process.stdout.write(`${line}\n`);

/**
 * Gates already executed in this process, by id.
 *
 * `build` is a gate of the `node` lane and a prerequisite of `test:packaging`. Inside one
 * `verify` it is the same checkout and the same command, so running it twice buys nothing;
 * in CI the two lanes are separate jobs and each builds for itself, which is correct there
 * and is not this process's decision to make.
 */
const executed = new Map();

function runGate(gate, options) {
  const cached = executed.get(gate.id);
  if (cached !== undefined) return { ...cached, cached: true };

  for (const id of gate.needs ?? []) {
    const prerequisite = GATES.find((candidate) => candidate.id === id);
    if (prerequisite === undefined) {
      throw new Error(`gate ${gate.id} needs ${id}, which this manifest does not declare`);
    }
    const result = runGate(prerequisite, options);
    if (result.ok !== true) return result;
  }

  const env = { ...process.env, ...(options.ci === true ? (gate.ciEnv ?? {}) : {}) };
  const started = Date.now();
  const child = spawnSync(gate.command, {
    cwd: REPO,
    env,
    shell: true,
    stdio: 'inherit',
  });

  const result = {
    ok: child.status === 0,
    status: child.status ?? 1,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  executed.set(gate.id, result);
  return result;
}

/** Whether this invocation is meant to execute a gate at all. */
function selected(gate, options) {
  if (gate.command === undefined) return false;
  if (gate.recurrence === 'per-release') return options.release === true;
  return true;
}

function runLane(laneId, options) {
  const lane = laneById(laneId);
  if (lane === undefined) throw new Error(`no such lane: ${laneId}`);

  out();
  out(`${paint(BOLD, `── ${lane.id}`)}  ${paint(DIM, lane.summary)}`);

  const failures = [];
  const unobservable = [];

  for (const gate of gatesInLane(laneId)) {
    if (!selected(gate, options)) {
      if (gate.action !== undefined) unobservable.push(gate);
      else if (gate.recurrence === 'per-release') {
        out(`   ${paint(DIM, `· ${gate.id.padEnd(24)}${gate.policy}, not run (add --release)`)}`);
      }
      continue;
    }

    out(`   ${paint(DIM, `▸ ${gate.id}`)}`);
    const result = runGate(gate, options);

    if (result.cached === true) {
      out(`   ${paint(DIM, `· ${gate.id.padEnd(24)}already run in this invocation`)}`);
      continue;
    }

    if (result.ok === true) {
      out(`   ${paint(GREEN, '✓')} ${gate.id.padEnd(24)}${paint(DIM, `${gate.policy} · ${result.seconds}s`)}`);
      continue;
    }

    // A report-only gate that fails has still told the truth. It is printed as loudly as
    // a failure and does not change the exit code, because that is what "reported, not
    // blocking" has to mean to stay honest.
    if (gate.policy === 'report-only') {
      out(`   ${paint(YELLOW, '!')} ${gate.id.padEnd(24)}${paint(YELLOW, 'reported, does not block')}`);
      continue;
    }

    out(`   ${paint(RED, '✗')} ${gate.id.padEnd(24)}${paint(RED, `${gate.policy} · exit ${result.status}`)}`);
    failures.push(gate);
  }

  for (const gate of unobservable) {
    out(`   ${paint(YELLOW, '?')} ${gate.id.padEnd(24)}${paint(YELLOW, `${gate.policy} — ${gate.action}, observable only on GitHub`)}`);
  }

  return { failures, unobservable };
}

/**
 * What this invocation did not answer.
 *
 * Printed on success as well as on failure. A person who ran one lane has not run the
 * contract, and the only moment that fact is useful is the moment they are deciding
 * whether they are finished.
 */
function reportGaps(ranLanes, options) {
  const missingLanes = requiredLocalLanes().filter((lane) => !ranLanes.includes(lane.id));
  const releaseLanes =
    options.release === true
      ? []
      : requiredReleaseLanes().filter((lane) => gatesInLane(lane.id).some((gate) => gate.policy === 'required-release'));
  const ciOnly = GATES.filter((gate) => gate.policy === 'required-ci');

  out();
  if (missingLanes.length > 0) {
    out(
      `${paint(YELLOW, 'not run')}  ${missingLanes.map((lane) => lane.id).join(', ')}  ${paint(DIM, '— `npm run verify` runs every locally required lane')}`,
    );
  }
  if (releaseLanes.length > 0) {
    out(
      `${paint(YELLOW, 'not run')}  ${releaseLanes.flatMap((lane) => gatesInLane(lane.id).filter((gate) => gate.policy === 'required-release').map((gate) => gate.id)).join(', ')}  ${paint(DIM, '— required before publishing; `npm run verify:release`')}`,
    );
  }
  if (ciOnly.length > 0) {
    out(
      `${paint(YELLOW, 'not observed')}  ${ciOnly.map((gate) => gate.id).join(', ')}  ${paint(DIM, '— required, and only GitHub can answer them')}`,
    );
  }
}

const argv = process.argv.slice(2);
const options = {
  ci: argv.includes('--ci'),
  release: argv.includes('--release'),
};
const positional = argv.filter((argument) => !argument.startsWith('--'));

if (argv.includes('--describe')) {
  const { INFRASTRUCTURE } = await import('./gates.mjs');
  out(JSON.stringify({ lanes: LANES, gates: GATES, infrastructure: INFRASTRUCTURE }, null, 2));
  process.exit(0);
}

const target = positional[0];
if (target === undefined) {
  out('usage: node scripts/gate.mjs <lane|verify> [--ci] [--release]');
  out(`lanes: ${LANES.map((lane) => lane.id).join(', ')}`);
  process.exit(2);
}

const lanes = target === 'verify' ? verifyOrder() : [target];

const failures = [];
for (const lane of lanes) {
  const result = runLane(lane, options);
  failures.push(...result.failures);
  // Inside `verify`, a failed lane stops the rest: the remaining lanes cost minutes and
  // the answer is already no.
  if (target === 'verify' && result.failures.length > 0) break;
}

reportGaps(lanes, options);

out();
if (failures.length > 0) {
  out(paint(RED, `FAILED  ${failures.map((gate) => gate.id).join(', ')}`));
  process.exit(1);
}
out(paint(GREEN, `PASS  ${lanes.join(', ')}`));
