import { GIT_TIMEOUT_SECONDS, type GitCommand } from '../adapters/git/git-command.js';
import type { FileSystem } from '../ports/file-system.js';
import type { CodeTagger } from '../ports/code-tagger.js';
import { rankRepo, renderRepoMap, type RankOptions } from '../core/repo-map.js';
import { agentFlowPaths } from './paths.js';

/**
 * Builds the repository map: list, parse, rank, render.
 *
 * The use case, so the CLI and the planning pipeline cannot disagree about what a map is.
 * Everything it decides is orchestration — which files to read, what to do when Git is
 * absent, where the artifact lands. The ranking is `core/repo-map.ts` and the parsing is
 * the tagger, and neither is reachable from here except through its own seam.
 */

export interface BuildRepoMapOptions {
  readonly fs: FileSystem;
  readonly git: GitCommand;
  readonly tagger: CodeTagger;
  readonly projectDir: string;
  /** Tokens the rendered map may occupy inside the stage prompt. */
  readonly budgetTokens: number;
  readonly focus?: RankOptions;
  /**
   * The ceiling on a single file's bytes.
   *
   * A generated bundle or a checked-in minified vendor file is megabytes on one line, and
   * parsing it costs more than every hand-written file combined while contributing a
   * symbol table nobody wrote. One megabyte is far above any source file measured in this
   * repository and far below the files this exists to skip.
   */
  readonly maxFileBytes?: number;
  /**
   * `paths.source` from the project configuration, when it names anything.
   *
   * **A lever, not a default.** Empty means the whole tree, which is right for a
   * repository whose code is its code. It earns its place on a repository where it is not:
   * measured on a monorepo that keeps a retired Nuxt application in `old/`, whose
   * `.gitignore` lists the directory and whose index tracks 377 of its files anyway —
   * `.gitignore` does not untrack what was already committed, so Git lists them and the
   * legacy app competes for the budget with the code somebody is actually changing.
   *
   * A prefix match on the repository-relative path, which is what `paths.source` already
   * means everywhere else it is read.
   */
  readonly sourcePaths?: readonly string[];
}

export interface RepoMapResult {
  readonly text: string;
  /** Files Git listed with an extension the tagger covers. */
  readonly candidates: number;
  /** Files that produced at least one symbol. The rest parsed to nothing, which is normal. */
  readonly tagged: number;
  /** Files the budget could not fit (§6.5 — never applied in silence). */
  readonly omitted: number;
  readonly estimatedTokens: number;
  readonly elapsedMs: number;
}

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

/**
 * The map, from the working tree as Git sees it.
 *
 * **Git lists the files, rather than a directory walk**, and that is the whole ignore
 * story: `ls-files` already honours `.gitignore`, so `node_modules`, `dist` and every
 * build output are absent without this module holding a list of directory names that
 * would rot. A repository without Git gets no map rather than a wrong one — and "no map"
 * is a state `discovery` already handles, because it is what every run had until now.
 */
export async function buildRepoMap(options: BuildRepoMapOptions): Promise<RepoMapResult | undefined> {
  const startedAt = Date.now();
  const extensions = new Set(options.tagger.supportedExtensions());

  const listed = await options.git.run({
    subcommand: 'ls-files',
    args: ['--cached', '--others', '--exclude-standard'],
    cwd: options.projectDir,
    timeoutSeconds: GIT_TIMEOUT_SECONDS.quick,
    // A monorepo's file list is large, and truncating it would silently produce a partial
    // map that looks complete.
    maxOutputBytes: 16 * 1024 * 1024,
  });

  if (!listed.ok || listed.value.exitCode !== 0) return undefined;

  const scope = (options.sourcePaths ?? []).map((prefix) => prefix.replace(/^\.\//, '').replace(/\/$/, ''));
  const inScope = (path: string): boolean =>
    scope.length === 0 || scope.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

  const paths = listed.value.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && extensions.has(extensionOf(line)) && inScope(line));

  if (paths.length === 0) return undefined;

  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const files: { path: string; content: string }[] = [];

  for (const path of paths) {
    let content: string;
    try {
      content = await options.fs.readFile(`${options.projectDir}/${path}`);
    } catch {
      // Listed by Git and unreadable now — a race with a checkout, a permission, a broken
      // link. One file, not the map.
      continue;
    }
    if (content.length > maxBytes) continue;
    files.push({ path, content });
  }

  const tags = await options.tagger.tag(files);
  // Nothing parsed. The grammars are an optional dependency and this is what their absence
  // looks like from here — the same answer as a repository without Git, because it is the
  // same situation: no map, and a stage that works the way it always did.
  if (tags.length === 0) return undefined;

  const rendered = renderRepoMap(rankRepo(tags, options.focus ?? {}), options.budgetTokens);

  return {
    text: rendered.text,
    candidates: paths.length,
    tagged: tags.length,
    omitted: rendered.omitted,
    estimatedTokens: rendered.estimatedTokens,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Where a built map is kept, beside the architecture document it feeds.
 *
 * Cached as a *convenience*, never as a source of truth: rebuilding costs seconds, so the
 * cache is not load-bearing the way `architecture.md`'s is — and that difference is the
 * point of splitting them. The expensive artifact is the prose a model wrote; this one is
 * a parse, and a parse that might be stale is worth less than a parse that is cheap.
 */
export function repoMapPath(projectDir: string): string {
  return `${agentFlowPaths(projectDir).cacheDir}/repo-map.txt`;
}

export async function writeRepoMap(
  fs: FileSystem,
  projectDir: string,
  text: string,
): Promise<void> {
  await fs.mkdirp(agentFlowPaths(projectDir).cacheDir);
  await fs.writeFileAtomic(repoMapPath(projectDir), text);
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot).toLowerCase();
}
