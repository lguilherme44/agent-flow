import { describe, it, expect } from 'vitest';
import { rankRepo, renderRepoMap, type FileTags } from '../../src/core/repo-map.js';

/**
 * Ranking decides what a later stage is allowed to see, so it is tested as a judgement
 * rather than as a shape: the assertions are about *order*, and each one comes with the
 * control that fails if the graph is taken away.
 */

/** A hub every file reaches for, and a helper only one file touches. */
const hubAndHelper: FileTags[] = [
  { path: 'src/core/money.ts', defs: ['formatMoney', 'parseMoney'], refs: [] },
  { path: 'src/util/pad.ts', defs: ['padLeft'], refs: [] },
  { path: 'src/a.ts', defs: ['a'], refs: ['formatMoney'] },
  { path: 'src/b.ts', defs: ['b'], refs: ['formatMoney'] },
  { path: 'src/c.ts', defs: ['c'], refs: ['formatMoney', 'padLeft'] },
  { path: 'src/d.ts', defs: ['d'], refs: ['formatMoney'] },
];

const pathsOf = (tags: FileTags[], options = {}) => rankRepo(tags, options).map((f) => f.path);

describe('rankRepo', () => {
  it('puts the module the repository depends on above the one it barely uses', () => {
    // Aider's justification, and the reason a repo map beats a file listing: "a function
    // called by 20 other functions is more valuable context than a private helper called
    // once". Four dependents against one.
    const ranked = pathsOf(hubAndHelper);

    expect(ranked.indexOf('src/core/money.ts')).toBeLessThan(ranked.indexOf('src/util/pad.ts'));
  });

  it('ranks by the graph, not by anything the paths happen to say', () => {
    // **The positive control for the test above.** Remove the references and the graph
    // says nothing — so if `money.ts` still came first, it would be winning on path
    // order or definition count and the ranking would be decorative.
    const noEdges = hubAndHelper.map((file) => ({ ...file, refs: [] }));
    const ranks = rankRepo(noEdges).map((file) => file.rank);

    expect(Math.max(...ranks) - Math.min(...ranks)).toBeLessThan(1e-9);
  });

  it('counts repeated mentions as stronger dependence', () => {
    const once: FileTags[] = [
      { path: 'hub.ts', defs: ['h'], refs: [] },
      { path: 'other.ts', defs: ['o'], refs: [] },
      { path: 'user.ts', defs: ['u'], refs: ['h', 'o'] },
    ];
    const nineTimes: FileTags[] = [
      { path: 'hub.ts', defs: ['h'], refs: [] },
      { path: 'other.ts', defs: ['o'], refs: [] },
      { path: 'user.ts', defs: ['u'], refs: ['h', 'h', 'h', 'h', 'h', 'h', 'h', 'h', 'h', 'o'] },
    ];

    const evenly = rankRepo(once);
    const weighted = rankRepo(nineTimes);

    const rankOf = (r: ReturnType<typeof rankRepo>, p: string) =>
      r.find((f) => f.path === p)?.rank ?? 0;

    expect(rankOf(evenly, 'hub.ts')).toBeCloseTo(rankOf(evenly, 'other.ts'), 9);
    expect(rankOf(weighted, 'hub.ts')).toBeGreaterThan(rankOf(weighted, 'other.ts'));
  });

  it('does not let a file promote itself by using what it defines', () => {
    // A self-edge would rank the biggest file first for being big, which is the ranking
    // a file listing already gives for free.
    const selfish: FileTags[] = [
      { path: 'big.ts', defs: ['x'], refs: ['x', 'x', 'x', 'x', 'x', 'x', 'x', 'x'] },
      { path: 'small.ts', defs: ['y'], refs: [] },
      { path: 'user.ts', defs: ['u'], refs: ['y'] },
    ];
    const ranked = pathsOf(selfish);

    expect(ranked.indexOf('small.ts')).toBeLessThan(ranked.indexOf('big.ts'));
  });

  it('splits a symbol defined in two places instead of picking one', () => {
    // No resolver here, so guessing which definition was meant would be a fabrication.
    // Splitting is the answer that is wrong by the least, and both definers rank alike.
    const ambiguous: FileTags[] = [
      { path: 'one.ts', defs: ['shared'], refs: [] },
      { path: 'two.ts', defs: ['shared'], refs: [] },
      { path: 'user.ts', defs: ['u'], refs: ['shared'] },
    ];
    const ranked = rankRepo(ambiguous);

    expect(ranked.find((f) => f.path === 'one.ts')?.rank).toBeCloseTo(
      ranked.find((f) => f.path === 'two.ts')?.rank ?? 0,
      9,
    );
  });

  it('keeps a file that references nothing from having its score evaporate', () => {
    // Dangling mass. A leaf type module is common in a typed codebase, and losing its
    // share every round would quietly deflate the whole ranking.
    const withLeaf: FileTags[] = [
      { path: 'leaf.ts', defs: ['t'], refs: [] },
      { path: 'a.ts', defs: ['a'], refs: ['b'] },
      { path: 'b.ts', defs: ['b'], refs: ['a'] },
    ];
    const total = rankRepo(withLeaf).reduce((sum, file) => sum + file.rank, 0);

    expect(total).toBeCloseTo(1, 6);
  });

  it('lifts a named file above what the graph alone would choose', () => {
    const plain = pathsOf(hubAndHelper);
    const focused = pathsOf(hubAndHelper, { focusPaths: ['src/util/pad.ts'] });

    expect(plain[0]).toBe('src/core/money.ts');
    expect(focused[0]).toBe('src/util/pad.ts');
  });

  it('lifts the file that defines a named symbol', () => {
    const focused = pathsOf(hubAndHelper, { focusSymbols: ['padLeft'] });

    expect(focused.indexOf('src/util/pad.ts')).toBeLessThan(
      pathsOf(hubAndHelper).indexOf('src/util/pad.ts'),
    );
  });

  it('orders a file’s definitions by what the rest of the repository asks for', () => {
    const ranked = rankRepo(hubAndHelper);
    const money = ranked.find((file) => file.path === 'src/core/money.ts');

    // `formatMoney` has four callers, `parseMoney` none.
    expect(money?.defs).toEqual(['formatMoney', 'parseMoney']);
  });

  it('is the same answer whatever order the files arrived in', () => {
    // A directory walk's order is an accident of the filesystem, and a map that changed
    // with it would make every comparison between two runs meaningless.
    const forwards = pathsOf(hubAndHelper);
    const backwards = pathsOf([...hubAndHelper].reverse());

    expect(backwards).toEqual(forwards);
  });

  it('has an answer for an empty repository', () => {
    expect(rankRepo([])).toEqual([]);
  });
});

