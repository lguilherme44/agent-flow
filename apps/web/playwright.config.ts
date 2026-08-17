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
 * Baselines are per-platform by construction — font rasterisation differs between
 * macOS and Linux — so `{platform}` is in the snapshot path and the two sets never
 * meet. Both are committed: `desktop-1440-darwin` from a maintainer's machine and
 * `desktop-1440-linux` from the pinned Playwright container CI runs in. Comparing
 * one against the other would report a diff on every pixel of every glyph and
 * teach everybody to ignore this suite.
 */

/**
 * Which browser draws the baselines.
 *
 * Chrome on macOS because the repository does not download browsers and the
 * machine already has one. Bundled Chromium everywhere else, because that is
 * pinned to the Playwright version in the lockfile — so the Linux baselines are
 * reproducible from the container tag alone, without depending on whatever Chrome
 * release a runner happens to have installed that week.
 *
 * The two never compare against each other, so using different builds costs
 * nothing and buys reproducibility on the side that has to be automated.
 */
const BROWSER =
  process.env['AF_VISUAL_BROWSER'] ?? (process.platform === 'darwin' ? 'chrome' : 'chromium');

export default defineConfig({
  testDir: './visual',
  outputDir: './visual/.results',
  // The project name is in the path because the two viewports render different
  // layouts of the same page. Without it the 1280 shot is compared against the
  // 1440 baseline, and the suite reports a size mismatch instead of a diff.
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}-{platform}/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: process.env['CI'] === 'true',
  // The HTML report is how a failure in CI becomes something a person can look at:
  // it embeds the expected, the actual and the diff for every mismatch. A list
  // reporter alone says "screenshot comparison failed" and nothing about what moved.
  reporter:
    process.env['CI'] === 'true' ? [['list'], ['html', { open: 'never' }]] : [['list']],

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
    ...(BROWSER === 'chromium' ? {} : { channel: BROWSER }),
  },

  projects: [
    // The four widths §66 draws a line at. 1440 and 1280 are the layout
    // targets; 1200 is the first pixel where the inspector still sits beside
    // the table, and 1024 the first where it does not — the two sides of a
    // boundary are the only places a boundary can be wrong.
    {
      name: 'desktop-1440',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'laptop-1280',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'narrow-1200',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1200, height: 800 } },
    },
    {
      name: 'small-1024',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 768 } },
    },
  ],

  webServer: {
    // The built bundle, not the dev server: the dev server injects an overlay
    // and serves unminified CSS, so it is not what anybody will look at.
    //
    // The build is *inside* the command rather than a separate step, so there is no
    // way to run this suite — comparing or updating — against anything but the
    // current source. `npm run` here resolves to this workspace's `build`, which is
    // `tsc --noEmit && vite build`.
    //
    // `--host 127.0.0.1` is required, not cosmetic: `vite preview` binds `::1`
    // only, so the IPv4 address Playwright polls never answers and the run dies
    // on a 120-second timeout with a healthy server sitting right there.
    command: 'npm run build && npx vite preview --port 4788 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4788',

    /**
     * Never (D32-A).
     *
     * This was `process.env.CI !== 'true'`, and the consequence was the worst kind
     * of green: a `vite preview` left running from an earlier session answers on
     * 4788, Playwright adopts it, the build inside `command` never runs, and the
     * screenshots compare an old bundle against the baselines. Source changes, the
     * suite passes, and the pass is a statement about a bundle nobody has built
     * since.
     *
     * With this false the server is always started, so the build always runs; and
     * `--strictPort` turns an occupied port into a refusal that names itself
     * instead of a silent adoption. The cost is one build per invocation, which is
     * two seconds, and the alternative is a suite whose green means nothing.
     */
    reuseExistingServer: false,
    timeout: 600_000,
  },
});
