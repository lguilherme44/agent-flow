import { describe, it, expect } from 'vitest';
import {
  checkCitations,
  citationsIn,
  resolveCitedPath,
  tasksWithNoExistingFile,
} from '../../../src/core/review/citations.js';

/**
 * Whether what a document says about the code points at anything real.
 *
 * Measured on 04/11/2026: a plan declared `backoffice/app/routes/plan-edit.tsx` and
 * `plan-create.tsx` for one task. The directory existed; neither file did, anywhere. Plausible
 * names, invented whole, with nothing between the plan and the executor to tell.
 */

const tree = new Map([
  ['src/app/run-actions.ts', 4200],
  ['src/core/review/decision.ts', 180],
  ['docs/roadmap.md', 90],
  ['bflowbarber-app/src/components/ProductCard.vue', 700],
]);

describe('reading citations out of a document', () => {
  it('finds a path with a line', () => {
    const [found] = citationsIn('see src/app/run-actions.ts:915 for the gate');

    expect(found?.path).toBe('src/app/run-actions.ts');
    expect(found?.start).toBe(915);
  });

  it('reads a range and a symbol', () => {
    const [found] = citationsIn('ProductCard.vue:680-694#resolveClientTier does it');

    expect(found?.start).toBe(680);
    expect(found?.end).toBe(694);
    expect(found?.symbol).toBe('resolveClientTier');
  });

  it('does not read a version or a clock as a citation', () => {
    expect(citationsIn('since v1.2:3, measured at 10.30:00')).toHaveLength(0);
  });

  it('does not read a host and port as a file and line', () => {
    // `api.example.com:443` is a port. Only when there is no slash: `docs/a.io:3` is a path.
    expect(citationsIn('calls api.example.com:443')).toHaveLength(0);
    expect(citationsIn('see docs/a.io:3')).toHaveLength(1);
  });

  it('ignores a URL and an absolute path', () => {
    expect(citationsIn('https://host/x/a.ts:9 and /etc/a.conf:3')).toHaveLength(0);
  });

  it('ignores everything inside a fenced block', () => {
    // Command output: its paths are relative to wherever the command ran, not to this tree.
    const text = ['before src/app/run-actions.ts:1', '```', 'made/up/path.ts:999', '```'].join('\n');

    expect(citationsIn(text).map((c) => c.path)).toEqual(['src/app/run-actions.ts']);
  });

  it('records the line of the citing document, not of the cited file', () => {
    const [found] = citationsIn(['first', 'second', 'see docs/roadmap.md:4'].join('\n'));

    expect(found?.line).toBe(3);
    expect(found?.start).toBe(4);
  });
});

describe('checking citations against the tree', () => {
  it('accepts a citation inside the file', () => {
    expect(checkCitations(citationsIn('src/core/review/decision.ts:180'), tree)).toHaveLength(0);
  });

  it('reports a file that does not exist', () => {
    const [problem] = checkCitations(citationsIn('backoffice/app/routes/plan-edit.tsx:12'), tree);

    expect(problem?.reason).toBe('no-such-file');
  });

  it('reports a line past the end of the file', () => {
    const [problem] = checkCitations(citationsIn('src/core/review/decision.ts:9999'), tree);

    expect(problem?.reason).toBe('line-out-of-range');
    expect(problem?.detail).toContain('180');
  });

  it('resolves a slash-less name by its basename, as specs write them', () => {
    expect(resolveCitedPath('ProductCard.vue', tree)).toBe(
      'bflowbarber-app/src/components/ProductCard.vue',
    );
  });

  it('leaves an ambiguous basename unresolved rather than guessing', () => {
    const two = new Map([
      ['a/index.ts', 10],
      ['b/index.ts', 10],
    ]);

    expect(resolveCitedPath('index.ts', two)).toBeUndefined();
  });
});

describe('a task whose declared files all fail to resolve', () => {
  it('names the task that invented its paths', () => {
    const flagged = tasksWithNoExistingFile(
      [
        { id: 'TASK-005', files: ['src/app/run-actions.ts'] },
        { id: 'TASK-006', files: ['backoffice/app/routes/plan-edit.tsx', 'plan-create.tsx'] },
      ],
      tree,
    );

    expect(flagged.map((entry) => entry.task)).toEqual(['TASK-006']);
  });

  it('says nothing about a task that declares no files', () => {
    // Absence of a declaration is not a claim about a file.
    expect(tasksWithNoExistingFile([{ id: 'TASK-001', files: [] }], tree)).toHaveLength(0);
  });

  it('stays quiet when at least one file resolves', () => {
    // A task that touches one real file and creates another is ordinary work, not invention.
    const flagged = tasksWithNoExistingFile(
      [{ id: 'TASK-002', files: ['src/app/run-actions.ts', 'src/app/brand-new.ts'] }],
      tree,
    );

    expect(flagged).toHaveLength(0);
  });
});
