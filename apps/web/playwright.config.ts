import { defineConfig, devices } from '@playwright/test';

/**
 * Visual regression for the dashboard (§98).
 *
 * The previous milestone shipped a layout validated only by DOM assertions, and
 * they all passed while a card title wrapped into a fixed-height header, an
 * artifacts list clipped without scroll, and a duration badge upper-cased itself
 * into a different unit. "The element exists" is not "the layout is right", and
 * only a picture tells the difference.
 *
 * Determinism comes from three places: the API is stubbed, the clock is pinned
 * so "Today at 19:34" never moves, and the locale and timezone are fixed so
 * `toLocaleTimeString` renders the same string on any machine. Animations are
 * disabled by Playwright's own screenshot handling.
 *
 * Baselines are per-platform by construction — font rasterisation differs
 * between macOS and Linux — so the committed ones are darwin/arm64 and CI does
 * not run this suite. Running it elsewhere means generating that platform's
 * baseline first with `npm run test:visual:update`.
 */
export default defineConfig({
  testDir: './visual',
  outputDir: './visual/.results',
  // The project name is in the path because the two viewports render different
  // layouts of the same page. Without it the 1280 shot is compared against the
  // 1440 baseline, and the suite reports a size mismatch instead of a diff.
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}-{platform}/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: process.env['CI'] === 'true',
  reporter: [['list']],

  expect: {
    toHaveScreenshot: {
      // Antialiasing differs by a hair between runs on the same machine. Zero
      // tolerance turns that into a red suite nobody trusts; this is tight
      // enough to catch a shifted element and loose enough to ignore a pixel.
      maxDiffPixelRatio: 0.002,
      animations: 'disabled',
      caret: 'hide',
    },
  },

  use: {
    baseURL: 'http://127.0.0.1:4788',
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'dark',
    // Chrome rather than bundled Chromium: this repository does not download
    // browsers, and the machine already has one.
    channel: 'chrome',
  },

  projects: [
    {
      name: 'desktop-1440',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'laptop-1280',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],

  webServer: {
    // The built bundle, not the dev server: the dev server injects an overlay
    // and serves unminified CSS, so it is not what anybody will look at.
    //
    // `--host 127.0.0.1` is required, not cosmetic: `vite preview` binds `::1`
    // only, so the IPv4 address Playwright polls never answers and the run dies
    // on a 120-second timeout with a healthy server sitting right there.
    command: 'npm run build && npx vite preview --port 4788 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4788',
    reuseExistingServer: process.env['CI'] !== 'true',
    timeout: 120_000,
  },
});
