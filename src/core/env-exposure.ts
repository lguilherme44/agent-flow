/**
 * Whether a `worktree.copy` entry would hand a `.env` file to the model (N2, FR-018).
 *
 * Whatever `worktree.copy` matches is copied into a tree an agent reads and writes, so a
 * pattern that reaches a `.env` file puts its secrets in front of the model. `doctor` warns
 * about such a pattern by two rules, and this module is the text half of both.
 *
 * **No glob is matched against `.env`.** The tempting test — "would this pattern match a
 * file called `.env`?" — is a glob matcher, and every one of them answers yes for `*`, `**`
 * and `config/*`, which would put a warning on nearly every broad pattern an operator
 * writes and teach them to ignore it. The pattern is read as text instead: rule (a) looks
 * at what it literally names, and rule (b) asks Git what it matches today and looks at
 * those names. `**` therefore warns only when the repository actually holds a `.env`.
 */

/** The text after the last `/`, or the whole string when it has none. */
function lastSegment(text: string): string {
  return text.slice(text.lastIndexOf('/') + 1);
}

/**
 * Rule (a): the pattern's last segment, read as text, starts with `.env`.
 *
 * True for `.env`, `.env.local`, `.env.*`, `config/.env.local` and `**` + `/.env*`; false
 * for `*.json`, `*.yaml.example`, `config/*` and `**` + `/*`, whatever they would match.
 */
export function patternNamesEnvFile(pattern: string): boolean {
  return lastSegment(pattern).startsWith('.env');
}

/**
 * Rule (b)'s test for one file the listing returned: its name starts with `.env`.
 *
 * The name, not the path: `.env.d/app.conf` is a file inside a directory and names nothing
 * the rule is about, while `config/.env.local` is exactly the file it is about.
 */
export function fileNamedEnv(path: string): boolean {
  return lastSegment(path).startsWith('.env');
}
