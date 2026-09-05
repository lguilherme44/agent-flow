/**
 * Agent Flow as somebody else receives it: a tarball, installed, run from elsewhere.
 *
 * Every check that matters here is about the *difference* between the checkout and
 * the package. A test suite inside the repository cannot see that difference — every
 * path it needs happens to exist, so a server reading `apps/web/src`, a prompt
 * loader resolving against `process.cwd()`, or a `files` list missing an entry all
 * pass locally and fail on the first person to install it.
 *
 * So: pack, install into a throwaway prefix outside the repository, run the binary
 * from a working directory that is not the repository either, and — for the duration
 * — hide the checkout's own `apps/web/dist`, so a server that was quietly reading it
 * has nowhere to read from.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../..');
/** The same deterministic runner the Playwright E2E uses. One test double. */
export const FAKE_CLI = join(REPO, 'apps/web/e2e/support/fake-agent-cli.mjs');
/** Both dashboard bundles the checkout can hold; either would resolve by coincidence. */
const CHECKOUT_BUNDLES = ['apps/deck/dist', 'apps/web/dist'].map((dir) => ({
  live: join(REPO, dir),
  hidden: join(REPO, `${dir}.hidden-by-packaging-smoke`),
  rebuild: dir.includes('/deck/') ? 'npm run build:deck' : 'npm run build:web',
}));

export function step(message) {
  process.stdout.write(`\n── ${message}\n`);
}

export function ok(message) {
  process.stdout.write(`   ✓ ${message}\n`);
}

export class SmokeFailure extends Error {}

export function check(condition, message) {
  if (condition !== true) throw new SmokeFailure(message);
  ok(message);
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    // `npm` is a shell script on Windows.
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
  });

  if (options.allowFailure !== true && result.status !== 0) {
    throw new SmokeFailure(
      `${command} ${args.join(' ')} exited ${String(result.status)}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }

  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Builds and packs, then reports what is in the tarball.
 *
 * `npm pack` rather than reading `files` and believing it: the list has an entry for
 * a `templates/` directory that has never existed, which is exactly the kind of
 * claim only the packer can settle.
 */
export function packTarball(destination) {
  step('building, then packing');
  run('npm', ['run', 'build']);
  run('npm', ['run', 'build:web']);

  const packed = run('npm', [
    'pack',
    '--json',
    '--pack-destination',
    destination,
  ]);

  const [meta] = JSON.parse(packed.stdout);
  const tarball = join(destination, meta.filename);
  const files = meta.files.map((entry) => entry.path);

  ok(`${meta.filename} — ${String(files.length)} files, ${String(Math.round(meta.size / 1024))} kB`);
  return { tarball, files, version: meta.version };
}

/**
 * Installs the tarball into a prefix that is not the developer's environment.
 *
 * `--prefix` rather than a bare `-g`: a smoke test that leaves a global install
 * behind has changed the machine it was measuring, and the next run measures the
 * change.
 */
export async function installTarball(tarball) {
  const prefix = await mkdtemp(join(tmpdir(), 'agent-flow-install-'));

  step(`installing into ${prefix}`);
  run('npm', ['install', '-g', '--prefix', prefix, tarball], { cwd: prefix });

  const bin = join(prefix, 'bin', 'agent-flow');
  check(existsSync(bin), 'the package installs an executable named agent-flow');

  return { prefix, bin };
}

/**
 * Hides the checkout's dashboard bundle for the duration of `body`.
 *
 * This is the whole point of D33-E. `resolveWebDir` walks a candidate list, and one
 * of those candidates is `apps/web/dist` two levels up — which is correct inside the
 * installed package and would *also* resolve, by coincidence, if the server were
 * running from the repository. With the checkout's copy renamed away, a dashboard
 * that still loads can only be the packaged one.
 *
 * Restored in a `finally`, and the artifact is regenerable — but the message says so
 * anyway, because a build directory that vanished during a crashed test run is a
 * confusing thing to find.
 */
export async function withoutCheckoutBundle(body) {
  const hidden = CHECKOUT_BUNDLES.filter((bundle) => existsSync(bundle.live));
  for (const bundle of hidden) renameSync(bundle.live, bundle.hidden);

  try {
    return await body();
  } finally {
    for (const bundle of hidden) {
      try {
        if (existsSync(bundle.hidden)) {
          if (existsSync(bundle.live)) await rm(bundle.live, { recursive: true });
          renameSync(bundle.hidden, bundle.live);
        }
      } catch (error) {
        process.stderr.write(
          `\n⚠ could not restore ${bundle.live}: ${String(error)}\n` +
            `  It is a build artifact — run \`${bundle.rebuild}\` to recreate it.\n`,
        );
      }
    }
  }
}

