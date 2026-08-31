/**
 * What a child process is allowed to inherit (PRI-17).
 *
 * Agent Flow spawns coding CLIs, and a coding CLI is a program with a model inside it
 * reading a repository somebody else wrote. Until this module existed, every one of them
 * received `{ ...process.env }` — the orchestrator's whole environment, including every
 * credential that has nothing to do with the task: cloud keys, database URLs, registry
 * tokens, whatever the operator's shell exports.
 *
 * That is not a hypothetical. `docs/security/THREAT_MODEL.md` lists repository content
 * influencing a model (T6, T7) as in scope and unpreventable — the model reads the repo,
 * that is the job. What *is* preventable is how much a successfully-influenced model can
 * reach for.
 *
 * **The allowlist is a list of things the runners need, not a list of things that are
 * dangerous.** A denylist of credential-shaped names is a race against every product that
 * ever invents an environment variable; this direction fails closed.
 *
 * Pure. It takes an environment and returns one, so the decision table is testable without
 * spawning anything and the same function answers `doctor`'s "what would be dropped".
 */

/**
 * Exact names every child needs to be a working process on its platform.
 *
 * Each group is here because removing it breaks something specific, and the comment says
 * what — an allowlist nobody can justify line by line grows into `process.env` again.
 */
const PLATFORM_NAMES: readonly string[] = [
  // Finding an executable, and being a user.
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  // Temporary files. A CLI that writes a scratch file with none of these set writes it
  // somewhere surprising, or fails.
  'TMPDIR',
  'TMP',
  'TEMP',
  // Terminal behaviour. Absent `TERM`, some CLIs emit control sequences for a terminal
  // that is not there, which lands in the persisted log.
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  // Locale and time. Output parsed by an adapter changes shape with these.
  'LANG',
  'LANGUAGE',
  'TZ',
  // macOS sets this and some tools read it for encoding.
  '__CF_USER_TEXT_ENCODING',
  // Windows is Tier 2, and a process there without these does not start at all. Listed so
  // the allowlist is not the reason it fails.
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
];

/**
 * Reaching the network the way the operator's machine does.
 *
 * A corporate proxy or a custom certificate authority is configured entirely here, and a
 * CLI that cannot see them fails to authenticate with an error about TLS that nobody
 * traces back to an allowlist.
 */
const NETWORK_NAMES: readonly string[] = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
];

/**
 * The runtimes the shipped CLIs are built on.
 *
 * `NODE_OPTIONS` is here and it is the uncomfortable one: it can inject a `--require` into
 * every Node process the child starts. It stays because it is the operator's own value,
 * set in the operator's own shell, and dropping it breaks the corporate setups that need
 * it — the threat this module addresses is an agent reaching for credentials it was never
 * given, not an operator attacking themselves.
 */
const RUNTIME_PREFIXES: readonly string[] = [
  'NODE_',
  'NPM_CONFIG_',
  'NVM_',
  'BUN_',
  'DENO_',
  'PYTHON',
  'VIRTUAL_ENV',
  'XDG_',
];

/**
 * Vendor authentication, by prefix.
 *
 * These are credentials, and they are here on purpose: they are the ones the runner is
 * *for*. An adapter that cannot authenticate is not a security win, it is an outage.
 *
 * Prefixes rather than exact names because every one of these vendors ships new variables
 * between releases, and a runner that stopped authenticating after a CLI upgrade would be
 * diagnosed as anything but this file.
 */
const VENDOR_PREFIXES: readonly string[] = [
  'ANTHROPIC_',
  'CLAUDE_',
  'OPENAI_',
  'CODEX_',
  'GEMINI_',
  'GOOGLE_',
  'GOOGLE_APPLICATION_',
  'AGY_',
  'ANTIGRAVITY_',
  'OPENCODE_',
  'AGENT_FLOW_',
  'AF_',
];

