/**
 * Does every installed coding CLI still work with the environment Agent Flow now gives it?
 *
 * `core/process-environment.ts` replaced `{ ...process.env }` with a list of what a runner
 * needs (PRI-17). The failure mode of that change is silent and remote: a CLI that stops
 * authenticating weeks later, on somebody else's machine, diagnosed as anything but an
 * allowlist. The only honest way to hold the list to its claim is to run the CLIs under it.
 *
 * Two passes, and the first is free:
 *
 *   1. **What is dropped**, by name. Any vendor-shaped name in that list is a bug in the
 *      allowlist, and this finds it without spending a token.
 *   2. **A real invocation**, under the built environment and nothing else. `--version`
 *      proves the process starts; the auth probe proves the credential survived. Both are
 *      the smallest call each CLI accepts.
 *
 * Imports the source rather than a bundle, because there is no library entry point — the
 * package ships a CLI. That needs a Node that strips types, which is Node 22.6+ behind a
 * flag and Node 23+ by default. This is a manual evidence script, not a CI gate, so the
 * requirement is the maintainer's Node rather than the package's `engines` floor.
 *
 *   node --experimental-strip-types scripts/env-allowlist-probe.ts
 *   node --experimental-strip-types scripts/env-allowlist-probe.ts --live
 */

import { spawnSync } from 'node:child_process';
import { PARENT_SESSION_NAMES, agentEnvironment } from '../src/core/process-environment.ts';

const LIVE = process.argv.includes('--live');
const { env: allowed, dropped } = agentEnvironment(process.env, {});

/** Names that look like they carry a vendor credential the runners need. */
const VENDOR_SHAPED =
  /^(ANTHROPIC|CLAUDE|OPENAI|CODEX|GEMINI|GOOGLE|AGY|ANTIGRAVITY|OPENCODE|AGENT_FLOW|AF)_/i;

console.log('── pass 1 · what the allowlist does on this machine\n');
console.log(`  parent variables   ${String(Object.keys(process.env).length)}`);
console.log(`  passed through     ${String(Object.keys(allowed).length)}`);
console.log(`  dropped            ${String(dropped.length)}`);

// Imported rather than restated: a probe with its own copy of the exception list would
// pass by agreeing with itself. These are dropped on purpose — a parent session's handle
// or a kernel-owned setting, never a credential.
const deliberate = new Set<string>(PARENT_SESSION_NAMES);
const wrongly = dropped.filter((name) => VENDOR_SHAPED.test(name) && !deliberate.has(name));
if (wrongly.length > 0) {
  console.error(`\n  ✗ vendor-shaped names were dropped: ${wrongly.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\n  ✓ no vendor-shaped name was dropped');
}

console.log('\n  passed:');
for (const name of Object.keys(allowed).sort()) console.log(`    ${name}`);
console.log('\n  dropped:');
for (const name of dropped) {
  console.log(`    ${name}${deliberate.has(name) ? '   ← deliberate: parent session' : ''}`);
}

if (!LIVE) {
  console.log('\n(pass 2 skipped — re-run with --live to invoke the CLIs)');
  process.exit(process.exitCode ?? 0);
}

/**
 * The smallest call each CLI accepts that proves it authenticated.
 *
 * Kept tiny on purpose: the question is "did the credential survive the allowlist", and a
 * one-word answer settles it as well as a paragraph would.
 */
const PROBES = [
  { id: 'claude', version: ['--version'], auth: ['-p', 'Reply with the single word: ok'] },
  {
    id: 'codex',
    version: ['--version'],
    auth: ['exec', '--skip-git-repo-check', 'Reply with the single word: ok'],
  },
  { id: 'agy', version: ['--version'], auth: ['-p', 'Reply with the single word: ok'] },
  { id: 'gemini', version: ['--version'], auth: ['-p', 'Reply with the single word: ok'] },
  { id: 'opencode', version: ['--version'], auth: ['run', 'Reply with the single word: ok'] },
] as const;

console.log('\n── pass 2 · the CLIs, under that environment and nothing else\n');

const rows: { runner: string; version: string; auth: string }[] = [];

for (const probe of PROBES) {
  const found = spawnSync('command', ['-v', probe.id], { shell: true, encoding: 'utf8' });
  if (found.status !== 0) {
    rows.push({ runner: probe.id, version: '—', auth: 'not installed' });
    continue;
  }

  const version = spawnSync(probe.id, [...probe.version], {
    env: allowed,
    encoding: 'utf8',
    timeout: 60_000,
  });

  if (version.status !== 0) {
    rows.push({
      runner: probe.id,
      version: `FAILED (${String(version.status)})`,
      auth: 'not attempted',
    });
    process.exitCode = 1;
    continue;
  }

  const auth = spawnSync(probe.id, [...probe.auth], {
    env: allowed,
    encoding: 'utf8',
    timeout: 180_000,
    input: '',
  });

  const said = `${auth.stdout ?? ''}${auth.stderr ?? ''}`;
  const refused = /not logged in|unauthori|please authenticate|missing api key|no credential/i;
  const authenticated = auth.status === 0 && !refused.test(said);

  if (authenticated) {
    rows.push({
      runner: probe.id,
      version: (version.stdout ?? '').trim().split('\n')[0] ?? '',
      auth: `ok — said "${said.trim().slice(0, 40).replace(/\s+/g, ' ')}"`,
    });
    continue;
  }

  // **The control, and without it this probe cries wolf.** A CLI can fail for reasons
  // that have nothing to do with an environment: a deprecated account tier, a local
  // inference endpoint that is not running, an expired login. Measured here on the first
  // run — two of five refused, both identically with the full environment.
  //
  // So the question is never "did it fail" but "did it fail *because of this list*", and
  // the only thing that answers it is running the same call again with everything.
  const control = spawnSync(probe.id, [...probe.auth], {
    env: process.env,
    encoding: 'utf8',
    timeout: 180_000,
    input: '',
  });

  const controlSaid = `${control.stdout ?? ''}${control.stderr ?? ''}`;
  const controlWorks = control.status === 0 && !refused.test(controlSaid);

  if (controlWorks) process.exitCode = 1;

  rows.push({
    runner: probe.id,
    version: (version.stdout ?? '').trim().split('\n')[0] ?? '',
    auth: controlWorks
      ? `BROKEN BY THE ALLOWLIST — ${said.trim().slice(0, 90).replace(/\s+/g, ' ')}`
      : `already broken — ${controlSaid.trim().slice(0, 90).replace(/\s+/g, ' ')}`,
  });
}

for (const row of rows) {
  console.log(`  ${row.runner.padEnd(10)} ${row.version.padEnd(24)} ${row.auth}`);
}

console.log(
  process.exitCode === 1
    ? '\n✗ at least one runner works with the full environment and not with this one'
    : '\n✓ no runner was broken by the allowlist',
);
