import { roleConfigOf, type ProjectConfig, type RolesConfig } from '../contracts/index.js';
import { STANDARD_STEPS, buildValidationRegistry } from './validation-registry.js';
import { capabilitiesOf, type RunnerCapabilitiesMap } from './role.js';
import type { RunnerCapabilities } from '../ports/agent-runner.js';

/**
 * Which declared commands the executor may be granted, and what it may run as a result.
 *
 * Pure. The decision of *which lines are safe to grant* contains no provider word, so it
 * lives here; how a grant is spelled for a given CLI, and how an operator's own grants are
 * read, is adapter vocabulary and stays below the port (AD-13).
 *
 * The trust boundary is the one `validation-registry` already draws: a grant comes only from
 * configuration a human wrote, never from a plan (SEC-003).
 */

/** Why a declared line gets no grant (FR-004). */
export type CommandGrantExclusionReason = 'install' | 'empty' | 'line_break' | 'wildcard' | 'shell_syntax';

export interface CommandGrantExclusion {
  readonly id: string;
  readonly line: string;
  readonly reason: CommandGrantExclusionReason;
}

export interface CommandGrants {
  /** The grantable lines, in registry id order, each once. Empty when untrusted (SEC-001). */
  readonly granted: readonly string[];
  /** Every declared line that gets no grant, with the reason, in id order. */
  readonly excluded: readonly CommandGrantExclusion[];
}

/**
 * Characters that would make a prefix grant broader than the line it came from (SEC-002).
 *
 * A prefix grant allows the line followed by anything. With `&`, `|` or `;` in the line that
 * "anything" is a second command; with `<`, `>` or a backtick it is a redirection or a
 * substitution; `$`, `%`, `(` and `)` expand to something the line's author never read; and a
 * quote changes where a word ends, so the prefix no longer means what it looks like.
 */
const SHELL_SYNTAX = /[&|;<>`$()"'%]/;
const WILDCARD = /[*?]/;
const LINE_BREAK = /[\r\n]/;

function exclusionOf(id: string, line: string): CommandGrantExclusionReason | undefined {
  // `install` first, whatever it contains: it is a preparation step Agent Flow runs before the
  // executor starts, and granting it would let an agent reinstall dependencies mid-task —
  // network and minutes spent to observe nothing.
  if (id === 'install') return 'install';
  if (line.length === 0) return 'empty';
  if (LINE_BREAK.test(line)) return 'line_break';
  if (WILDCARD.test(line)) return 'wildcard';
  if (SHELL_SYNTAX.test(line)) return 'shell_syntax';
  return undefined;
}

/**
 * Ids a project declared with a blank command.
 *
 * The registry drops them, which is right for a plan and wrong for `doctor`: a line somebody
 * wrote and that grants nothing should be named, not vanish. An id the registry still
 * resolves — a blank standard step overridden by a `validationCommands` entry — is not blank.
 */
function blankIds(project: ProjectConfig, has: (id: string) => boolean): string[] {
  const declared: Array<readonly [string, string | undefined]> = [
    ...STANDARD_STEPS.map((step) => [step, project.commands[step]] as const),
    ...Object.entries(project.validationCommands),
  ];
  return declared
    .filter(([id, command]) => command !== undefined && command.trim().length === 0 && !has(id))
    .map(([id]) => id);
}

/**
 * The declared lines the executor may be granted, and those it may not (FR-001, FR-004).
 *
 * Read over the validation registry — `commands.install|lint|typecheck|test|build` and every
 * `validationCommands` entry, trimmed, in its sorted id order — so the lines granted are
 * exactly the lines a plan can name, and two ids sharing a line grant it once.
 *
 * `trusted` is `EffectiveConfig.projectTrusted`. Untrusted grants nothing (SEC-001): N4
 * refuses the same breadth when it arrives as runner `args`, and a repository that could
 * grant its executor commands by declaring them would walk around that screen. Exclusions
 * are still reported, so `doctor` names a bad line whether or not the project is trusted.
 */
export function commandGrantsFor(project: ProjectConfig | undefined, trusted: boolean): CommandGrants {
  if (project === undefined) return { granted: [], excluded: [] };

  const registry = buildValidationRegistry(project);
  const ids = [...registry.ids, ...blankIds(project, (id) => registry.has(id))].sort();

  const granted: string[] = [];
  const excluded: CommandGrantExclusion[] = [];
  for (const id of ids) {
    const line = registry.resolve(id) ?? '';
    const reason = exclusionOf(id, line);
    if (reason !== undefined) excluded.push({ id, line, reason });
    else if (!granted.includes(line)) granted.push(line);
  }

  return { granted: trusted ? granted : [], excluded };
}

/** What the executor may run, across every route a task can land on (FR-008). */
export interface ExecutorCommands {
  /** False when some route's runner does not report its prefixes: nothing below is claimed. */
  readonly known: boolean;
  /** True only when every route may run any command. */
  readonly any: boolean;
  /** The prefixes every route may run, sorted. */
  readonly prefixes: readonly string[];
}

/** What one runner reports it may run: `executorCommandsOf` for a single route (FR-021). */
export interface RunnerCommandGrants {
  readonly any: boolean;
  readonly prefixes: readonly string[];
}

/**
 * One runner's reported command grants, or nothing when it does not report them.
 *
 * The one reading of the two capability fields, shared by `executorCommandsOf` and by
 * `doctor`'s per-role report. Two readers each deciding what an absent `grantsAnyCommand`
 * means would be two answers to "what can this role run" the first time one was edited.
 */
export function runnerCommandGrants(
  grants: RunnerCapabilities['nonInteractiveToolGrants'] | undefined,
): RunnerCommandGrants | undefined {
  if (grants?.grantedCommandPrefixes === undefined) return undefined;
  return { any: grants.grantsAnyCommand === true, prefixes: grants.grantedCommandPrefixes };
}

const EXECUTOR_ROLES = ['executor.trivial', 'executor.normal', 'executor.complex'] as const;

const UNKNOWN: ExecutorCommands = { known: false, any: false, prefixes: [] };

/**
 * The single computation of the executor's command set (FR-008).
 *
 * Over the enabled executor routes, because the router picks one per task and a plan is
 * written before that pick: a command is only safe to ask of "the executor" when every route
 * it could land on can run it. That is why the prefixes are an **intersection**, and why a
 * mixed setup sees fewer commands than its widest route has (R-8).
 *
 * `known: false` when a route's runner does not report prefixes, or when no route is enabled:
 * "no route said anything" is not "every route may run nothing", and a check that trusted it
 * would refuse every command a plan cited.
 */
export function executorCommandsOf(roles: RolesConfig, capabilities: RunnerCapabilitiesMap): ExecutorCommands {
  const routes = EXECUTOR_ROLES.map((role) => roleConfigOf(roles, role)).filter((route) => route.enabled);
  if (routes.length === 0) return UNKNOWN;

  const grants = routes.map((route) => capabilitiesOf(capabilities, route.runner, route.model)?.nonInteractiveToolGrants);
  const reported = grants.flatMap((grant) => {
    const read = runnerCommandGrants(grant);
    return read === undefined ? [] : [read];
  });
  if (reported.length !== grants.length) return UNKNOWN;

  const [first, ...rest] = reported;
  const prefixes = (first?.prefixes ?? []).filter((prefix) => rest.every((route) => route.prefixes.includes(prefix)));

  return {
    known: true,
    any: reported.every((route) => route.any),
    prefixes: [...new Set(prefixes)].sort(),
  };
}

/** One run of whitespace, so a line break inside a code span compares as the space it renders as. */
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** An opening or closing fence: three or more backticks or tildes, alone on the line when closing. */
const FENCE = /^\s*(`{3,}|~{3,})/;
const CLOSING_FENCE = /^\s*(`{3,}|~{3,})\s*$/;

/**
 * An inline code span: a backtick run, content, and a run of the same length.
 *
 * The lookarounds hold the "same length" rule, so ``` ``a `b` c`` ``` is one span rather
 * than two broken ones.
 */
const CODE_SPAN = /(?<!`)(`+)(?!`)([\s\S]+?)(?<!`)\1(?!`)/g;

