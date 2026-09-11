import { defineConfig, devices } from '@playwright/test';

/**
 * The Deck at the width of a phone.
 *
 * The repository had no such thing. `apps/web`'s visual suite previews *that* workspace,
 * so it covers the previous dashboard; the Deck had no browser test at any width, and the
 * narrowest viewport asserted anywhere in the repository was 1024×768. Measured on a real
 * phone on 11/09/2026: the shell's navigation and the run page were laid out for 720px
 * and up — `shell.css` and `run.css` have no rule below it — and neither had ever been
 * looked at narrower.
 *
 * 390×844 is an iPhone 14/15 in portrait. One viewport, not a matrix: this suite exists
 * to answer "does it fit in a hand", and a second phone width would double the baselines
 * without asking a different question.
 *
 * The API is stubbed in the spec rather than served, so nothing here spawns a runner —
 * which is why this runs on Windows while the e2e browser gate does not (that one
 * configures a `.mjs` as a runner command, and Windows cannot spawn one).
 */
export default defineConfig({
  testDir: './phone',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  // Platform in the path: font rasterisation differs between Windows and Linux, and a
  // baseline taken on one is noise on the other.
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      // Anti-aliasing moves a few pixels between runs; a layout that breaks moves
      // thousands. This threshold catches the second and ignores the first.
      maxDiffPixelRatio: 0.002,
    },
  },
  use: {
    // Pixel 5 rather than an iPhone: it is a Chromium device profile, and Chromium is the
    // engine this repository already downloads for its visual suite. Asking for WebKit
    // would make the phone gate depend on a browser nobody here has installed — a test
    // that cannot run is worth less than no test, because it reads as coverage.
    ...devices['Pixel 5'],
    viewport: { width: 390, height: 844 },
    baseURL: 'http://127.0.0.1:4789',
  },
  webServer: {
    // Built, never the dev server, and the build is inside the command so the suite
    // cannot compare against a bundle nobody rebuilt — the same reasoning, and the same
    // hard-won lesson, as `apps/web/playwright.config.ts`.
    command: 'npm run build && npx vite preview --port 4789 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4789',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
