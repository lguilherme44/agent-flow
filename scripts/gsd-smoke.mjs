#!/usr/bin/env node
/**
 * Black-box acceptance of the *packaged* product, with a second browser (D33-D).
 *
 * This is not a smaller Playwright suite and must never become one. Playwright knows
 * this application: it selects by the roles the components render, waits on the
 * queries they issue, and asserts against the contracts the server declares. That is
 * exactly what makes it the deterministic gate — and exactly why it cannot answer the
 * one question packaging poses:
 *
 *   Can a browser that knows nothing about React or Fastify use Agent Flow as it was
 *   installed?
 *
 * So this drives the tarball, from a directory that is not the repository, with the
 * checkout's own dashboard bundle renamed away, through a tool with no knowledge of
 * the codebase: navigate, snapshot, click a ref, assert on visible text, console and
 * network. Two journeys, no baselines, no pixel comparison — the visual gate stays
 * with Playwright.
 *
 * The version is pinned. `latest` in a smoke test means the smoke test changes on its
 * own, and a black-box check that changed underneath you is worse than none.
 *
 * Usage:  node scripts/gsd-smoke.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SmokeFailure,
  check,
  installTarball,
  makeFixtureProject,
  ok,
  packTarball,
  run,
  startUi,
  step,
  withTempRoot,
  withoutCheckoutBundle,
} from './lib/packaged-app.mjs';

/** Pinned. See the note above; `latest` is not a version. */
const GSD_VERSION = '0.2.2';
const GSD_PACKAGE = `@opengsd/gsd-browser@${GSD_VERSION}`;
/** Unique per run, so no earlier daemon or page can be inherited. */
const SESSION = `agent-flow-packaging-${String(process.pid)}`;

await main();

