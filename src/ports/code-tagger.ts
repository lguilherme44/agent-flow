import type { FileTags } from '../core/repo-map.js';

/**
 * Reads source files and says what each one defines and mentions.
 *
 * A port because parsing is provider vocabulary in the same way a CLI's flags are: the
 * grammars, their ABI, and which languages exist at all belong below this line, and
 * `core/repo-map.ts` ranks whatever it is given without knowing any of it.
 *
 * **Partial answers are the normal case, and they are not failures.** A repository holds
 * languages no grammar covers, generated files that parse to nothing, and the occasional
 * file that is simply malformed. Measured on a 2.781-file monorepo: 99,9% of Vue and
 * 98,6% of TypeScript parsed clean, and the rest produced no tags. A tagger reports what
 * it read and stays silent about the rest — refusing the whole repository because one
 * file would not parse is the behaviour that makes a tool unusable on real code.
 */
export interface CodeTagger {
  /**
   * Tags for the files this tagger could read.
   *
   * The result may be shorter than the input, and the caller must not assume the order
   * matches: `rankRepo` sorts what it receives precisely so nothing downstream depends on
   * the order a walk or a parser happened to produce.
   */
  tag(files: readonly TaggableFile[]): Promise<readonly FileTags[]>;

  /**
   * The extensions this tagger will attempt, lowercase and dotted (`.ts`, `.vue`).
   *
   * Asked rather than assumed so the caller can skip reading a file nothing will parse —
   * on a monorepo that is most of the tree, and reading it to discard it is the cost the
   * whole repo map exists to avoid.
   */
  supportedExtensions(): readonly string[];

  /**
   * Whether this tagger can work here, and why not when it cannot.
   *
   * Mirrors `RunnerHealth`, and for the reason that port grew one: a component that
   * degrades silently is a component nobody can fix. This one degrades by design — its
   * parser is an optional dependency — so "no map" is both the expected answer on a
   * machine that never installed it and the symptom of every installation problem, and
   * without this they are indistinguishable.
   *
   * Only meaningful after `tag` has been called at least once: loading is deferred to
   * first use, so before that there is nothing to report and `available` is optimistic.
   */
  health(): TaggerHealth;
}

export interface TaggerHealth {
  readonly available: boolean;
  /** What went wrong, in the words the runtime used. Absent when nothing did. */
  readonly detail?: string;
}

export interface TaggableFile {
  /** Repository-relative, forward slashes. Travels through to the rendered map. */
  readonly path: string;
  readonly content: string;
}
