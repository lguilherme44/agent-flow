import { defineConfig, devices } from '@playwright/test';

/**
 * Deterministic E2E across the real Local Server (UI-31).
 *
 * Separate from `playwright.config.ts` because the two suites are answering
 * different questions with different machinery, and folding them together would
 * cost both. Visual regression needs a stubbed API, a pinned clock and a
 * `vite preview` of the bundle. This needs no stub at all: every test starts its
 * own `agent-flow ui` against its own temp repository, so there is nothing for a
 * shared `webServer` to serve and no baseline to compare.
 *
 * There is no `webServer` block on purpose. A single shared server would give every
 * test the same run directory — and a suite where one test's approval decides
 * another test's starting state is a suite that passes in the wrong order and fails
 * in the right one.
 *
 * What *is* shared is the build, in `e2e/global-setup.ts`: both the CLI bundle and
 * the dashboard bundle are rebuilt from the current source before anything runs, so
 * a green suite cannot be describing a bundle from an hour ago.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.results',
  globalSetup: './e2e/global-setup.ts',

  // Each test spawns a CLI, plans a feature and boots a server. Generous, because
  // the alternative is a flake budget nobody can tell from a real regression.
  timeout: 180_000,
  expect: { timeout: 15_000 },

  fullyParallel: true,
  forbidOnly: process.env['CI'] === 'true',
  // Zero, deliberately. A retry that turns a red suite green hides the one class of
  // bug an E2E is uniquely good at finding.
  retries: 0,
  // Each worker runs a server, a CLI and a browser. Four is plenty on a laptop and
  // predictable on a two-core CI runner.
  workers: process.env['CI'] === 'true' ? 2 : 4,

  reporter: process.env['CI'] === 'true' ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    ...devices['Desktop Chrome'],
    // The layout §66 targets, and wide enough that the inspector is a pane rather
    // than a drawer — which is the arrangement most of these assertions describe.
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'dark',
    // `baseURL` is absent on purpose: every test has its own port, and a default
    // would be a URL that is right for exactly one of them.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(process.env['AF_E2E_CHANNEL'] === 'chromium' ? {} : { channel: 'chrome' }),
  },
});
