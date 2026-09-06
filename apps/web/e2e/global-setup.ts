import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CLI, REPO_ROOT } from './support/world';

/**
 * Builds what the suite is about to test — every time, from this source.
 *
 * The failure this exists to make impossible (D-F01): a suite that runs against a
 * bundle somebody built an hour ago, passes, and is read as a statement about the
 * working tree. Both artifacts matter here and for different reasons. The CLI bundle
 * is what `agent-flow ui` *is* — the server, the application services, the whole
 * write API. The dashboard bundle is what the browser loads; without it the CLI
 * serves the API and a blank page, and every assertion below would fail for a
 * reason that has nothing to do with the code under test.
 *
 * Synchronous and loud. A build failure here has to stop the run rather than let
 * three hundred assertions fail one at a time against a stale artifact.
 */
export default function globalSetup(): void {
  build('the CLI bundle', ['run', 'build']);
  build('the classic dashboard bundle', ['run', 'build:web']);
  build('the Deck dashboard bundle', ['run', 'build:deck']);

  for (const [what, path] of [
    ['CLI', CLI],
    ['dashboard', join(REPO_ROOT, 'apps/web/dist/index.html')],
    ['Deck dashboard', join(REPO_ROOT, 'apps/deck/dist/index.html')],
  ] as const) {
    if (!existsSync(path)) {
      throw new Error(`the ${what} build reported success but ${path} does not exist`);
    }
  }
}

function build(what: string, args: readonly string[]): void {
  process.stdout.write(`building ${what}…\n`);

  const result = spawnSync('npm', [...args], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    // `npm` is a shell script on Windows; harmless elsewhere and required there.
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    throw new Error(`building ${what} failed with status ${String(result.status)}`);
  }
}
