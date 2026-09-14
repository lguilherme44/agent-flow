import { createRequire } from 'node:module';
import type Parser from 'web-tree-sitter';
import type { FileTags } from '../../core/repo-map.js';
import type { CodeTagger, TaggableFile, TaggerHealth } from '../../ports/code-tagger.js';

/**
 * Symbols, by parsing. The only place in this product that knows tree-sitter exists.
 *
 * **The versions are pinned exactly, and that is not tidiness.** `tree-sitter-wasms@0.1.13`
 * ships grammars built against an older tree-sitter ABI than `web-tree-sitter@0.27`, and
 * loading one with the other fails inside the runtime's `getDylinkMetadata` with a bare
 * `Error` and no message. Measured while building this: the pairing that works is
 * `web-tree-sitter@0.24.7`. A caret on either line turns that into a failure somebody
 * debugs from scratch, so both are exact in `package.json` and this comment is why.
 *
 * **Two passes for a single-file component**, because a `.vue` file is three languages in
 * one. The `vue` grammar splits the shell into `script`, `template` and `style`; the
 * script's text is then reparsed with the TypeScript grammar. Measured on a 782-component
 * repository: 99,9% parsed clean that way, against 98,6% for the plain TypeScript files —
 * the format that looked like the risk turned out to be the better-behaved half.
 *
 * **Loaded dynamically, because the grammars are an optional 50 MB.** `tree-sitter-wasms`
 * ships thirty compiled grammars and measures larger than every runtime dependency this
 * package has put together — 50 MB against 23 — for an artifact that makes one stage
 * cheaper and that the product is designed to work without. So it is an
 * `optionalDependency` and the import happens at first use: a machine that did not install
 * it gets no map, and "no map" is the state every run was in before this existed, which
 * `discovery.md` says out loud and `buildRepoMap` returns as `undefined`.
 *
 * The type import above survives because it is erased at compile time — types cost a
 * consumer nothing, which is exactly why the value import is the one that had to move.
 */

/** Dotted, lowercase. `.vue` earns its place: it was two thirds of one repository's lines. */
const GRAMMARS: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.vue': 'vue',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.java': 'java',
  '.kt': 'kotlin',
  '.cs': 'c_sharp',
  '.php': 'php',
  '.swift': 'swift',
  '.dart': 'dart',
};

/** A `.vue` script block is parsed as this. */
const SFC_SCRIPT_GRAMMAR = 'typescript';

/**
 * Node types that introduce a name worth ranking.
 *
 * Shared across grammars on purpose: tree-sitter's node names converge on these for the
 * languages above, and a per-language table would be nineteen things to keep in step for
 * a ranking that only needs to know *that* a name exists.
 */
const DEFINITION_NODES = new Set([
  'function_declaration',
  'function_definition',
  'generator_function_declaration',
  'class_declaration',
  'class_definition',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'struct_item',
  'enum_item',
  'trait_item',
  'function_item',
  'lexical_declaration',
  'variable_declaration',
]);

/**
 * **Only what a module publishes, and this was learned the expensive way.**
 *
 * The first version took every `lexical_declaration` anywhere in the tree, and the first
 * real run said exactly what that is worth: the top-ranked file's "definitions" came back
 * as `res`, `n`, `idx`, `opts`, `row` — the local variables inside its functions. A map of
 * somebody's loop counters is worse than no map, because it costs tokens to say nothing.
 *
 * A definition counts when it sits at module scope: a direct child of the file, or of an
 * `export_statement`. That is the surface another file can actually depend on, and it is
 * the only surface an edge in the graph can mean anything about.
 */
const MODULE_SCOPE_PARENTS = new Set(['program', 'export_statement', 'module', 'source_file']);

/**
 * Where a cross-file reference can actually appear.
 *
 * The first version collected every identifier in the tree. Two things were wrong with
 * that, and they were the same thing: a local variable named `state` is not a reference to
 * some other file's `state`, so the graph filled with edges nobody wrote — and reading the
 * text of half a million nodes took 1m09s on a monorepo where parsing alone takes seconds.
 *
 * These four positions are where one file names another's work. Narrowing to them made the
 * graph mean something and made the walk cheap, which is the same fix twice.
 */
