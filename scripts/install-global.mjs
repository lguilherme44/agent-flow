#!/usr/bin/env node
/**
 * Build this checkout and install it globally, on macOS and on Windows.
 *
 * The README asked for four commands and a shell substitution:
 *
 *     npm run build && npm run build:web && npm install -g "$(npm pack | tail -1)"
 *
 * Two things were wrong with that, and both are the kind that fail quietly. It never ran
 * `build:deck`, so the global install carried no Deck bundle and `agent-flow ui` fell back
 * to the previous dashboard — silently, because falling back is what `resolveWebDir` is
 * *for*, and the fallback is correct behaviour for a missing bundle. And `$(… | tail -1)`
 * is `sh`, so on Windows there was no documented way to install at all, which is half the
 * machines this is developed on.
 *
 * Node runs on both, so the script is Node. It builds all three bundles, packs, installs
 * the tarball, deletes it, and then asks the *installed* binary to identify itself —
 * because "npm exited 0" and "the command works" are different claims, and only the
 * second is the one somebody wanted.
 *
 * Usage:  npm run install:global
 *         node scripts/install-global.mjs --dry-run
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok, run, step } from './lib/packaged-app.mjs';

/**
 * Everything the package ships, and the reason each one is here.
 *
 * `files` in `package.json` names `dist`, `prompts`, `apps/deck/dist` and
 * `apps/web/dist` — so a bundle that was not built is simply absent from the tarball, and
 * `npm pack` says nothing about it. This list and that one have to agree; the packaging
 * gate is what proves they do.
 */
const BUILDS = [
  ['build', 'the CLI and the server'],
  ['build:deck', 'the dashboard `ui` opens'],
  ['build:web', 'the previous dashboard, behind `--classic`'],
];

const dryRun = process.argv.includes('--dry-run');

function main() {
  step(`building ${String(BUILDS.length)} bundles`);
  for (const [script, what] of BUILDS) {
    run('npm', ['run', script]);
    ok(`${script} — ${what}`);
  }

  // Packed into a temporary directory rather than the repository root. A stray
  // `agent-flow-0.1.0.tgz` in the working tree is the kind of file that gets committed
  // once and then lives in the history forever.
  const staging = mkdtempSync(join(tmpdir(), 'agent-flow-pack-'));

  try {
    step('packing');
    // `--json`, never `tail -1`. npm prints notices to stdout often enough that the last
    // line is not reliably the filename, and a wrong filename here fails as "no such
    // file" three commands later, pointing at nothing.
    const packed = run('npm', ['pack', '--json', '--pack-destination', staging]);
    const [meta] = JSON.parse(packed.stdout);
    const tarball = join(staging, meta.filename);
    ok(`${meta.filename} — ${String(meta.files.length)} files, ${String(Math.round(meta.size / 1024))} kB`);

    if (dryRun) {
      ok('--dry-run: built and packed, nothing installed');
      return;
    }

    step('installing globally');
    run('npm', ['install', '-g', tarball]);
    ok(`agent-flow@${meta.version}`);

    // **The install is not the claim.** `npm install -g` can exit 0 and leave a binary
    // that is not on this shell's PATH, or one shadowed by an older global. Asking the
    // command what version it is answers both at once, and answers them the way the
    // person will find out otherwise: by typing `agent-flow` and reading what happens.
    step('asking the installed command who it is');
    const installed = run('agent-flow', ['--version'], { cwd: tmpdir(), allowFailure: true });
    const reported = installed.stdout.trim();

    if (installed.status !== 0) {
      process.stdout.write(
        [
          '',
          `   The package installed, and \`agent-flow --version\` exited ${String(installed.status)}.`,
          '   The usual cause is npm\'s global bin directory not being on PATH.',
          '   `npm prefix -g` names it; add its `bin` (macOS) or the directory itself (Windows).',
          '',
        ].join('\n'),
      );
      process.exitCode = 1;
      return;
    }

    if (!reported.includes(meta.version)) {
      // A different agent-flow answered — an older global, or a shim earlier on PATH.
      // Reporting success here would be reporting somebody else's binary as this build.
      process.stdout.write(
        [
          '',
          `   Installed ${meta.version}, but \`agent-flow --version\` says "${reported}".`,
          '   Another agent-flow is earlier on PATH. `npm ls -g agent-flow` and',
          '   `where agent-flow` (Windows) or `which -a agent-flow` (macOS) will name it.',
          '',
        ].join('\n'),
      );
      process.exitCode = 1;
      return;
    }

    ok(`on PATH, and it is this build: ${reported}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
