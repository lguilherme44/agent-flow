import { describe, it, expect } from 'vitest';
import { win32, posix } from 'node:path';
import { autostartEntry } from '../../src/cli/autostart.js';

/**
 * `agent-flow autostart install` — the dashboard up at logon, so opening it is a bookmark
 * rather than `cd` into a project and a command.
 *
 * What is asserted is the file each platform's session manager reads, because that is the
 * whole product here: a quoting mistake in it is a dashboard that silently never starts.
 */

describe('autostartEntry on Windows', () => {
  const entry = autostartEntry({
    platform: 'win32',
    node: 'C:\\Users\\Me\\AppData\\Local\\nvm\\v22.23.2\\node.exe',
    script: 'C:\\Users\\Me\\wk\\agent flow\\dist\\bin\\agent-flow.js',
    uiArgs: ['--config', 'C:\\Users\\Me\\.agent-flow\\config.yaml', 'ui', '--no-open'],
    home: 'C:\\Users\\Me',
    appData: 'C:\\Users\\Me\\AppData\\Roaming',
    log: 'C:\\Users\\Me\\.agent-flow\\ui.log',
    pathEnv: 'C:\\Windows',
  });

  it('lands in the per-user Startup folder, which needs no administrator', () => {
    expect(entry.path).toBe(
      win32.join('C:\\Users\\Me\\AppData\\Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'agent-flow-ui.vbs'),
    );
  });

  it('runs hidden, without waiting, from the home directory', () => {
    // Window style 0 is hidden and `False` is "do not wait": a console window left open at
    // every logon is the kind of thing that gets the entry deleted by hand.
    expect(entry.content).toContain('shell.CurrentDirectory = "C:\\Users\\Me"');
    expect(entry.content).toMatch(/, 0, False\r?\n/);
  });

  it('quotes every path, including one with a space, for both VBScript and cmd', () => {
    // The VBScript literal doubles its quotes; what it hands `cmd /s /c` is the command
    // wrapped in one more pair, which `/s` strips. Written out, not assembled in the head.
    expect(entry.content).toContain(
      'shell.Run "cmd.exe /d /s /c """"C:\\Users\\Me\\AppData\\Local\\nvm\\v22.23.2\\node.exe"" ' +
        '""C:\\Users\\Me\\wk\\agent flow\\dist\\bin\\agent-flow.js"" ""--config"" ""C:\\Users\\Me\\.agent-flow\\config.yaml"" ' +
        '""ui"" ""--no-open"" > ""C:\\Users\\Me\\.agent-flow\\ui.log"" 2>&1"""',
    );
  });

  it('says what wrote it and how to remove it', () => {
    expect(entry.content).toContain('agent-flow autostart uninstall');
  });
});

describe('autostartEntry on macOS', () => {
  const entry = autostartEntry({
    platform: 'darwin',
    node: '/Users/me/.nvm/versions/node/v22.1.0/bin/node',
    script: '/Users/me/wk/agent-flow/dist/bin/agent-flow.js',
    uiArgs: ['ui', '--no-open'],
    home: '/Users/me',
    appData: undefined,
    log: '/Users/me/.agent-flow/ui.log',
    pathEnv: '/opt/homebrew/bin:/usr/bin:/bin',
  });

  it('is a LaunchAgent that starts at load', () => {
    expect(entry.path).toBe(posix.join('/Users/me', 'Library', 'LaunchAgents', 'dev.agent-flow.ui.plist'));
    expect(entry.content).toContain('<key>RunAtLoad</key>\n  <true/>');
  });

  it('carries the PATH it was installed with, because launchd starts agents with almost none', () => {
    // Without it the dashboard starts, and every run it launches fails to find `claude`,
    // `agy` or `git` — the dashboard would look healthy and every action would break.
    expect(entry.content).toContain('<key>PATH</key>\n      <string>/opt/homebrew/bin:/usr/bin:/bin</string>');
  });

  it('passes the arguments as separate strings, escaped as XML', () => {
    const odd = autostartEntry({
      platform: 'darwin',
      node: '/n/node',
      script: '/a&b/agent-flow.js',
      uiArgs: ['ui'],
      home: '/Users/me',
      appData: undefined,
      log: '/l',
      pathEnv: '',
    });
    expect(odd.content).toContain('<string>/n/node</string>\n    <string>/a&amp;b/agent-flow.js</string>\n    <string>ui</string>');
  });
});

describe('autostartEntry elsewhere', () => {
  it('says it is not supported rather than writing something nothing reads', () => {
    expect(() =>
      autostartEntry({ platform: 'linux', node: '/n', script: '/s', uiArgs: [], home: '/h', appData: undefined, log: '/l', pathEnv: '' }),
    ).toThrow(/not supported/);
  });
});
