import { describe, it, expect } from 'vitest';
import {
  PARENT_SESSION_NAMES,
  agentEnvironment,
  droppedNames,
} from '../../src/core/process-environment.js';

/**
 * PRI-17 — what a coding agent inherits.
 *
 * Every case below is a name that was measured passing through, or a name that must keep
 * passing. The allowlist's failure modes are asymmetric and both are bad in a way tests
 * can catch: too narrow breaks authentication weeks later on somebody else's machine, too
 * wide hands a model reading an untrusted repository a cloud credential.
 *
 * `scripts/env-allowlist-probe.ts` is the other half — it runs the real CLIs under this
 * environment, because a list of names cannot prove a CLI still logs in.
 */

const HOSTILE = {
  AWS_SECRET_ACCESS_KEY: 'AKIA-not-real',
  AWS_SESSION_TOKEN: 'token',
  DATABASE_URL: 'postgres://user:pw@host/db',
  GITHUB_TOKEN: 'ghp_x',
  GH_TOKEN: 'ghp_y',
  NPM_TOKEN: 'npm_z',
  SLACK_BOT_TOKEN: 'xoxb-1',
  KUBECONFIG: '/home/me/.kube/config',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  STRIPE_SECRET_KEY: 'sk_live_1',
};

describe('what a coding agent is given', () => {
  it('passes what a process needs to be a process', () => {
    const { env } = agentEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/me',
      SHELL: '/bin/zsh',
      USER: 'me',
      TMPDIR: '/tmp',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    });

    expect(Object.keys(env).sort()).toEqual([
      'HOME',
      'LANG',
      'LC_ALL',
      'PATH',
      'SHELL',
      'TERM',
      'TMPDIR',
      'USER',
    ]);
  });

  it('passes the vendor credentials the runners exist to use', () => {
    const { env, dropped } = agentEnvironment({
      ANTHROPIC_API_KEY: 'a',
      OPENAI_API_KEY: 'b',
      OPENAI_BASE_URL: 'http://localhost:8151/v1',
      GEMINI_API_KEY: 'c',
      GOOGLE_APPLICATION_CREDENTIALS: '/home/me/gcp.json',
      AGENT_FLOW_UTILITY_MODEL_API_KEY: 'd',
    });

    expect(dropped).toEqual([]);
    expect(Object.keys(env)).toHaveLength(6);
  });

  it('passes a proxy and a certificate authority, or nothing authenticates behind one', () => {
    const { dropped } = agentEnvironment({
      HTTPS_PROXY: 'http://proxy:3128',
      https_proxy: 'http://proxy:3128',
      NO_PROXY: 'localhost',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
      SSL_CERT_FILE: '/etc/ssl/cert.pem',
    });

    expect(dropped).toEqual([]);
  });

  it('drops every credential that has nothing to do with the task', () => {
    const { env, dropped } = agentEnvironment({ PATH: '/usr/bin', HOME: '/home/me', ...HOSTILE });

    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH']);
    expect(dropped).toEqual(Object.keys(HOSTILE).sort());
  });

  it('drops SSH agent access, which is a capability rather than an oversight', () => {
    // An agent with `SSH_AUTH_SOCK` can push with the operator's key. Git keeps it —
    // `git-command.ts` asks for `inherit` — so signing and remotes are unaffected; what
    // loses it is the agent's own shell.
    expect(droppedNames({ SSH_AUTH_SOCK: '/tmp/agent.sock' })).toEqual(['SSH_AUTH_SOCK']);
  });

  it('reports dropped names, never dropped values', () => {
    const dropped = droppedNames({ AWS_SECRET_ACCESS_KEY: 'the-actual-secret' });

    expect(dropped).toEqual(['AWS_SECRET_ACCESS_KEY']);
    expect(JSON.stringify(dropped)).not.toContain('the-actual-secret');
  });
});

