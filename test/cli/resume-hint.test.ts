import { describe, expect, it } from 'vitest';
import { resumeHint } from '../../src/cli/feature.js';
import { planningResume } from '../../src/core/resume.js';

/**
 * D7, at the surface: the resume sentence renders the fold rather than asserting again.
 *
 * Here rather than beside the fold because importing the CLI pulls in ,
 * which puts the file in the subprocess lane — and the fold itself deserves to stay in
 * the fast one.
 */
describe('the resume sentence is rendered from the fold', () => {
  it('names what runs again, on the class where something does', () => {
    const hint = resumeHint('sdd', 'high-risk');

    expect(hint).toContain('Kept: architecture-impact');
    expect(hint).toContain('Runs again: discovery');
    expect(hint).toContain('--from sdd');
  });

  it('says nothing about re-running when nothing does', () => {
    const hint = resumeHint('planning', 'standard');

    expect(hint).toContain('Kept: discovery, architecture-impact, sdd');
    expect(hint).not.toContain('Runs again');
  });

  it('positive control: it never claims a kept stage that re-runs', () => {
    // Asserted over the output rather than over the source, because the source *does*
    // still contain the old sentence — quoted in the comment that explains why it went.
    // A control that a comment can break is a control that gets deleted.
    //
    // The property: for every class and every resume point, a stage named as kept must
    // not also be one the fold says runs again. That is exactly the claim that was false.
    for (const workflow of ['trivial', 'simple', 'standard', 'high-risk'] as const) {
      for (const stage of ['architecture-impact', 'sdd', 'planning', 'plan-review'] as const) {
        const hint = resumeHint(stage, workflow);
        const { rerun } = planningResume(stage, workflow);
        for (const redone of rerun) {
          const claimed = /Kept: ([^.]*)/.exec(hint)?.[1] ?? '';
          expect(claimed, `${workflow} --from ${stage}`).not.toContain(redone);
        }
      }
    }
  });
});