async function main() {
  let session = false;

  try {
    requirePinnedBrowser();

    await withTempRoot(async (root) => {
      const { tarball } = packTarball(root);
      const { prefix, bin } = await installTarball(tarball);

      try {
        await withoutCheckoutBundle(async () => {
          const fixture = await makeFixtureProject(bin, root);
          const server = await startUi(bin, {
            root,
            served: fixture.dir,
            globalConfigPath: fixture.globalConfigPath,
            fakeLog: fixture.fakeLog,
          });

          session = true;

          try {
            await gsd01(server.url, fixture);
            await gsd02(server.url, fixture, bin);
          } finally {
            server.stop();
          }
        });
      } finally {
        await rm(prefix, { recursive: true, force: true });
      }
    });

    process.stdout.write('\ngsd-browser packaged smoke: PASS\n');
  } catch (error) {
    process.stderr.write(
      `\ngsd-browser packaged smoke: FAIL\n${error instanceof SmokeFailure ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    // Named session, closed here. A daemon left running would be inherited by the
    // next invocation, and a test that inherits a browser is a test whose starting
    // state came from somewhere it cannot see.
    if (session) closeSession();
  }
}

// ---------------------------------------------------------------------------
// GSD-01 — navigation
// ---------------------------------------------------------------------------

/**
 * Dashboard → run → DAG → task → inspector, with nothing broken on the way.
 *
 * Deliberately shallow on *semantics* and strict on *delivery*. Whether the approval
 * gate enforces a plan hash is Playwright's question. Whether a browser can load this
 * page at all, with no console error and no failed request, is this one — and it is
 * the question that a missing asset, a wrong MIME type or an unpackaged prompt answers
 * with a blank screen.
 */
async function gsd01(url, fixture) {
  step('GSD-01 — a browser opens the packaged application');

  gsd(['navigate', url]);
  gsd(['wait-for', '--condition', 'text_visible', '--value', fixture.runId, '--timeout', '20000']);

  assertions([
    { kind: 'text_visible', text: fixture.runId },
    { kind: 'text_visible', text: 'booking-api' },
    // The run reached the gate, and the page says so in words rather than in colour.
    { kind: 'text_visible', text: 'WAITING APPROVAL' },
    // The plan the packaged planner produced.
    { kind: 'text_visible', text: 'Add recurrence types' },
    { kind: 'text_visible', text: 'Generate occurrences' },
    { kind: 'no_console_errors' },
    { kind: 'no_failed_requests' },
  ]);
  ok('the dashboard loads with no console error and no failed request');

  // Refs from a snapshot rather than a CSS selector: a selector is knowledge of the
  // implementation, which is the thing this journey is supposed not to have.
  clickByName('View as DAG');
  gsd(['wait-for', '--condition', 'text_visible', '--value', 'Task dependencies', '--timeout', '15000']);
  assertions([
    { kind: 'text_visible', text: 'Task dependencies' },
    // React Flow's own chrome. Its absence means the graph did not mount — which is
    // how a lazily-loaded chunk that was not packaged would show up.
    { kind: 'selector_visible', selector: '.react-flow__node' },
    { kind: 'element_count', selector: '.react-flow__node', threshold: '==2' },
    { kind: 'no_console_errors' },
  ]);
  ok('the dependency graph renders from the packaged bundle');

  // Back to the table, then open a task. The inspector is the deepest read in the
  // app: task detail, its result, its validation output and its log.
  clickByName('View as DAG');
  gsd(['wait-for', '--condition', 'text_visible', '--value', 'Add recurrence types', '--timeout', '15000']);
  clickByName('Add recurrence types');

  gsd(['wait-for', '--condition', 'text_visible', '--value', 'Logs', '--timeout', '15000']);
  assertions([
    { kind: 'text_visible', text: 'Logs' },
    { kind: 'text_visible', text: 'Domain types for a weekly series.' },
    { kind: 'no_console_errors' },
    { kind: 'no_failed_requests' },
  ]);
  ok('the selected task opens in the Task Inspector');
}

// ---------------------------------------------------------------------------
// GSD-02 — an operational journey
// ---------------------------------------------------------------------------

/**
 * Waiting for approval → approve → start → the run finishes.
 *
 * The full journey rather than the reduced "approve and see it reflected" version the
 * brief allows, because the reduced one leaves the most packaging-sensitive step
 * untested: starting a run makes the *installed* server spawn runner processes and
 * write task results, and it is the only path that exercises the packaged scheduler
 * end to end. It costs one more click and about a second.
 *
 * Nothing real is invoked. The runner is the same deterministic executable the
 * Playwright suite uses, named in the fixture's global configuration.
 */
async function gsd02(url, fixture, bin) {
  step('GSD-02 — approve, start, and watch it finish');

  gsd(['navigate', `${url}/dashboard?project=booking-api`]);
  gsd(['wait-for', '--condition', 'text_visible', '--value', 'WAITING APPROVAL', '--timeout', '20000']);

  clickByName('Review & approve');
  gsd(['wait-for', '--condition', 'text_visible', '--value', 'Plan review: PASS', '--timeout', '15000']);
  assertions([
    { kind: 'text_visible', text: 'Plan hash' },
    { kind: 'text_visible', text: 'Plan review: PASS' },
  ]);

  clickByName('Approve Plan');
  gsd(['wait-for', '--condition', 'text_visible', '--value', 'Start run', '--timeout', '20000']);
  ok('the gate opened, and the run now offers execution');

  clickByName('Start run');
  // The job first, then the work. `2 / 2` is the run's own count of completed tasks,
  // which only appears once the packaged scheduler has written both results.
  gsd(['wait-for', '--condition', 'text_visible', '--value', '2 / 2', '--timeout', '90000']);

  assertions([
    { kind: 'text_visible', text: '2 / 2' },
    { kind: 'no_console_errors' },
    { kind: 'no_failed_requests' },
  ]);
  ok('the packaged server executed the plan and the browser saw it finish');

  // Confirmed off disk as well, and through the other adapter over the same use
  // cases: what the browser saw has to be what the StateStore holds, or one of the
  // two is telling a story.
  const status = run(bin, ['--cwd', fixture.dir, '--config', fixture.globalConfigPath, 'status'], {
    cwd: fixture.dir,
    allowFailure: true,
  });
  check(status.stdout.includes(fixture.runId), 'the packaged CLI agrees about the run');
  check(status.stdout.includes('Approval'), 'and reports the gate');

  const state = JSON.parse(
    readFileSync(join(fixture.dir, '.agent-flow/runs', fixture.runId, 'state.json'), 'utf8'),
  );
  check(state.approved === true, 'the run is approved on disk');
  check(
    state.tasks.length === 2 && state.tasks.every((task) => task.state === 'completed'),
    `both tasks are completed on disk (${state.tasks.map((t) => t.state).join(', ')})`,
  );
}

// ---------------------------------------------------------------------------
// driving gsd-browser
// ---------------------------------------------------------------------------

function requirePinnedBrowser() {
  step(`gsd-browser, pinned at ${GSD_VERSION}`);

  const probe = spawnSync('gsd-browser', ['--version'], { encoding: 'utf8' });

  if (probe.status !== 0) {
    throw new SmokeFailure(
      `gsd-browser is not on PATH.\n` +
        `Install the pinned version — never \`latest\`, or this check changes on its own:\n` +
        `  npm i -g ${GSD_PACKAGE}\n`,
    );
  }

  const found = probe.stdout.trim().split(/\s+/).pop() ?? '';
  check(found === GSD_VERSION, `gsd-browser ${found} matches the pinned version`);
}