describe('the parent session, which is not a credential', () => {
  it('drops the calling agent session, so a spawned one starts fresh', () => {
    // Measured by running the probe from inside a Claude Code session, which is an
    // ordinary way to use this tool. The vendor prefix passed a session id, a socket and
    // a token addressed to the *parent* — §3.6 promises fresh contexts, and an executor
    // holding a channel back to the orchestrating session has left one.
    const { env, dropped } = agentEnvironment({
      ANTHROPIC_API_KEY: 'keep-me',
      CLAUDE_CODE_SESSION_ID: 's',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 't',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
    });

    expect(Object.keys(env)).toEqual(['ANTHROPIC_API_KEY']);
    expect(dropped).toContain('CLAUDE_CODE_MESSAGING_TOKEN');
  });

  it('drops an inherited effort, because effort is a kernel decision', () => {
    // PRI-03. The role's configuration decides effort, `clampReasoning` narrows it to what
    // the (runner, model) pair supports, and `reasoningClamped` records the difference. An
    // inherited variable that outranked the flag would reintroduce silently exactly the
    // defect `docs/runner-capabilities.md` records against AGY.
    expect(droppedNames({ CLAUDE_EFFORT: 'low' })).toEqual(['CLAUDE_EFFORT']);
  });

  it('lets the operator override the session exceptions, but not by accident', () => {
    const { env } = agentEnvironment(
      { CLAUDE_CODE_SESSION_ID: 's' },
      {},
      { pass: ['CLAUDE_CODE_SESSION_ID'] },
    );

    expect(env['CLAUDE_CODE_SESSION_ID']).toBe('s');
  });

  it('names every session exception in one exported list', () => {
    // Exported so the probe checks against this rather than against its own copy. A probe
    // holding a second list would pass by agreeing with itself.
    expect(PARENT_SESSION_NAMES).toContain('CLAUDE_CODE_MESSAGING_TOKEN');
    expect(new Set(PARENT_SESSION_NAMES).size).toBe(PARENT_SESSION_NAMES.length);
  });
});

describe('what the operator declares', () => {
  it('passes an exact name', () => {
    const { env } = agentEnvironment({ MY_TOOL_HOME: '/opt/tool' }, {}, { pass: ['MY_TOOL_HOME'] });

    expect(env['MY_TOOL_HOME']).toBe('/opt/tool');
  });

  it('passes a prefix, which is what a trailing underscore means', () => {
    const { env, dropped } = agentEnvironment(
      { ACME_TOKEN: 'a', ACME_REGION: 'b', OTHER_TOKEN: 'c' },
      {},
      { pass: ['ACME_'] },
    );

    expect(Object.keys(env).sort()).toEqual(['ACME_REGION', 'ACME_TOKEN']);
    expect(dropped).toEqual(['OTHER_TOKEN']);
  });

  it('does not read a declared name as a prefix', () => {
    // `MY_VAR` must not admit `MY_VAR_SECRET`. The trailing underscore is the whole
    // grammar, and a list somebody has to audit cannot have an implicit second meaning.
    const { env } = agentEnvironment(
      { MY_VAR: 'a', MY_VAR_SECRET: 'b' },
      {},
      { pass: ['MY_VAR'] },
    );

    expect(Object.keys(env)).toEqual(['MY_VAR']);
  });
});

describe('the mechanics', () => {
  it('applies overrides last, and unconditionally', () => {
    // A value this process computed for the child is not subject to a list about what the
    // *parent's* environment may contribute.
    const { env } = agentEnvironment({ PATH: '/usr/bin' }, { AF_TASK_ID: 'TASK-001', PATH: '/x' });

    expect(env['AF_TASK_ID']).toBe('TASK-001');
    expect(env['PATH']).toBe('/x');
  });

  it('neither passes nor reports a variable whose value is undefined', () => {
    // `process.env`'s type admits `undefined`, and on some Node versions that reaches
    // `spawn` as the literal string "undefined". There was nothing there to drop.
    const { env, dropped } = agentEnvironment({ NOTHING: undefined, PATH: '/usr/bin' });

    expect(env).toEqual({ PATH: '/usr/bin' });
    expect(dropped).toEqual([]);
  });

  it('returns dropped names sorted, so a diff of two runs is readable', () => {
    const dropped = droppedNames({ ZULU: '1', ALPHA: '2', MIKE: '3' });

    expect(dropped).toEqual(['ALPHA', 'MIKE', 'ZULU']);
  });
});