/** The code a piece of Markdown shows: every inline span, and every line of a fenced block. */
function codeSnippets(text: string): string[] {
  const snippets: string[] = [];
  const prose: string[] = [];
  let fence: string | undefined;

  for (const line of text.split(/\r?\n/)) {
    if (fence === undefined) {
      const opening = FENCE.exec(line)?.[1];
      if (opening === undefined) prose.push(line);
      else fence = opening;
      continue;
    }
    const closing = CLOSING_FENCE.exec(line)?.[1];
    if (closing !== undefined && closing[0] === fence[0] && closing.length >= fence.length) {
      fence = undefined;
      // A fence closes a block; it does not end the prose around it, so a span cannot
      // reach across a block either.
      prose.push('');
      continue;
    }
    snippets.push(line);
  }

  for (const match of prose.join('\n').matchAll(CODE_SPAN)) snippets.push(match[2] ?? '');
  return snippets;
}

/**
 * The commands a piece of plan text cites (FR-009).
 *
 * A citation is code — an inline span or a fenced-block line — of **at least two words whose
 * first word opens some command in `commands`** (the declared lines and the executor's
 * prefixes). Both filters are there to keep a false refusal from spending the planner's one
 * repair (R-3, the SDD's weakest claim):
 *
 *   - one word is a name, not an invocation — `` `npm` `` or `` `vitest` `` in a sentence
 *     about tooling asks nobody to run anything;
 *   - a first word no declared line or grant starts with is some other code — a path, an
 *     identifier, a JSON key — or an executable this check has no family for, which the
 *     plan reviewer is the backstop for (FR-019).
 *
 * Pure, and it only ever reads: plan text never becomes a grant or a command (SEC-003).
 * Each citation once, whitespace collapsed: fenced-block lines first, then inline spans.
 */
export function commandCitations(text: string, commands: readonly string[]): string[] {
  const families = new Set(commands.map((command) => collapse(command).split(' ')[0]).filter(Boolean));
  const citations: string[] = [];

  for (const snippet of codeSnippets(text)) {
    const citation = collapse(snippet);
    const words = citation.split(' ');
    if (words.length < 2 || !families.has(words[0] ?? '')) continue;
    if (!citations.includes(citation)) citations.push(citation);
  }

  return citations;
}

/**
 * The citations no command in `commands` covers (FR-009).
 *
 * Covered means equal to a command, or starting with it followed by a space — the same
 * boundary the grant dedup uses, so `npm run lint` covers `npm run lint -- --fix` and does
 * not cover `npm run lint:deck`. A citation that runs a declared line is run by Agent Flow
 * through a validation id; one that runs an executor prefix is run by the executor. Anything
 * else is a measurement nobody in the run can make.
 */
export function uncoveredCitations(citations: readonly string[], commands: readonly string[]): string[] {
  const covering = commands.map(collapse).filter((command) => command.length > 0);
  return citations.filter(
    (citation) => !covering.some((command) => citation === command || citation.startsWith(`${command} `)),
  );
}
