import { describe, it, expect, afterEach } from 'vitest';
import { browserOpenInvocation } from '../../src/cli/ui.js';

/**
 * `agent-flow ui --open` on Windows.
 *
 * The caller swallows every failure — a container or a remote shell is a perfectly good
 * place to run the server — which is exactly why this has to be asserted here: a broken
 * invocation does not fail, it silently does nothing on one of three platforms.
 */

const platform = process.platform;

const as = (value: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value, configurable: true });
};

afterEach(() => {
  as(platform);
});

describe('browserOpenInvocation', () => {
  it('uses open on macOS and xdg-open elsewhere on POSIX', () => {
    as('darwin');
    expect(browserOpenInvocation('http://127.0.0.1:4782')).toEqual({
      command: 'open',
      args: ['http://127.0.0.1:4782'],
    });

    as('linux');
    expect(browserOpenInvocation('http://127.0.0.1:4782')).toEqual({
      command: 'xdg-open',
      args: ['http://127.0.0.1:4782'],
    });
  });

  it('never spawns `start` by name — it is a cmd builtin, not a program', () => {
    as('win32');
    const invocation = browserOpenInvocation('http://127.0.0.1:4782');

    expect(invocation.command).not.toBe('start');
    expect(invocation.command.toLowerCase()).toContain('cmd');
  });

  it('gives `start` the empty title it reads before the URL', () => {
    as('win32');
    const args = browserOpenInvocation('http://127.0.0.1:4782').args;

    // Without `""`, `start` takes the URL as the window title and opens a console
    // window instead of a browser.
    const startAt = args.indexOf('start');
    expect(startAt).toBeGreaterThanOrEqual(0);
    expect(args[startAt + 1]).toBe('""');
    expect(args[startAt + 2]).toBe('http://127.0.0.1:4782');
  });
});
