import { describe, it, expect } from 'vitest';
import { TreeSitterTagger } from '../../src/adapters/tagger/tree-sitter-tagger.js';

/**
 * The tagger, against the two shapes that decide whether a repo map is usable here.
 *
 * A `.vue` single-file component is three languages in one file, and on the repository
 * this was built for it is the *majority* of the code — 136.334 lines against 68.310 of
 * TypeScript. A tagger blind to it would map a third of the tree and call it a map.
 */
describe('TreeSitterTagger', () => {
  const tagger = new TreeSitterTagger();

  it('reads definitions and references out of TypeScript', async () => {
    const [tags] = await tagger.tag([
      {
        path: 'src/money.ts',
        content: [
          'import { padLeft } from "./pad.js";',
          'export interface Money { cents: number }',
          'export function formatMoney(value: Money): string {',
          '  return padLeft(String(value.cents));',
          '}',
        ].join('\n'),
      },
    ]);

    expect(tags?.defs).toContain('formatMoney');
    expect(tags?.defs).toContain('Money');
    expect(tags?.refs).toContain('padLeft');
  });

  it('reads the script out of a single-file component', async () => {
    // The measured shape: `<script setup lang="ts">` first, template and style after.
    const [tags] = await tagger.tag([
      {
        path: 'src/components/ItemCard.vue',
        content: [
          '<script setup lang="ts">',
          'import { formatCurrency } from "@/utils/formatters";',
          'const props = defineProps<{ price: number }>();',
          'function label(): string { return formatCurrency(props.price); }',
          '</script>',
          '',
          '<template><div class="ap-card">{{ label() }}</div></template>',
          '',
          '<style scoped>.ap-card { border-radius: 12px }</style>',
        ].join('\n'),
      },
    ]);

    expect(tags?.defs).toContain('label');
    expect(tags?.refs).toContain('formatCurrency');
  });

  it('does not mistake template or style text for code', async () => {
    // The positive control for the test above: if the whole file were parsed as
    // TypeScript, the CSS selector and the template markup would both turn into
    // identifiers and the graph would fill with nouns nobody wrote.
    const [tags] = await tagger.tag([
      {
        path: 'src/components/Styled.vue',
        content: [
          '<script setup lang="ts">',
          'const x = 1;',
          '</script>',
          '<template><ap-totally-not-a-symbol /></template>',
          '<style>.definitely-not-a-symbol { color: red }</style>',
        ].join('\n'),
      },
    ]);

    const everything = [...(tags?.defs ?? []), ...(tags?.refs ?? [])].join(' ');
    expect(everything).not.toMatch(/totally-not-a-symbol|definitely-not-a-symbol/);
  });

  it('takes what a module publishes, not what its functions keep inside', async () => {
    // **The defect the first real run exposed, and the tests above did not.** Taking every
    // declaration anywhere in the tree made the top-ranked file's symbols come back as
    // `res`, `n`, `idx`, `opts`, `row` — local variables. A map of somebody's loop counters
    // costs tokens to say nothing.
    const [tags] = await tagger.tag([
      {
        path: 'src/service.ts',
        content: [
          'export function resolve(input: string): string {',
          '  const res = input.trim();',
          '  const idx = res.indexOf("x");',
          '  let opts = { idx };',
          '  return String(opts.idx);',
          '}',
          'const MODULE_LEVEL = 1;',
        ].join('\n'),
      },
    ]);

    expect(tags?.defs).toContain('resolve');
    expect(tags?.defs).toContain('MODULE_LEVEL');
    for (const local of ['res', 'idx', 'opts']) expect(tags?.defs).not.toContain(local);
  });

  it('takes references where one file names another’s work, not every identifier', async () => {
    // The same fix from the other side: a local named `state` is not a reference to some
    // other file's `state`, and collecting it filled the graph with edges nobody wrote.
    const [tags] = await tagger.tag([
      {
        path: 'src/caller.ts',
        content: [
          'import { formatCurrency } from "@/utils/formatters";',
          'export function show(): string {',
          '  const state = 1;',
          '  const total = state + 2;',
          '  return formatCurrency(total);',
          '}',
        ].join('\n'),
      },
    ]);

    expect(tags?.refs).toContain('formatCurrency');
    expect(tags?.refs).not.toContain('total');
  });

  it('keeps going when one file will not parse', async () => {
    // The contract the port states: a repository holds generated files, unknown dialects
    // and the occasional broken file, and one of them must not cost the other thousands.
    const tags = await tagger.tag([
      { path: 'broken.ts', content: 'function ((((( {' },
      { path: 'fine.ts', content: 'export function ok(): void {}' },
    ]);

    expect(tags.map((file) => file.path)).toContain('fine.ts');
  });

  it('skips a file no grammar covers rather than reading it', async () => {
    const tags = await tagger.tag([
      { path: 'docs/README.md', content: '# Title\n\nSome prose about formatMoney.' },
    ]);

    expect(tags).toEqual([]);
  });

  it('answers with nothing for a component that has no script', async () => {
    const tags = await tagger.tag([
      { path: 'src/Presentational.vue', content: '<template><p>hi</p></template>' },
    ]);

    expect(tags).toEqual([]);
  });

  it('declares the extensions it will attempt, including .vue', async () => {
    // Asked rather than assumed by the caller, so a monorepo's images and lockfiles are
    // never read just to be discarded.
    expect(tagger.supportedExtensions()).toContain('.vue');
    expect(tagger.supportedExtensions()).toContain('.ts');
    expect(tagger.supportedExtensions()).not.toContain('.md');
  });
});