/**
 * A repository with one planned run, produced by the *installed* binary.
 *
 * The fixture is not seeded: `agent-flow feature` writes it, through the packaged
 * code, which is how this also proves the prompts were packaged — the planning
 * stages cannot run without them.
 */
export async function makeFixtureProject(bin, root, name = 'booking-api') {
  const dir = join(root, name);
  const globalConfigPath = join(root, 'global-config.yaml');
  const fakeLog = join(root, 'runner-calls.jsonl');

  await mkdir(join(dir, '.agent-flow'), { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    `${JSON.stringify({ name, version: '1.0.0', private: true }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(dir, '.agent-flow/config.yaml'),
    `project:\n  name: ${name}\n  type: node\ncommands:\n  test: node --version\n`,
    'utf8',
  );
  await writeFile(globalConfigPath, globalConfig(), 'utf8');

  const planned = run(
    bin,
    ['--cwd', dir, '--config', globalConfigPath, 'feature', 'Add weekly recurrence'],
    // Outside the repository, deliberately: anything that resolved against
    // `process.cwd()` has nothing to find here.
    { cwd: root, env: { AF_FAKE_LOG: fakeLog } },
  );

  const runId = (await readFile(join(dir, '.agent-flow/current-run'), 'utf8')).trim();
  ok(`the packaged binary planned ${runId} in ${name}`);

  return { dir, globalConfigPath, fakeLog, runId, output: planned.stdout };
}

function globalConfig() {
  // Two adapters over one deterministic executable, so a plan review is genuinely
  // cross-provider. `enabled: true` is not redundant — the shipped defaults enable
  // one runner, and an omitted flag inherits that.
  return `version: 1
runners:
  claude:
    type: claude-code-cli
    enabled: true
    command: ${FAKE_CLI}
  codex:
    type: codex-cli
    enabled: true
    command: ${FAKE_CLI}
roles:
  architect:     { runner: claude, effort: high }
  sdd:           { runner: claude, effort: high }
  planner:       { runner: codex,  effort: high }
  planReviewer:  { runner: claude, effort: high }
  executors:
    trivial:     { runner: codex,  effort: low }
    normal:      { runner: codex,  effort: medium }
    complex:     { runner: codex,  effort: high }
  verification:  { runner: codex,  effort: medium }
  finalReviewer: { runner: claude, effort: very_high }
fallback:
  enabled: false
`;
}

/** Starts `agent-flow ui` from the installed binary, and waits for it to answer. */
export async function startUi(bin, { root, served, globalConfigPath, fakeLog }) {
  const port = await freePort();

  const child = spawn(
    bin,
    ['--config', globalConfigPath, 'ui', served, '--port', String(port), '--no-open'],
    {
      cwd: root,
      env: { ...process.env, AF_FAKE_LOG: fakeLog },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
  );

  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk) => {
      output += chunk;
    });
  }

  const url = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new SmokeFailure(`agent-flow ui exited ${String(child.exitCode)}\n${output}`);
    }
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    await sleep(150);
  }

  if (Date.now() >= deadline) {
    stop(child);
    throw new SmokeFailure(`agent-flow ui never answered on ${url}\n${output}`);
  }

  ok(`serving ${url}`);
  return { url, stop: () => stop(child), output: () => output };
}

export function stop(child) {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      process.kill(-child.pid, 'SIGTERM');
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // Already gone.
  }
}

export function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => (port ? done(port) : fail(new Error('no free port'))));
    });
  });
}

export function sleep(ms) {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
  });
}

export function packageVersion() {
  return JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
}

/** A temp root, and its removal, wherever the body exits. */
export async function withTempRoot(body) {
  const root = await mkdtemp(join(tmpdir(), 'agent-flow-pack-'));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
