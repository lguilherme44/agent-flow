import { describe, it, expect } from 'vitest';
import {
  HOME_PLACEHOLDER,
  SECRET_PLACEHOLDER,
  WORKSPACE_PLACEHOLDER,
  redactAndTruncate,
  redactAndTruncateTail,
  redactEvidence,
} from '../../src/core/evidence-redaction.js';

/**
 * The invariant this suite exists for is I-21: *no persisted artifact, event or HTTP
 * response contains an unredacted runner output.*
 *
 * AD-33 and AD-34 open three new persistence paths for third-party text, so the
 * interesting tests are not "does it replace a token" but the ones a careless
 * implementation gets wrong: ordering between substitutions, a path that contains regex
 * metacharacters, a nested root replaced by its parent, and a truncation that cuts a
 * secret in half and leaves the readable prefix on disk.
 */

describe('credential shapes', () => {
  it('removes a bearer token and keeps the header name', () => {
    // The name is diagnostic and safe; the value is not. Removing both would make a
    // redacted log unreadable, which is how redaction ends up being switched off.
    const out = redactEvidence('Authorization: Bearer abcdef0123456789xyz');
    expect(out).toContain('Authorization');
    expect(out).toContain(SECRET_PLACEHOLDER);
    expect(out).not.toContain('abcdef0123456789xyz');
  });

  it.each([
    ['sk-0123456789abcdefghij', 'an API key prefix'],
    ['ghp_0123456789abcdefghij', 'a personal access token'],
    ['xoxb-0123456789-abcdefgh', 'a workspace token'],
    ['AIzaSyA0123456789abcdefgh', 'a cloud API key'],
  ])('removes %s (%s)', (secret) => {
    const out = redactEvidence(`the CLI reported: ${secret} was rejected`);
    expect(out).not.toContain(secret);
    expect(out).toContain(SECRET_PLACEHOLDER);
  });

  it.each([
    'api_key = "0123456789abcdef"',
    'apiKey: 0123456789abcdef',
    'ACCESS_TOKEN=0123456789abcdef',
    "client_secret: '0123456789abcdef'",
    'password: hunter2hunter2',
  ])('removes an assigned secret: %s', (line) => {
    const out = redactEvidence(line);
    expect(out).not.toContain('0123456789abcdef');
    expect(out).not.toContain('hunter2hunter2');
    expect(out).toContain(SECRET_PLACEHOLDER);
  });

  it('removes credentials from a URL authority and keeps the host', () => {
    const out = redactEvidence('cloning https://user:s3cr3tpassword@example.com/repo.git');
    expect(out).not.toContain('s3cr3tpassword');
    expect(out).toContain('example.com/repo.git');
  });

  it('removes a private key as a whole block, leaving no fragment', () => {
    const key = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU',
      'AAAAEG5vbmUAAAAAAAAAAAEAAAAzAAA',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');

    const out = redactEvidence(`stderr:\n${key}\ndone`);
    expect(out).not.toContain('b3BlbnNzaC1rZXktdjEAAAAABG5vbmU');
    expect(out).not.toContain('AAAAEG5vbmUAAAAAAAAAAAEAAAAzAAA');
    expect(out).toContain('done');
  });

  it('leaves a Git object id alone', () => {
    // The property that rules out entropy heuristics. A tree hash looks exactly like a
    // secret to one, and redacting it would destroy the evidence AD-38's assertion reads.
    const oid = 'a'.repeat(39) + '7';
    expect(redactEvidence(`validatedTree ${oid}`)).toContain(oid);
  });

  it('leaves an ordinary sentence untouched', () => {
    const text = 'soft-denying tool confirmation "Bash": permission check failed';
    expect(redactEvidence(text)).toBe(text);
  });
});

describe('paths', () => {
  const context = {
    workspaceRoot: '/home/dev/.agent-flow/worktrees/repo-abc/AF-2026-002/TASK-001/attempt-1',
    home: '/home/dev',
  };

  it('replaces the worktree root before the home directory', () => {
    // Load-bearing ordering. The worktree lives *under* the home directory, so
    // substituting `<home>` first would leave the run-specific remainder — the part that
    // identifies a machine's layout and a run's namespace — sitting in the output.
    const out = redactEvidence(`FAIL ${context.workspaceRoot}/test/cli/cli.test.ts`, context);

    expect(out).toBe(`FAIL ${WORKSPACE_PLACEHOLDER}/test/cli/cli.test.ts`);
    expect(out).not.toContain('/home/dev');
    expect(out).not.toContain('AF-2026-002');
  });

  it('replaces the home directory when the path is outside any worktree', () => {
    const out = redactEvidence('reading /home/dev/.gemini/antigravity-cli/log/', context);
    expect(out).toBe(`reading ${HOME_PLACEHOLDER}/.gemini/antigravity-cli/log/`);
  });

  it('handles a root containing regex metacharacters', () => {
    // Substitution is literal, not pattern-based. A directory called `my+project (2)` is
    // ordinary on a laptop and would make a regex-built replacement either throw or
    // silently match nothing — and silently matching nothing is a leak that tests pass.
    const out = redactEvidence('at /tmp/my+project (2)/src/index.ts', {
      workspaceRoot: '/tmp/my+project (2)',
    });
    expect(out).toBe(`at ${WORKSPACE_PLACEHOLDER}/src/index.ts`);
  });

  it('ignores a trailing separator on the configured root', () => {
    const out = redactEvidence('at /repo/src/index.ts', { workspaceRoot: '/repo/' });
    expect(out).toBe(`at ${WORKSPACE_PLACEHOLDER}/src/index.ts`);
  });

  it('replaces every occurrence, not just the first', () => {
    const out = redactEvidence('/repo/a.ts and /repo/b.ts', { workspaceRoot: '/repo' });
    expect(out).toBe(`${WORKSPACE_PLACEHOLDER}/a.ts and ${WORKSPACE_PLACEHOLDER}/b.ts`);
  });
});

