import { BYTES_PER_TOKEN } from './prompt-budget.js';

/**
 * The repository, ranked by structural centrality and rendered to fit a budget.
 *
 * **Why this exists.** `discovery` was asked to map a repository by reading it, and the
 * prompt says so outright: "prefer reading a file over inferring from its name". On a
 * monorepo that is thousands of files through a frontier model, and it was measured
 * failing twice at a 900 s budget without producing anything. The map it was trying to
 * build is mostly *structure* — what exists, what depends on what, what is central — and
 * structure is the one thing a parser can answer without a model.
 *
 * Measured on that same repository: 2.781 files parsed in 7,6 s, 65.710 symbols, 99,9% of
 * the Vue components and 98,6% of the TypeScript clean. Against a stage that never
 * finished.
 *
 * **What it is not.** It is not the architecture document, and it does not replace the
 * stage. `discovery` still runs and still writes the prose that later stages consume —
 * "this is hexagonal", "migrations are forward-only" — because that is synthesis, and
 * synthesis is what a model is for. This is the index that stops it reading everything to
 * get there. The evidence supports exactly that division: structural context injected at
 * the *localisation* step cut input tokens 25% and improved localisation, and injected at
 * the *editing* step cost 5pp of correctness (arXiv 2606.14061). So it feeds the stage
 * that decides what to look at, and is kept out of the one that writes code.
 *
 * Pure, and the purity is load-bearing: ranking is the part that decides what a later
 * stage gets to see, and it has to be provable without a filesystem, a clock or a model.
 */

/** What a parser found in one file. The adapter's whole output shape. */
export interface FileTags {
  /** Repository-relative, forward slashes. The identity a rendered map shows. */
  readonly path: string;
  /** Symbols this file defines. */
  readonly defs: readonly string[];
  /**
   * Symbols this file mentions, once per mention.
   *
   * Repetition is signal, not noise: a file that reaches for one symbol nine times
   * depends on it more than one that mentions it once, and the edge weight is that count.
   */
  readonly refs: readonly string[];
}

export interface RankOptions {
  /**
   * Identifiers the request already named, which get their definers weighted up.
   *
   * Aider's repo map does the same thing and for the same reason: a map built for no
   * question in particular is worse than one built for the question being asked. Empty is
   * the ordinary case here, because `discovery` is feature-agnostic by design.
   */
  readonly focusSymbols?: readonly string[];
  /** Files the request already named. Weighted above symbols, for the same reason. */
  readonly focusPaths?: readonly string[];
}

export interface RankedFile {
  readonly path: string;
  readonly rank: number;
  /** This file's definitions, most depended-upon first. */
  readonly defs: readonly string[];
}

/**
 * How much a focus hint outweighs an ordinary file.
 *
 * Aider measured these as 10x for a mentioned identifier and 50x for a file already in
 * the conversation. Kept rather than re-derived: the numbers are somebody else's
 * measurement, and inventing different ones would be inventing a claim.
 */
const FOCUS_SYMBOL_WEIGHT = 10;
const FOCUS_PATH_WEIGHT = 50;

/** Standard PageRank damping. The random-surfer probability of following an edge. */
const DAMPING = 0.85;

/**
 * Power-iteration rounds.
 *
 * Fixed rather than convergence-checked, deliberately: a fixed count is the same answer
 * on every machine and in every test, and a tolerance is one more number to tune. Thirty
 * rounds at 0.85 damping puts the residual far below anything that changes an ordering.
 */
const ITERATIONS = 30;

/**
 * Files ranked by how much the rest of the repository depends on them.
 *
 * The graph is files, and an edge runs from the file that *mentions* a symbol to the file
 * that *defines* it — so rank flows toward what is depended upon. That direction is the
 * whole point: a function called by twenty others is more valuable context than a private
 * helper called once, and file size, path depth and alphabetical order all say nothing
 * about which is which.
 *
 * A symbol defined in several files spreads the edge across them rather than picking one.
 * Guessing which definition was meant needs a resolver this does not have, and splitting
 * is the answer that is wrong by the least.
 *
 * Self-edges are dropped. A file referencing what it defines is describing itself, and
 * letting that accumulate would rank the largest file first for being large.
 */
export function rankRepo(tags: readonly FileTags[], options: RankOptions = {}): RankedFile[] {
  // Sorted once, here, so every map below iterates in one order and the result does not
  // depend on the order a directory walk happened to return.
  const files = [...tags].sort((a, b) => a.path.localeCompare(b.path));
  if (files.length === 0) return [];

  const definers = new Map<string, string[]>();
  for (const file of files) {
    for (const symbol of [...new Set(file.defs)].sort()) {
      const list = definers.get(symbol);
      if (list === undefined) definers.set(symbol, [file.path]);
      else list.push(file.path);
    }
  }

  // path -> (path -> weight). Built before ranking so the shape is inspectable in a test.
  const edges = new Map<string, Map<string, number>>();
  const bump = (from: string, to: string, weight: number): void => {
    if (from === to) return;
    const row = edges.get(from) ?? new Map<string, number>();
    row.set(to, (row.get(to) ?? 0) + weight);
    edges.set(from, row);
  };

  for (const file of files) {
    const counts = new Map<string, number>();
    for (const symbol of file.refs) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);

    for (const symbol of [...counts.keys()].sort()) {
      const owners = definers.get(symbol);
      if (owners === undefined) continue;
      const share = (counts.get(symbol) ?? 0) / owners.length;
      for (const owner of owners) bump(file.path, owner, share);
    }
  }

  const scores = pageRank(files.map((file) => file.path), edges, personalisationOf(files, options));

  return files
    .map((file) => ({
      path: file.path,
      rank: scores.get(file.path) ?? 0,
      defs: orderDefinitions(file, files),
    }))
    .sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path));
}

