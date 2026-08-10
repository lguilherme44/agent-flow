import { describe, it, expect } from 'vitest';
import { annotateScaffold } from '../../src/adapters/git/git-client.js';

/**
 * Reported independently by both reviewers, in both live stacks.
 *
 * `init` appends to .gitignore and writes AGENTS.md. When that happens after
 * the last commit — which is the normal order, since `init` is the first thing
 * anyone runs — those files sit in the working tree and land in the diff that
 * `review` later judges. Codex called AGENTS.md "an instruction file that can
 * alter future agent validation and workflow behavior", which is exactly right
 * and exactly the problem: agent-flow's own scaffolding arrives inside a
 * feature delivery, unreviewed.
 *
 * The files are not hidden — hiding them would be worse, since a hand-edited
 * AGENTS.md is genuinely part of a change. They are labelled, so a reviewer
 * spends its findings on the feature instead of on the tool.
 */
describe('scaffolding is labelled, not hidden', () => {
  const changes = [
    { status: 'M', path: 'src/retrykit/retry.py' },
    { status: 'M', path: '.gitignore' },
    { status: '??', path: 'AGENTS.md' },
    { status: '??', path: '.agent-flow/runs/AF-2026-001/state.json' },
  ];

  it('marks the files agent-flow wrote itself', () => {
    const rendered = annotateScaffold(changes);

    expect(rendered).toMatch(/AGENTS\.md.*agent-flow/);
    expect(rendered).toMatch(/\.gitignore.*agent-flow/);
  });

  it('leaves the feature own files unmarked', () => {
    const rendered = annotateScaffold(changes);
    const line = rendered.split('\n').find((l) => l.includes('retry.py')) ?? '';

    expect(line).not.toMatch(/agent-flow/);
  });

  it('still lists every changed file', () => {
    // Filtering them out would hide a hand-edited AGENTS.md, which is a real
    // part of a change and the reviewer's business.
    const rendered = annotateScaffold(changes);

    for (const change of changes) expect(rendered).toContain(change.path);
  });

  it('says nothing when nothing changed', () => {
    expect(annotateScaffold([])).toBe('No files were changed.');
  });
});
