#!/usr/bin/env node
/**
 * Does the published package work outside the checkout? (UI-33)
 *
 * Nothing here is a unit test in disguise. Every assertion is about a difference
 * between the repository and the tarball — a `files` entry that does not exist, a
 * runtime path that only resolves because the source tree happens to be next door,
 * a prompt that was never packaged, an `index.html` pointing at an asset that is not
 * in the archive. All of those pass inside the repository and fail on the first
 * person to run `npm i -g agent-flow`.
 *
 * Usage:  node scripts/packaging-smoke.mjs
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  REPO,
  SmokeFailure,
  check,
  installTarball,
  makeFixtureProject,
  ok,
  packTarball,
  packageVersion,
  run,
  startUi,
  step,
  withTempRoot,
  withoutCheckoutBundle,
} from './lib/packaged-app.mjs';

/** Present, or the package is not the product. */
const REQUIRED = [
  'package.json',
  'dist/bin/agent-flow.js',
  'apps/deck/dist/index.html',
  'apps/web/dist/index.html',
  'prompts/discovery.md',
  'prompts/architecture-impact.md',
  'prompts/sdd.md',
  'prompts/planning.md',
  'prompts/planning-trivial.md',
  'prompts/planning-simple.md',
  'prompts/plan-review.md',
  'prompts/plan-review-simple.md',
  'prompts/implementation.md',
  'prompts/verification.md',
  'prompts/final-review.md',
];

/**
 * Absent, or the package is carrying the workshop.
 *
 * Each of these has a reason beyond size. Screenshots and Playwright output are
 * hundreds of images. `.agent-flow/` is somebody's run history, including whatever
 * their feature requests said. `apps/web/src` and `src/` would make the published
 * artifact ambiguous — two copies of the app, one of which nothing runs.
 */
const FORBIDDEN = [
  /^src\//,
  /^test\//,
  /^apps\/web\/src\//,
  /^apps\/web\/e2e\//,
  /^apps\/web\/visual\//,
  /^apps\/deck\/src\//,
  /^coverage\//,
  /^\.agent-flow\//,
  /^\.github\//,
  /^scripts\//,
  /^docs\//,
  /^node_modules\//,
  /playwright/i,
  /__screenshots__/,
  /\.tgz$/,
  /\.env/,
  /\.tsbuildinfo$/,
];

await main();

