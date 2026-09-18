import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES } from '../../src/contracts/index.js';
import { en, phrasesFor, ptBR, type Phrases } from '../../src/core/phrases/index.js';

/**
 * The phrase book, and the two things a compiler cannot check about it.
 *
 * **Completeness is not tested here, because it cannot fail.** `ptBR` is annotated
 * `Phrases`, so a missing key, a renamed key, an extra key or a function of the wrong
 * arity is a build error — there is no runtime state in which one book has a hole. What
 * a type cannot see is whether a value was *translated* or merely copied, and whether an
 * identifier survived being translated. Those are the two tests below.
 */

type Leaf = readonly [path: string, en: string, ptBR: string];

/**
 * Every sentence in both books, rendered.
 *
 * Functions are called with placeholder arguments rather than skipped: half the book is
 * a function, and a test that only looked at the plain strings would be blind to exactly
 * the entries where agreement and interpolation make mistakes.
 */
function leaves(): Leaf[] {
  return entries((index) => (index === 0 ? 'ID' : 2));
}

/** Both books rendered, with `at` choosing what each parameter is given by position. */
function entries(at: (index: number) => unknown): Leaf[] {
  const rendered: Leaf[] = [];

  for (const slice of Object.keys(en) as (keyof Phrases)[]) {
    const left = en[slice] as Record<string, unknown>;
    const right = ptBR[slice] as unknown as Record<string, unknown>;

    for (const key of Object.keys(left)) {
      const value = left[key];
      const other = right[key];

      if (typeof value === 'string' && typeof other === 'string') {
        rendered.push([`${slice}.${key}`, value, other]);
        continue;
      }

      if (typeof value !== 'function' || typeof other !== 'function') continue;

      const args = Array.from({ length: value.length }, (_, index) => at(index));
      rendered.push([
        `${slice}.${key}`,
        (value as (...rest: unknown[]) => string)(...args),
        (other as (...rest: unknown[]) => string)(...args),
      ]);
    }
  }

  return rendered;
}

/**
 * The entries that are the same sentence in both languages, on purpose.
 *
 * Each one is a fragment with no words in it, or a word Portuguese borrowed unchanged.
 * The list is exhaustive and the test fails when it grows, which is the point: a new
 * untranslated entry lands here as a failure rather than as a screen half in English.
 */
const IDENTICAL = [
  'actions.atPid', // `pid 2` — a Unix word and a number
  'attention.reasonAndImpact', // `${reason} — ${impact}`: punctuation, no words
  'config.fallback', // the setting is spelled `fallback` in the file too
  'config.runners',
  'config.workspace',
  'git.unborn', // Git's own word for a HEAD with no commit
  'server.wherePid',
];

describe('the phrase book', () => {
  it('answers for every locale the contract names', () => {
    for (const locale of LOCALES) expect(phrasesFor(locale)).toBeDefined();
    expect(phrasesFor(DEFAULT_LOCALE)).toBe(en);
    expect(phrasesFor('pt-BR')).toBe(ptBR);
  });

  it('translates every sentence, and says which ones it deliberately does not', () => {
    const untranslated = leaves()
      .filter(([, english, portuguese]) => english === portuguese)
      .map(([path]) => path)
      .sort();

    // Asserted as equality rather than as a subset, in both directions at once: a new
    // untranslated entry fails, and so does an exemption that has stopped being true.
    expect(untranslated).toEqual([...IDENTICAL].sort());
  });

  it('never translates an identifier', () => {
    // A run id, a task id, a command and a gate name: each is typed back into a terminal
    // or matched against a file, and a translated one matches nothing.
    expect(ptBR.actions.noSuchRun('RUN-2026-01-02-abcd')).toContain('RUN-2026-01-02-abcd');
    expect(ptBR.gate.approval).toContain('agent-flow approve');
    expect(ptBR.actions.resumeIt).toContain('agent-flow resume');
    expect(ptBR.attention.gateFailed('lint')).toContain('`lint`');
    expect(ptBR.board.heldBackBy('TASK-004')).toContain('TASK-004');
    expect(ptBR.git.runInitFirst).toContain('agent-flow init');
    expect(ptBR.doctor.runLoginOrExport('codex login', 'OPENAI_API_KEY')).toContain(
      'OPENAI_API_KEY',
    );
  });

  it('agrees with the count it is given', () => {
    // The reason these are functions rather than `{n}` placeholders: Portuguese inflects
    // the noun *and* the adjective, and only the fold knows the number.
    expect(ptBR.attention.blockingFindings('TASK-001', 1)).toContain('1 achado bloqueante');
    expect(ptBR.attention.blockingFindings('TASK-001', 3)).toContain('3 achados bloqueantes');
    expect(ptBR.board.changesRequested(1)).toContain('1 achado bloqueante');
    expect(ptBR.board.changesRequested(2)).toContain('2 achados bloqueantes');
  });

  it('renders in the singular too, and with the optional half declined', () => {
    // `${n} finding${n === 1 ? '' : 's'}` is one entry with two shapes, and
    // `${ownWorktree ? ' in its own worktree' : ''}` is a decision about *what to say*
    // rather than formatting. Rendering only at `2` — which is all this suite did — read
    // half of each: 25 agreement and fragment branches across the two books had never been
    // executed. Nothing hid them; the coverage meter simply could not see inside a template
    // literal until Vitest 4 made the v8 provider's AST-aware remapping the default.
    //
    // `1` is the singular, `''` a name there is nothing to print, `false` a flag that is
    // off. What is asserted is what a fold can be held to without writing a second
    // translation of it: the sentence still comes out, and nothing in it went missing.
    //
    // Rendered with the first parameter held as an identifier *and* given the same value as
    // the rest, because the first parameter is not always an id — `remoteChecksFailed(red)`,
    // `declared(total)` and `running(attempt, …)` take a count there, and a suite that always
    // passed `'ID'` could reach neither their singular nor their plural.
    const shapes = [2, 1, '', false].flatMap((argument) => [
      [`id then ${JSON.stringify(argument)}`, (index: number) => (index === 0 ? 'ID' : argument)],
      [`${JSON.stringify(argument)} throughout`, () => argument],
    ]) as readonly (readonly [string, (index: number) => unknown])[];

    for (const [shape, at] of shapes) {
      for (const [path, english, portuguese] of entries(at)) {
        for (const [book, sentence] of [
          ['en', english],
          ['pt-BR', portuguese],
        ] as const) {
          const where = `${book} ${path} — ${shape}`;

          expect(sentence.trim(), where).not.toBe('');
          // A forgotten branch does not throw — it interpolates the hole it left.
          expect(sentence, where).not.toMatch(/undefined|\bNaN\b|\[object /);
        }
      }
    }
  });
});