/**
 * Where the random surfer restarts, which is how a hint becomes a ranking.
 *
 * Uniform when nothing was named — the feature-agnostic case `discovery` runs in — and
 * weighted toward the named files and the definers of named symbols otherwise. Expressed
 * as restart probability rather than as an edge, because a hint is not a dependency: it
 * says where to look, not what depends on what.
 */
function personalisationOf(
  files: readonly FileTags[],
  options: RankOptions,
): Map<string, number> {
  const focusPaths = new Set(options.focusPaths ?? []);
  const focusSymbols = new Set(options.focusSymbols ?? []);
  const weights = new Map<string, number>();

  for (const file of files) {
    let weight = 1;
    if (focusPaths.has(file.path)) weight += FOCUS_PATH_WEIGHT;
    if (file.defs.some((symbol) => focusSymbols.has(symbol))) weight += FOCUS_SYMBOL_WEIGHT;
    weights.set(file.path, weight);
  }

  return weights;
}

/**
 * PageRank by power iteration, with the dangling mass handled rather than lost.
 *
 * A file that references nothing — a leaf type module, a config — has no outgoing edges,
 * and its score would simply evaporate each round. Redistributing it over the restart
 * distribution is the standard correction and it matters here: leaf modules are common in
 * a typed codebase, and losing their mass would quietly deflate everything.
 */
function pageRank(
  nodes: readonly string[],
  edges: ReadonlyMap<string, ReadonlyMap<string, number>>,
  personalisation: ReadonlyMap<string, number>,
): Map<string, number> {
  const restartTotal = [...personalisation.values()].reduce((sum, value) => sum + value, 0);
  const restart = new Map<string, number>(
    nodes.map((node) => [node, (personalisation.get(node) ?? 0) / restartTotal]),
  );

  let scores = new Map<string, number>(nodes.map((node) => [node, 1 / nodes.length]));
  const outWeight = new Map<string, number>(
    nodes.map((node) => [
      node,
      [...(edges.get(node)?.values() ?? [])].reduce((sum, value) => sum + value, 0),
    ]),
  );

  for (let round = 0; round < ITERATIONS; round += 1) {
    const next = new Map<string, number>(nodes.map((node) => [node, 0]));
    let dangling = 0;

    for (const node of nodes) {
      const score = scores.get(node) ?? 0;
      const total = outWeight.get(node) ?? 0;
      if (total === 0) {
        dangling += score;
        continue;
      }
      for (const [target, weight] of edges.get(node) ?? []) {
        next.set(target, (next.get(target) ?? 0) + (score * weight) / total);
      }
    }

    for (const node of nodes) {
      const flowed = (next.get(node) ?? 0) + dangling * (restart.get(node) ?? 0);
      next.set(node, DAMPING * flowed + (1 - DAMPING) * (restart.get(node) ?? 0));
    }

    scores = next;
  }

  return scores;
}

/**
 * A file's definitions, ordered by how much the rest of the repository asks for them.
 *
 * The file's own references are excluded from the count for the same reason self-edges
 * are dropped above: a symbol is not important because the file that defines it also uses
 * it. Ties fall back to alphabetical, so the rendering is stable across runs.
 */
function orderDefinitions(file: FileTags, files: readonly FileTags[]): string[] {
  const demand = new Map<string, number>();
  for (const other of files) {
    if (other.path === file.path) continue;
    for (const symbol of other.refs) {
      if (!file.defs.includes(symbol)) continue;
      demand.set(symbol, (demand.get(symbol) ?? 0) + 1);
    }
  }
  return [...new Set(file.defs)].sort(
    (a, b) => (demand.get(b) ?? 0) - (demand.get(a) ?? 0) || a.localeCompare(b),
  );
}

export interface RenderedMap {
  readonly text: string;
  /** Files the budget could not fit. Reported, never dropped in silence (§6.5). */
  readonly omitted: number;
  readonly estimatedTokens: number;
}

/**
 * The ranked repository, as text a prompt can carry.
 *
 * **Skips rather than stops.** A single enormous file part-way down the ranking would
 * otherwise truncate everything below it, and the tail of a ranking is where the small,
 * highly-depended-upon modules live — exactly what the map exists to surface. So a file
 * that does not fit is passed over and the next one is tried.
 *
 * The count of what was left out travels with the text, because a budget applied silently
 * is the defect §6.5 is about: a reader cannot tell a small repository from a truncated
 * one, and the map is about to be handed to a model that cannot either.
 */
export function renderRepoMap(
  ranked: readonly RankedFile[],
  budgetTokens: number,
  /** Definitions shown per file. Beyond a handful the tail is noise the ranking already sorted. */
  defsPerFile = 12,
): RenderedMap {
  const budgetBytes = Math.max(0, budgetTokens) * BYTES_PER_TOKEN;
  const lines: string[] = [];
  let bytes = 0;
  let omitted = 0;

  for (const file of ranked) {
    const shown = file.defs.slice(0, defsPerFile);
    const block =
      shown.length === 0
        ? `${file.path}\n`
        : `${file.path}\n${shown.map((name) => `  ${name}`).join('\n')}\n`;

    if (bytes + block.length > budgetBytes) {
      omitted += 1;
      continue;
    }
    lines.push(block);
    bytes += block.length;
  }

  return {
    text: lines.join(''),
    omitted,
    estimatedTokens: Math.round(bytes / BYTES_PER_TOKEN),
  };
}
