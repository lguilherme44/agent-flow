import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The visual suite's environment, as an executable rule (UI-32).
 *
 * A screenshot baseline is only a baseline if the thing that renders it is fixed.
 * Three facts have to stay in agreement for that to be true, and all three are in
 * different files written by different people at different times:
 *
 *   - the Playwright version in the lockfile,
 *   - the container image `scripts/visual-linux.sh` generates baselines in,
 *   - the container image the CI job compares them in.
 *
 * Let any two drift and the failure is a diff on every glyph of every image, which
 * reads as "somebody changed the design" and costs an afternoon before anybody
 * suspects the runner. So the agreement is checked here rather than remembered.
 */

const ROOT = join(import.meta.dirname, '..');
const SCREENSHOTS = join(ROOT, 'apps/web/visual/__screenshots__');

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

/** The `playwright-core` version npm actually installs. */
function lockedPlaywrightVersion(): string {
  const lock = JSON.parse(read('package-lock.json')) as {
    packages: Record<string, { version?: string }>;
  };
  const version = lock.packages['node_modules/playwright-core']?.version;
  expect(version, 'playwright-core is not in the lockfile').toBeDefined();
  return version as string;
}

describe('the visual baselines and the browser that draws them', () => {
  it('generates and compares in the same pinned image', () => {
    const script = read('scripts/visual-linux.sh');
    const workflow = read('.github/workflows/ci.yml');

    const inScript = /mcr\.microsoft\.com\/playwright:(v[\d.]+-\w+)/.exec(script)?.[1];
    const inWorkflow = [
      ...workflow.matchAll(/mcr\.microsoft\.com\/playwright:(v[\d.]+-\w+)/g),
    ].map((match) => match[1]);

    expect(inScript, 'the generator names no image').toBeDefined();
    expect(inWorkflow.length, 'no CI job runs in the Playwright image').toBeGreaterThan(0);
    expect(new Set(inWorkflow)).toEqual(new Set([inScript]));
  });

  it('pins the image to the Playwright version in the lockfile', () => {
    const tag = /mcr\.microsoft\.com\/playwright:v([\d.]+)-/.exec(read('scripts/visual-linux.sh'));

    expect(tag?.[1]).toBe(lockedPlaywrightVersion());
  });

  it('never reuses a running preview (D32-A)', () => {
    // The failure this forbids is a *pass*: a `vite preview` left over from an
    // earlier session answers on the port, Playwright adopts it, the build inside
    // the command never runs, and the screenshots describe a bundle nobody built.
    const config = read('apps/web/playwright.config.ts');

    expect(config).toMatch(/reuseExistingServer:\s*false/);
    // And an occupied port has to be a refusal rather than a fallback to another one.
    expect(config).toContain('--strictPort');
  });

  it('builds the current source inside the server command (D32-B, D32-F)', () => {
    // In `command`, not as a separate step, so comparing and updating are both
    // impossible to run against a stale bundle — including `test:visual:update`,
    // which is the one people run in a hurry.
    const config = read('apps/web/playwright.config.ts');
    const command = /command:\s*'([^']+)'/.exec(config)?.[1] ?? '';

    expect(command).toMatch(/^npm run build &&/);
    expect(command).toContain('vite preview');
  });

  it('keeps one baseline set per platform, and both committed', () => {
    // Comparing Linux against darwin reports a diff on every antialiased pixel. The
    // platform is in the snapshot path, and both sets exist — a suite CI cannot run
    // for want of baselines is a suite that is not a gate.
    expect(read('apps/web/playwright.config.ts')).toContain('{projectName}-{platform}');

    const sets = existsSync(SCREENSHOTS) ? readdirSync(SCREENSHOTS) : [];
    const platforms = new Set(sets.map((name) => name.replace(/^.*-/, '')));

    expect(platforms).toEqual(new Set(['darwin', 'linux']));
    // Every viewport the config declares, on every platform: a project with no
    // baseline silently writes one on first run and compares against nothing.
    for (const project of ['desktop-1440', 'laptop-1280', 'narrow-1200', 'small-1024']) {
      for (const platform of ['darwin', 'linux']) {
        expect(sets, `${project}-${platform}`).toContain(`${project}-${platform}`);
      }
    }
  });

  it('has the same images on both platforms', () => {
    // A shot added on one platform and not regenerated on the other is a comparison
    // that quietly stops happening: Playwright writes the missing baseline and
    // passes. Names only — the bytes are meant to differ.
    const names = (set: string): string[] => readdirSync(join(SCREENSHOTS, set)).sort();

    for (const project of ['desktop-1440', 'laptop-1280', 'narrow-1200', 'small-1024']) {
      expect(names(`${project}-linux`), project).toEqual(names(`${project}-darwin`));
    }
  });
});