/**
 * Vendor variables that identify the *calling* agent session rather than authenticate it.
 *
 * Found by running the probe from inside a Claude Code session, which is a perfectly
 * ordinary way to use this tool: the vendor prefixes above passed `CLAUDE_CODE_SESSION_ID`,
 * `CLAUDE_CODE_CHILD_SESSION` and — the one that matters — `CLAUDE_CODE_MESSAGING_SOCKET`
 * and `CLAUDE_CODE_MESSAGING_TOKEN`, a token and a socket addressed to the parent session.
 *
 * Handing those to a spawned agent is the opposite of what §3.6 promises. Agent Flow
 * separates planning, execution and review into *fresh* contexts precisely so a wrong
 * assumption cannot travel between them; an executor that inherits the orchestrating
 * session's identity, and a channel back to it, has travelled.
 *
 * A short exception list rather than narrower prefixes, because the prefixes are what keep
 * authentication working across vendor releases and these are the few names that are
 * demonstrably not authentication. Each is a session handle or an IPC endpoint, and an
 * agent that needs one of these needs its own, not its parent's.
 */
export const PARENT_SESSION_NAMES: readonly string[] = [
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CODEX_SESSION_ID',
  'OPENCODE_SESSION_ID',
  'AGY_SESSION_ID',
  // Effort is a kernel decision (PRI-03). It is resolved from the role's configuration,
  // clamped against what the (runner, model) pair supports, and recorded as
  // `reasoningClamped` when the two differ — and `docs/runner-capabilities.md` records
  // what it costs when that goes unnoticed: an AGY invocation was accepted, the effort was
  // not the one requested, and nothing said so. An inherited variable that quietly
  // outranks the flag would reintroduce exactly that, invisibly.
  'CLAUDE_EFFORT',
  'CODEX_EFFORT',
];

export interface EnvironmentPolicy {
  /**
   * Extra names or prefixes the operator declared, from `execution.passEnv`.
   *
   * An entry ending in `_` is a prefix; anything else is an exact name. Deliberately not a
   * regular expression: this is a list somebody has to be able to read and audit, and a
   * pattern that matched more than intended would be invisible.
   */
  readonly pass?: readonly string[];
}

export interface FilteredEnvironment {
  readonly env: Record<string, string>;
  /**
   * The names that were dropped, sorted.
   *
   * Names, never values. Returned rather than logged here — this module is pure, and the
   * caller decides whether an operator seeing "37 variables were not passed through" is
   * useful (it is, in `doctor`) or noise (it is, on every spawn).
   */
  readonly dropped: readonly string[];
}

function matches(name: string, exact: ReadonlySet<string>, prefixes: readonly string[]): boolean {
  if (exact.has(name)) return true;
  return prefixes.some((prefix) => name.startsWith(prefix));
}

/**
 * The environment a coding agent is given.
 *
 * `overrides` are applied last and unconditionally: a value this process computed for the
 * child is not subject to a list about what the *parent's* environment may contribute.
 */
export function agentEnvironment(
  parent: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string>> = {},
  policy: EnvironmentPolicy = {},
): FilteredEnvironment {
  const declared = policy.pass ?? [];

  const exact = new Set<string>([
    ...PLATFORM_NAMES,
    ...NETWORK_NAMES,
    ...declared.filter((entry) => !entry.endsWith('_')),
  ]);
  const prefixes = [
    ...RUNTIME_PREFIXES,
    ...VENDOR_PREFIXES,
    // `LC_ALL`, `LC_CTYPE` and the rest. A prefix, because the set is defined by POSIX
    // and grows.
    'LC_',
    ...declared.filter((entry) => entry.endsWith('_')),
  ];

  const env: Record<string, string> = {};
  const dropped: string[] = [];

  // An operator who named one in `execution.passEnv` gets it: the exception list is a
  // default about vendor session handles, not a policy the operator may not override.
  const denied = new Set(
    PARENT_SESSION_NAMES.filter((name) => !declared.includes(name)),
  );

  for (const [name, value] of Object.entries(parent)) {
    // `undefined` values exist in `process.env`'s type and would reach `spawn` as the
    // string "undefined" on some Node versions. Neither passed nor reported as dropped:
    // there was nothing there.
    if (value === undefined) continue;

    if (!denied.has(name) && matches(name, exact, prefixes)) {
      env[name] = value;
    } else {
      dropped.push(name);
    }
  }

  dropped.sort();
  return { env: { ...env, ...overrides }, dropped };
}

/**
 * What {@link agentEnvironment} would refuse to pass, without building the environment.
 *
 * For `doctor`, which reports the count and the names so that a runner failing to
 * authenticate has one obvious thing to check.
 */
export function droppedNames(
  parent: NodeJS.ProcessEnv,
  policy: EnvironmentPolicy = {},
): readonly string[] {
  return agentEnvironment(parent, {}, policy).dropped;
}
