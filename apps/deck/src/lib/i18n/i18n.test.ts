import { describe, expect, it } from 'vitest';
import { en } from './translations/en';
import { ptBR } from './translations/pt-BR';
import { word } from './index';

/**
 * What the compiler cannot check about a second language.
 *
 * `ptBR` is annotated `Dictionary`, so a missing, extra or misspelled key already fails
 * `tsc`. Three things it does not see, and each has produced a bug in a real product:
 *
 *   1. a translated function that ignores the argument it was given — `(n) => 'tarefas'`
 *      compiles and drops the number;
 *   2. a value copied across untranslated, which is how a screen ends up 94% in one
 *      language and nobody can say which 6% is left;
 *   3. an unknown token reaching the word table, which must still render.
 */

type Leaf = { readonly path: string; readonly value: unknown };

function leaves(value: unknown, prefix = ''): Leaf[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => leaves(entry, `${prefix}[${String(index)}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) =>
      leaves(child, prefix === '' ? key : `${prefix}.${key}`),
    );
  }
  return [{ path: prefix, value }];
}

const enLeaves = leaves(en);
const ptLeaves = leaves(ptBR);

describe('the Deck speaks two languages and means the same thing in both', () => {
  it('has the same shape on both sides, arrays included', () => {
    // The type already forbids a missing key. An array is where it stops helping:
    // `months` is `string[]`, so eleven months compiles.
    expect(ptLeaves.map((leaf) => leaf.path)).toEqual(enLeaves.map((leaf) => leaf.path));
    // A floor rather than a count: the number grows with every screen, and a test that
    // had to be edited on every string would be edited without being read.
    expect(enLeaves.length).toBeGreaterThan(150);
  });

  it('gives every sentence-building function the same arity', () => {
    const arity = (list: readonly Leaf[]): string[] =>
      list
        .filter((leaf) => typeof leaf.value === 'function')
        .map((leaf) => `${leaf.path}/${String((leaf.value as (...args: unknown[]) => unknown).length)}`);

    expect(arity(ptLeaves)).toEqual(arity(enLeaves));
    // And there really are functions to compare — a rule that matched nothing would pass
    // forever.
    expect(arity(enLeaves).length).toBeGreaterThan(0);
  });

  it('translates the vocabulary rather than copying it', () => {
    /*
      Words that are the same in both languages on purpose: proper nouns, an acronym, a
      term this product uses in English in Portuguese too. Everything else being equal is
      a string somebody forgot, and this is the assertion that finds it.
    */
    const SAME_IN_BOTH = new Set([
      'common.none',
      'nav.deck',
      'nav.runs',
      'nav.language',
      'nav.languagePt',
      'nav.languageEn',
      'words.sdd',
      'words.backlog',
      'words.worktree',
      'words.trivial',
      'words.timeout',
      'words.pr_open',
      'words.review',
      'words.risk',
    ]);

    const copied = enLeaves
      .filter((leaf) => typeof leaf.value === 'string' && leaf.value.trim() !== '')
      .filter((leaf, index) => leaf.value === ptLeaves[index]?.value)
      .map((leaf) => leaf.path)
      .filter((path) => !SAME_IN_BOTH.has(path));

    expect(copied).toEqual([]);
  });

  it('renders a token the table has not learned yet, rather than nothing', () => {
    // The server's vocabularies grow. A blank cell hides the gap; the old behaviour —
    // separators to spaces — shows it in English, which is visible and therefore fixable.
    expect(word(ptBR, 'a_brand_new_status')).toBe('a brand new status');
    expect(word(ptBR, 'implementing')).toBe('implementando');
    expect(word(en, 'implementing')).toBe('implementing');
    expect(word(ptBR, undefined)).toBe('—');
  });
});