async function main() {
  try {
    await withTempRoot(async (root) => {
      const { tarball, files, version } = packTarball(root);

      step('what is in the tarball (D33-A, D33-B)');
      check(version === packageVersion(), `the tarball is version ${version}`);

      for (const required of REQUIRED) {
        check(files.includes(required), `ships ${required}`);
      }

      const strays = files.filter((path) => FORBIDDEN.some((pattern) => pattern.test(path)));
      check(strays.length === 0, `carries nothing from the workshop${strays.length ? `: ${strays.join(', ')}` : ''}`);

      // `files` had an entry for a `templates/` directory that has never existed and
      // nothing reads. Harmless to npm, which skips it silently — and not harmless to
      // the next person, who finds a declared runtime directory and goes looking for
      // what removed it. A declaration that cannot be satisfied is a lie the packer
      // will not tell you about, so it is checked here.
      const declared = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).files;
      for (const entry of declared) {
        check(existsSync(join(REPO, entry)), `files declares ${entry}, which exists`);
      }

      // The dashboard's entry point and every asset it names. An `index.html`
      // pointing at a hashed bundle that was not packaged is a blank page with a 404
      // in the console, and it is the single most likely packaging mistake.
      // Two bundles, one entry point each: Deck, which `ui` opens, and the previous
      // dashboard behind `--classic`.
      for (const bundle of ['deck', 'web']) {
        const html = files.filter((path) => path === `apps/${bundle}/dist/index.html`);
        check(html.length === 1, `ships exactly one entry point for apps/${bundle}`);

        const assets = files.filter((path) => path.startsWith(`apps/${bundle}/dist/assets/`));
        check(assets.length > 0, `ships ${String(assets.length)} assets for apps/${bundle}`);
      }

      const { prefix, bin } = await installTarball(tarball);

      try {
        await withoutCheckoutBundle(async () => {
          step('the binary, from a directory that is not the repository (D33-C)');

          const versionOut = run(bin, ['--version'], { cwd: root });
          check(
            versionOut.stdout.trim() === version,
            `--version says ${versionOut.stdout.trim()}`,
          );

          const help = run(bin, ['--help'], { cwd: root });
          for (const command of ['init', 'doctor', 'feature', 'approve', 'run', 'review', 'ui']) {
            check(help.stdout.includes(command), `--help lists ${command}`);
          }

          // `doctor` reports on the environment, so a machine with no coding CLI
          // installed answers FAIL — which is a correct answer, not a broken one.
          // What is being checked is that it runs at all: it resolves the prompt
          // directory, builds the runner registry and computes health over role
          // routes, none of which can happen if the package is missing something.
          const doctor = run(bin, ['doctor'], { cwd: root, allowFailure: true });
          const doctorText = `${doctor.stdout}${doctor.stderr}`;
          check(/OK|DEGRADED|FAIL/.test(doctorText), 'doctor reaches a verdict');
          check(
            !/Cannot find module|ENOENT.*prompts|MODULE_NOT_FOUND/.test(doctorText),
            'doctor resolves everything it needs from the package',
          );

          step('a real project, planned and served by the installed package');
          const fixture = await makeFixtureProject(bin, root);

          const server = await startUi(bin, {
            root,
            served: fixture.dir,
            globalConfigPath: fixture.globalConfigPath,
            fakeLog: fixture.fakeLog,
          });

          try {
            await assertServed(server.url, fixture, root);
          } finally {
            server.stop();
          }
        });
      } finally {
        await rm(prefix, { recursive: true, force: true });
      }
    });

    process.stdout.write('\nPackaging smoke: PASS\n');
  } catch (error) {
    process.stderr.write(
      `\nPackaging smoke: FAIL\n${error instanceof SmokeFailure ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

async function assertServed(url, fixture, root) {
  step('the packaged server and the packaged dashboard (D33-E)');

  const health = await json(`${url}/api/v1/health`);
  check(health.status === 'ok', `health reports ${health.status} on port ${String(health.port)}`);
  check(health.projects === 1, 'the registry holds the one project it was pointed at');

  // The prompts came out of the package, and *all* of them did — a partially packaged
  // `prompts/` is caught rather than inferred.
  //
  // **Counted from the checkout rather than hardcoded, because the hardcoded number
  // drifted.** It said eleven; M6 added `prompts/code-review.md` and CI went red on this
  // job and stayed red, invisible to every milestone gate because `test:packaging` is not
  // in the canonical list those run. A number that has to be edited when a file is added
  // is a number that will be wrong.
  const expected = (await readdir(new URL('../prompts', import.meta.url))).filter((name) =>
    name.endsWith('.md'),
  ).length;
  const prompts = await json(`${url}/api/v1/prompts`);
  check(
    prompts.length === expected,
    `serves ${String(prompts.length)} packaged prompts (the checkout has ${String(expected)})`,
  );

  // The dashboard, with the checkout's own bundle renamed away. A page that still
  // loads is being served from the install prefix.
  const index = await fetch(url);
  check(index.status === 200, 'GET / answers 200');
  check(
    (index.headers.get('content-type') ?? '').includes('text/html'),
    'GET / answers with HTML',
  );

  const body = await index.text();
  const referenced = [...body.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
    (match) => match[1],
  );
  check(referenced.length > 0, `the page names ${String(referenced.length)} assets`);

  for (const asset of referenced) {
    const response = await fetch(`${url}${asset}`);
    const type = response.headers.get('content-type') ?? '';
    check(
      response.status === 200,
      `${asset} resolves (${String(response.status)}, ${type.split(';')[0]})`,
    );
    check(
      asset.endsWith('.js') ? /javascript/.test(type) : /css/.test(type),
      `${asset} is served as the type it is`,
    );
  }

  // A client-side route falls through to the shell rather than to a 404, which is
  // what makes a bookmarked run page work at all.
  const deep = await fetch(`${url}/runs/${fixture.runId}?project=booking-api`);
  check(deep.status === 200, 'a dashboard route falls through to the shell');

  // And the run itself, read through the API by the packaged server.
  const projects = await json(`${url}/api/v1/projects`);
  check(projects[0]?.id === 'booking-api', 'the project is registered under its own id');
  // Against the *resolved* root: the registry compares resolved paths on purpose,
  // and on macOS `/var/folders` is a link to `/private/var/folders`.
  check(
    projects[0]?.path.startsWith(realpathSync(root)),
    'the registered path is the fixture, not the checkout',
  );

  const detail = await json(`${url}/api/v1/runs/${fixture.runId}?project=booking-api`);
  check(detail.status === 'waiting_for_approval', `${fixture.runId} is at the gate`);

  const tasks = await json(`${url}/api/v1/runs/${fixture.runId}/tasks?project=booking-api`);
  check(tasks.length === 2, `the plan has ${String(tasks.length)} tasks`);

  const dag = await json(`${url}/api/v1/runs/${fixture.runId}/dag?project=booking-api`);
  check(dag.edges.length === 1, 'the dependency graph has the edge the plan declares');

  // Nothing in the package's own answers points back at the repository. A path that
  // did would mean the install is quietly reading the checkout — which is precisely
  // what this whole script exists to rule out, and what would make every assertion
  // above true for the wrong reason.
  const everything = JSON.stringify({ health, prompts, projects, detail, tasks, dag });
  check(!everything.includes(REPO), 'no response names the development checkout');

  ok('the packaged server serves a packaged dashboard with no checkout present');
}

async function json(target) {
  const response = await fetch(target);
  if (!response.ok) throw new SmokeFailure(`GET ${target} answered ${String(response.status)}`);
  return await response.json();
}