const REFERENCE_PARENTS = new Set([
  'call_expression',
  'import_statement',
  'import_specifier',
  'type_annotation',
  'generic_type',
  'type_identifier',
  'new_expression',
  'extends_clause',
  'implements_clause',
]);

/** How deep a node may sit below a declaration and still be taken as its name. */
const NAME_FIELDS = ['name', 'declarator', 'pattern'];

export interface TreeSitterTaggerOptions {
  /**
   * Where the `.wasm` grammars live.
   *
   * Resolved from the installed package by default. Injectable because the packaged CLI
   * and a test run from source do not agree about where `node_modules` is, and a path
   * built by string-joining `import.meta.url` would be a guess that works in one of them.
   */
  readonly grammarDir?: string;
}

export class TreeSitterTagger implements CodeTagger {
  private readonly configuredDir: string | undefined;
  private readonly loaded = new Map<string, Parser.Language>();
  private runtime: typeof Parser | undefined;
  private ready: Promise<void> | undefined;
  private failure: string | undefined;

  constructor(options: TreeSitterTaggerOptions = {}) {
    this.configuredDir = options.grammarDir;
  }

  supportedExtensions(): readonly string[] {
    return Object.keys(GRAMMARS);
  }

  health(): TaggerHealth {
    if (this.failure !== undefined) return { available: false, detail: this.failure };
    return { available: true };
  }

  async tag(files: readonly TaggableFile[]): Promise<readonly FileTags[]> {
    await this.init();

    // The optional dependency is not installed here. No map, which is a state the whole
    // chain above already handles — and a far better one than a crash on a machine that
    // never asked for 50 MB of grammars.
    if (this.runtime === undefined) return [];

    const parser = new this.runtime();
    const out: FileTags[] = [];

    for (const file of files) {
      const grammar = GRAMMARS[extensionOf(file.path)];
      if (grammar === undefined) continue;

      try {
        const tags = this.tagOne(parser, file, grammar);
        // A file that parsed to nothing is not evidence of anything and would only add a
        // node with no edges. Dropping it keeps the graph about code that says something.
        if (tags.defs.length > 0 || tags.refs.length > 0) out.push(tags);
      } catch {
        // **Silence here is the contract, not a swallowed bug** (see `CodeTagger`). One
        // unparseable file in a monorepo must not cost the other 2.780, and a tagger that
        // threw would make the map an all-or-nothing artifact on real code.
      }
    }

    return out;
  }

  private tagOne(parser: Parser, file: TaggableFile, grammar: string): FileTags {
    let source = file.content;
    let language = grammar;

    if (grammar === 'vue') {
      const script = sfcScript(parser, this.language('vue'), file.content);
      if (script === undefined) return { path: file.path, defs: [], refs: [] };
      source = script;
      language = SFC_SCRIPT_GRAMMAR;
    }

    parser.setLanguage(this.language(language));
    const tree = parser.parse(source);

    const defs: string[] = [];
    const refs: string[] = [];
    // Iterative rather than recursive: a generated file can nest deeply enough to end a
    // run on stack depth, and that is a crash for the whole map rather than one file.
    const stack: Parser.SyntaxNode[] = [tree.rootNode];

    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) continue;

      if (DEFINITION_NODES.has(node.type)) {
        if (isModuleScope(node)) {
          const name = nameOf(node);
          if (name !== undefined) defs.push(name);
        }
      } else if (node.type === 'identifier' || node.type === 'type_identifier') {
        // Reading a node's text is a substring of the whole file, so it is done for the
        // few nodes that can carry a cross-file name and not for the hundreds of
        // thousands that cannot. See REFERENCE_PARENTS.
        const parent = node.parent;
        if (parent !== null && REFERENCE_PARENTS.has(parent.type)) refs.push(node.text);
      }