describe('configured secret values', () => {
  it('removes a value the configuration named, whatever shape it has', () => {
    // The catch-all for secrets no pattern recognises. Values, never names: the name is
    // often the useful half of a diagnosis.
    const out = redactEvidence('the endpoint answered with lolcat-not-a-token-shape', {
      secretValues: ['lolcat-not-a-token-shape'],
    });
    expect(out).toBe(`the endpoint answered with ${SECRET_PLACEHOLDER}`);
  });

  it('ignores empty and whitespace-only values', () => {
    // Replacing the empty string rewrites every position in the text. An unset
    // environment variable reaching this list is ordinary, so it has to be inert.
    const text = 'nothing secret here';
    expect(redactEvidence(text, { secretValues: ['', '   ', '\n'] })).toBe(text);
  });
});

describe('truncation (AR §6.5)', () => {
  it('leaves text under the budget untouched and reports no truncation', () => {
    const result = redactAndTruncate('short', 1024);
    expect(result).toEqual({ text: 'short', truncated: false });
  });

  it('marks a truncation explicitly rather than cutting silently', () => {
    const result = redactAndTruncate('x'.repeat(5000), 200);

    expect(result.truncated).toBe(true);
    expect(result.text).toMatch(/truncated: 5000 bytes/);
    expect(new TextEncoder().encode(result.text).length).toBeLessThanOrEqual(200);
  });

  it('redacts before truncating, so no readable prefix of a secret survives', () => {
    // The ordering that matters most in this file. Cutting first can split a token and
    // leave its head on disk — and a partial credential is still a credential.
    const secret = 'ghp_0123456789abcdefghij';
    const result = redactAndTruncate(`${'padding '.repeat(20)}${secret}`, 64);

    expect(result.text).not.toContain('ghp_');
    expect(result.text).not.toContain('0123456789');
  });

  it('keeps the tail when the tail is where the answer is', () => {
    // A failing command's summary is at the end, which is why `failedChecks` keep the
    // tail while `rawExcerpt` keeps the head.
    const result = redactAndTruncateTail(`${'noise\n'.repeat(200)}FAIL 3 tests`, 120);

    expect(result.truncated).toBe(true);
    expect(result.text).toContain('FAIL 3 tests');
    expect(new TextEncoder().encode(result.text).length).toBeLessThanOrEqual(120);
  });

  it('counts bytes rather than characters', () => {
    // The budgets in §6.5 are byte budgets. Counting a multi-byte character as one would
    // overshoot them quietly — and the packet's ceiling exists because recovery context
    // is added to a prompt that is already near a limit.
    const multibyte = '✗'.repeat(100); // three bytes each
    const result = redactAndTruncate(multibyte, 120);

    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(result.text).length).toBeLessThanOrEqual(120);
  });

  it('never emits a replacement character from a mid-character cut', () => {
    const result = redactAndTruncate('é'.repeat(200), 101);
    expect(result.text).not.toContain('�');
  });

  it('is deterministic: the same input yields byte-identical output', () => {
    // AR-03 requires that an identical failure produces a byte-identical packet, and
    // every field in a packet passes through here first.
    const input = `Authorization: Bearer abc123456789 at /repo/src/x.ts`;
    const context = { workspaceRoot: '/repo' };

    expect(redactEvidence(input, context)).toBe(redactEvidence(input, context));
    expect(redactAndTruncate(input, 32, context)).toEqual(redactAndTruncate(input, 32, context));
  });
});

describe('purity', () => {
  it('is a function of its arguments alone', () => {
    // The module reaches no filesystem, no clock and no environment — so the same call
    // twice, with no context, cannot differ. Asserted because the machine facts it needs
    // are *passed in* precisely so this stays true.
    expect(redactEvidence('/home/dev/x')).toBe(redactEvidence('/home/dev/x'));
    // And with no context, a path it was never told about is not a secret it can guess.
    expect(redactEvidence('/home/dev/x')).toContain('/home/dev/x');
  });
});