/** One gsd-browser command, in this run's own session, parsed as JSON. */
function gsd(args) {
  const result = spawnSync('gsd-browser', [...args, '--session', SESSION, '--json'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  if (result.status !== 0) {
    throw new SmokeFailure(`gsd-browser ${args.join(' ')} exited ${String(result.status)}\n${output}`);
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    // Not every command answers with JSON; the callers that need structure ask for it.
    return { raw: result.stdout };
  }
}

/**
 * Every assertion in one call, so a failure names all of them rather than the first.
 *
 * `--checks` is explicit JSON on purpose. The brief is specific about this: a smoke
 * test that asks a tool to interpret a sentence has no defined failure, and "it looked
 * fine" is not an assertion.
 */
function assertions(checks) {
  const result = gsd(['assert', '--checks', JSON.stringify(checks)]);
  const rows = Array.isArray(result?.checks) ? result.checks : [];

  // An output shape this script does not recognise must not read as a pass. Silence
  // is the one answer a black-box check can never accept.
  if (rows.length !== checks.length) {
    throw new SmokeFailure(
      `expected ${String(checks.length)} verdicts, got ${String(rows.length)}: ` +
        `${JSON.stringify(result).slice(0, 400)}`,
    );
  }

  const failures = rows
    .filter((row) => row?.passed !== true)
    .map((row) => `${row?.kind}: expected ${row?.expected}, got ${row?.actual}`);

  if (failures.length > 0 || result?.verified !== true) {
    throw new SmokeFailure(
      `assertions failed (${result?.summary ?? 'no summary'}):\n  ${failures.join('\n  ')}`,
    );
  }
}

/**
 * Clicks the element whose accessible name contains `name`.
 *
 * Through `snapshot` and a ref rather than a CSS selector, which is the point of the
 * exercise: the snapshot is the tool's own reading of what is interactive on the page,
 * and a ref is its handle on one of them. A selector would be knowledge of the
 * markup — the very thing a black-box journey is supposed not to have.
 */
function clickByName(name) {
  const snapshot = gsd(['snapshot', '--mode', 'interactive', '--limit', '120']);
  const refs = snapshot?.refs ?? {};
  const version = snapshot?.version;

  if (typeof version !== 'number') {
    throw new SmokeFailure(`snapshot carried no version: ${JSON.stringify(snapshot).slice(0, 300)}`);
  }

  const found = Object.entries(refs).find(([, element]) =>
    [element?.name, element?.text, element?.label, element?.nearestHeading]
      .filter((value) => typeof value === 'string')
      .some((value) => value.includes(name)),
  );

  if (found === undefined) {
    const seen = Object.values(refs)
      .map((element) => element?.name ?? element?.text ?? '')
      .filter((value) => value !== '')
      .slice(0, 40);
    throw new SmokeFailure(`no interactive element named "${name}". Saw: ${seen.join(' | ')}`);
  }

  const ref = `@v${String(version)}:${found[0]}`;
  gsd(['click-ref', ref]);
  // The click is synchronous in the tool and asynchronous in the application: React
  // re-renders and a query refetches. The caller's `wait-for` is what settles it.
  return ref;
}

function closeSession() {
  for (const args of [['close-page'], ['daemon', 'stop']]) {
    spawnSync('gsd-browser', [...args, '--session', SESSION], { encoding: 'utf8' });
  }
  ok(`session ${SESSION} closed`);
}
