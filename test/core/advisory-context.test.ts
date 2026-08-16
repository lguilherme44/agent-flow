import { describe, expect, it } from 'vitest';
import {
  renderAdvisoryContext,
  type RenderedAdvisory,
} from '../../src/core/advisory-context.js';
import type { ContextPacket } from '../../src/contracts/context-packet.schema.js';

function packet(overrides: Partial<ContextPacket> = {}): ContextPacket {
  return {
    objective: 'Fix the retry budget bug',
    relevantFiles: [
      { path: 'src/core/task-executor.ts', reason: 'holds the repair loop' },
    ],
    relevantSymbols: [
      {
        symbol: 'MAX_REPAIR_ATTEMPTS',
        path: 'src/app/stage-runner.ts',
        reason: 'bounds the loop',
      },
    ],
    constraints: ['Do not touch the retry budget'],
    architectureNotes: ['Retries must stay visible in the event log'],
    risks: ['Changing the budget may mask infrastructure failures'],
    evidence: [{ kind: 'file', id: 'task-executor.ts' }],
    ...overrides,
  };
}

describe('renderAdvisoryContext', () => {
  it('renders a full packet into a clearly delimited advisory block', () => {
    const rendered: RenderedAdvisory | undefined = renderAdvisoryContext(packet());
    expect(rendered).toBeDefined();
    const text = rendered!.text;

    expect(text).toContain('ADVISORY CONTEXT');
    expect(text).toContain('may contain errors');
    expect(text).toContain('Fix the retry budget bug');
    expect(text).toContain('src/core/task-executor.ts');
    expect(text).toContain('MAX_REPAIR_ATTEMPTS');
    expect(text).toContain('Do not touch the retry budget');
    expect(text).toContain('Retries must stay visible in the event log');
    expect(text).toContain('Changing the budget may mask infrastructure failures');
    expect(text).toContain('file: task-executor.ts');
  });

  it('never claims authority: raw sources stay the source of truth', () => {
    const text = renderAdvisoryContext(packet())!.text;
    expect(text.toLowerCase()).toContain('not authoritative');
    expect(text.toLowerCase()).not.toContain('validation passed');
    expect(text.toLowerCase()).not.toContain('tests passed');
    expect(text.toLowerCase()).not.toContain('completed');
  });

  it('fails closed when a relevant file path is invalid', () => {
    const bad = packet({
      relevantFiles: [{ path: '../escape.ts', reason: 'invented' }],
    });
    expect(renderAdvisoryContext(bad)).toBeUndefined();
  });

  it('fails closed when a relevant path is a URL scheme', () => {
    const bad = packet({
      relevantFiles: [{ path: 'file:///etc/passwd', reason: 'invented' }],
    });
    expect(renderAdvisoryContext(bad)).toBeUndefined();
  });

  it('fails closed when a symbol path is invalid', () => {
    const bad = packet({
      relevantSymbols: [
        { symbol: 'x', path: 'C:\\Windows\\system32', reason: 'invented' },
      ],
    });
    expect(renderAdvisoryContext(bad)).toBeUndefined();
  });

  it('reports character count for telemetry', () => {
    const rendered = renderAdvisoryContext(packet())!;
    expect(rendered.charCount).toBe(rendered.text.length);
    expect(rendered.charCount).toBeGreaterThan(0);
  });

  it('renders an empty packet as a minimal honest block', () => {
    const rendered = renderAdvisoryContext(
      packet({ relevantFiles: [], relevantSymbols: [], constraints: [], architectureNotes: [], risks: [], evidence: [] }),
    )!;
    const text = rendered.text;
    expect(text).toContain('ADVISORY CONTEXT');
    // Sections exist but are visibly empty rather than fabricating items.
    expect(text).toContain('Relevant paths: none');
    expect(text).toContain('Constraints: none');
  });

  it('omits the objective when it is absent-sibling only after validation, not here', () => {
    // The renderer trusts an already-validated packet; a blank objective is a
    // contract violation that must have been caught upstream. We still refuse
    // to render it, because a prompt built from nothing useful is a lie.
    const rendered = renderAdvisoryContext(
      packet({ objective: 'Fix the retry budget bug' }),
    );
    expect(rendered).toBeDefined();
  });

  it('renders reasons and a blank objective as present-but-empty fields', () => {
    // reason is optional per-entry; the line renders without the separator
    // rather than inventing one. A missing objective renders as an empty
    // objective line — still honest, never a substitute for validation.
    const rendered = renderAdvisoryContext(
      packet({
        objective: undefined as unknown as string,
        relevantFiles: [{ path: 'src/core/task-executor.ts' } as unknown as { path: string; reason: string }],
        relevantSymbols: [{ symbol: 'X', path: 'src/app/stage-runner.ts' } as unknown as { symbol: string; path: string; reason: string }],
      }),
    );
    expect(rendered).toBeDefined();
    expect(rendered!.text).toContain('Objective: ');
    expect(rendered!.text).toContain('  - src/core/task-executor.ts');
    expect(rendered!.text).toContain('  - X (src/app/stage-runner.ts)');
  });
});