      for (let i = 0; i < node.childCount; i += 1) {
        const child = node.child(i);
        if (child !== null) stack.push(child);
      }
    }

    return { path: file.path, defs, refs };
  }

  private language(name: string): Parser.Language {
    const language = this.loaded.get(name);
    if (language === undefined) throw new Error(`grammar "${name}" was not loaded`);
    return language;
  }

  /**
   * Loads the runtime and every grammar, once.
   *
   * The promise is cached rather than a boolean, so two concurrent `tag` calls wait on one
   * initialisation instead of racing into two — `Parser.init()` is not re-entrant.
   */
  private async init(): Promise<void> {
    this.ready ??= (async () => {
      let grammarDir: string;
      try {
        // Both halves of the optional dependency, resolved at first use. Either being
        // absent means the same thing and is handled the same way: this tagger answers
        // with nothing and the product goes on without a map.
        const module = await import('web-tree-sitter');
        grammarDir = this.configuredDir ?? defaultGrammarDir();
        const runtime = module.default;
        await runtime.init();
        this.runtime = runtime;
      } catch (error) {
        // Recorded rather than swallowed. The whole point of an optional parser is that it
        // may be absent, which makes "absent" both the expected state on one machine and
        // the symptom of a broken install on another — and a caller cannot tell those apart
        // from an empty result.
        this.failure = error instanceof Error ? error.message : String(error);
        return;
      }

      for (const grammar of new Set(Object.values(GRAMMARS))) {
        try {
          this.loaded.set(
            grammar,
            await this.runtime.Language.load(`${grammarDir}/tree-sitter-${grammar}.wasm`),
          );
        } catch (error) {
          // A grammar that will not load costs its languages and nothing else — the
          // extension simply stops being supported, which `tag` already handles. The first
          // failure is kept anyway, because every grammar failing for one reason is the
          // shape a broken installation takes, and an empty map with no explanation is the
          // symptom nobody can act on.
          this.failure ??= error instanceof Error ? error.message : String(error);
        }
      }
    })();

    return this.ready;
  }
}

/**
 * The `<script>` block of a single-file component, or nothing.
 *
 * The delimiters are stripped by text rather than by walking into the grammar's children,
 * because the `vue` grammar models the block's content as raw text anyway — and the
 * offsets it gives are the reliable part.
 */
function sfcScript(parser: Parser, vue: Parser.Language, source: string): string | undefined {
  parser.setLanguage(vue);
  const tree = parser.parse(source);
  const stack: Parser.SyntaxNode[] = [tree.rootNode];

  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    if (node.type === 'script_element') {
      return source
        .slice(node.startIndex, node.endIndex)
        .replace(/^[\s\S]*?<script[^>]*>/, '')
        .replace(/<\/script>[\s\S]*$/, '');
    }
    for (let i = 0; i < node.childCount; i += 1) {
      const child = node.child(i);
      if (child !== null) stack.push(child);
    }
  }

  return undefined;
}

/**
 * Whether this declaration is part of the file's surface rather than a function's insides.
 *
 * Walks at most one link, through `export_statement`, because that is the only wrapper
 * between a module and its published declarations in the grammars here. Anything deeper is
 * inside something, which is the definition of not being published.
 */
function isModuleScope(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  if (parent === null) return true;
  if (MODULE_SCOPE_PARENTS.has(parent.type)) return true;
  return parent.type === 'export_statement' && MODULE_SCOPE_PARENTS.has(parent.parent?.type ?? '');
}

function nameOf(node: Parser.SyntaxNode): string | undefined {
  for (const field of NAME_FIELDS) {
    const child = node.childForFieldName(field);
    if (child === null) continue;
    if (child.type === 'identifier' || child.type === 'type_identifier') return child.text;

    const nested = child.childForFieldName('name');
    if (nested !== null) return nested.text;
  }

  const first = node.descendantsOfType('identifier')[0];
  return first?.text;
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot).toLowerCase();
}

/**
 * The installed grammar directory, resolved through Node rather than composed as a path.
 *
 * `createRequire` asks the resolver where the package actually is, which is the one
 * answer that survives being bundled, linked, hoisted, or run from a different working
 * directory — four arrangements this CLI is measured in.
 */
function defaultGrammarDir(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('tree-sitter-wasms/package.json');
  return `${entry.slice(0, entry.lastIndexOf('package.json'))}out`.replaceAll('\\', '/');
}