describe('renderRepoMap', () => {
  const ranked = rankRepo(hubAndHelper);

  it('writes the ranking as text, most central first', () => {
    const { text } = renderRepoMap(ranked, 10_000);

    expect(text.indexOf('src/core/money.ts')).toBeLessThan(text.indexOf('src/util/pad.ts'));
    expect(text).toContain('  formatMoney');
  });

  it('says how many files a budget left out', () => {
    // §6.5: a budget is never applied silently. Without the count a reader cannot tell a
    // small repository from a truncated one — and neither can the model it is handed to.
    const tight = renderRepoMap(ranked, 12);

    expect(tight.omitted).toBeGreaterThan(0);
    expect(tight.estimatedTokens).toBeLessThanOrEqual(12);
  });

  it('skips a file it cannot fit instead of stopping there', () => {
    // The tail of a ranking is where small, heavily-depended-upon modules live. One huge
    // file part-way down must not take them with it.
    const withGiant = rankRepo([
      ...hubAndHelper,
      { path: 'generated/huge.ts', defs: Array.from({ length: 400 }, (_, i) => `sym${String(i)}`), refs: ['formatMoney'] },
    ]);
    const { text, omitted } = renderRepoMap(withGiant, 120, 400);

    expect(omitted).toBeGreaterThan(0);
    // The small files after it still made it in, which is the whole point.
    expect(text).toContain('src/util/pad.ts');
  });

  it('omits everything rather than overspending a budget of nothing', () => {
    const { text, omitted } = renderRepoMap(ranked, 0);

    expect(text).toBe('');
    expect(omitted).toBe(ranked.length);
  });
});
