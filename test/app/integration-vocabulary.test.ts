import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { INTEGRATION_REFUSAL_CODES, MARKER_TRAILERS } from '../../src/app/integrator.js';
import { RECOVERY_REFUSAL_CODES } from '../../src/app/worktree-recovery.js';

/**
 * The specification and the code, pinned to each other (Appendix A, §12.4).
 *
 * Every other test in this suite asserts that the code does what the code was
 * asked to do. These two assert that what it was asked to do is what the
 * specification says — which is a different failure and, on this milestone, the
 * one that actually happened: `integration_unreadable` was raised in four places
 * and documented in none, and no test could notice because no test read the
 * appendix.
 *
 * **Reading a document in a test is deliberate, and it is not a style choice.** A
 * vocabulary is a contract between a refusal a person sees and a table they look
 * it up in, and the only way to hold two files in agreement is to compare them.
 * The alternative — a duplicated list in a test file — pins the code to the test
 * author's memory of the spec, which is the thing that drifted.
 *
 * Both parsers are strict and fail loudly. A regex that silently matched nothing
 * would turn either test into an assertion that two empty sets are equal.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const SPEC = join(ROOT, 'docs', 'specs', 'mvp2-safe-parallel-execution.md');

function spec(): string {
  return readFileSync(SPEC, 'utf8');
}

/** The section between one `## ` heading and the next. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}`);
  if (start === -1) throw new Error(`the spec has no "## ${heading}" section`);
  const rest = text.slice(start + 1);
  const end = rest.indexOf('\n## ', 1);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Appendix A's table, as `code → who raises it`.
 *
 * Only the three-column rows of the refusal table are read. The appendix also
 * contains a two-column explanation table, and matching that one as well would
 * make "documented" mean "mentioned anywhere in the section", which is weaker
 * than what is being claimed here.
 */
function appendixA(): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of section(spec(), 'Appendix A — Refusal codes').split('\n')) {
    const match = /^\|\s*`([a-z_]+)`\s*\|([^|]*)\|([^|]*)\|\s*$/.exec(line.trim());
    if (match === null) continue;
    rows.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  if (rows.size === 0) throw new Error('Appendix A parsed to zero refusal codes');
  return rows;
}

/**
 * The trailer names §12.4's example message carries, in the order it carries them.
 *
 * The fenced block is located by its subject line rather than by counting fences,
 * so inserting a code block earlier in the section cannot silently retarget this.
 */
function specTrailers(): string[] {
  const body = section(spec(), '12. Marker commits');
  const start = body.indexOf('agent-flow: TASK-003 attempt 2');
  if (start === -1) throw new Error('§12.4 has no marker message example');
  const end = body.indexOf('```', start);
  if (end === -1) throw new Error('§12.4 marker message example is unterminated');

  const names = body
    .slice(start, end)
    .split('\n')
    .map((line) => /^(Agent-Flow-[A-Za-z-]+):/.exec(line.trim())?.[1])
    .filter((name): name is string => name !== undefined);

  if (names.length === 0) throw new Error('§12.4 example carries no trailers');
  return names;
}

describe('Appendix A is the canonical refusal vocabulary', () => {
  it('documents every code the Integrator can raise', () => {
    const documented = appendixA();
    const undocumented = INTEGRATION_REFUSAL_CODES.filter((code) => !documented.has(code));

    // The message names them, because "a code is missing" without saying which
    // one sends the next reader back through both files by hand.
    expect(
      undocumented,
      `these codes are raised by src/app/integrator.ts and absent from Appendix A: ${
        undocumented.join(', ') || 'none'
      }`,
    ).toEqual([]);
  });

  it('raises every code it attributes to the Integrator', () => {
    // The other direction, and the one that rots quietly: a code deleted from the
    // module stays in the appendix forever, and a person looking up a refusal they
    // will never see has no way to know the entry is dead.
    //
    // **This direction is deliberately the weaker of the two, and the reason is
    // in the appendix rather than here.** "Raised by" names the layer that
    // *decides*, not the class that returns the value: `namespace_missing` says
    // `GitWorkspaces` and reaches a caller through the Integrator, because the
    // decision is `decideNamespace`'s and the Integrator only performs it. So only
    // rows that explicitly say `Integrator` are checked. Demanding that every code
    // the module can return also be attributed to it would force the appendix to
    // describe a call stack, which is the less useful of the two things it could
    // describe. The first test is what catches an undocumented code, and it has no
    // such exemption.
    const orphaned = [...appendixA()]
      .filter(([, raisedBy]) => /Integrator/.test(raisedBy))
      .map(([code]) => code)
      .filter((code) => !(INTEGRATION_REFUSAL_CODES as readonly string[]).includes(code));

    expect(
      orphaned,
      `Appendix A attributes these to the Integrator and the module cannot raise them: ${
        orphaned.join(', ') || 'none'
      }`,
    ).toEqual([]);
  });

  it('carries integration_unreadable, the code that made this test necessary', () => {
    // A regression test for the omission itself, rather than for the mechanism
    // that would now catch it. If the pin above is ever loosened, this still
    // fails.
    expect(appendixA().has('integration_unreadable')).toBe(true);
    expect(INTEGRATION_REFUSAL_CODES).toContain('integration_unreadable');
  });

  it('documents every code crash recovery can originate (M2-07)', () => {
    // The strong direction, and the one that catches an undocumented refusal: a
    // code recovery can put in front of a person and the appendix does not list is
    // a code nobody can look up. M2-07 adds no vocabulary of its own — it meets the
    // same world the Integrator does — so every entry here must already be there.
    const documented = appendixA();
    const undocumented = RECOVERY_REFUSAL_CODES.filter((code) => !documented.has(code));

    expect(
      undocumented,
      `these codes are raised by src/app/worktree-recovery.ts and absent from Appendix A: ${
        undocumented.join(', ') || 'none'
      }`,
    ).toEqual([]);
  });

  it('originates every code it attributes to recovery', () => {
    // The other direction, with the same deliberate weakness the Integrator's has:
    // "Raised by" names the layer that *decides*, so a code recovery merely
    // propagates — `integration_conflict`, `integration_history_unrecognised` — is
    // the Integrator's row and is not required here. Only rows that name recovery
    // are checked.
    const orphaned = [...appendixA()]
      .filter(([, raisedBy]) => /recovery/.test(raisedBy))
      .map(([code]) => code)
      .filter((code) => !(RECOVERY_REFUSAL_CODES as readonly string[]).includes(code));

    expect(
      orphaned,
      `Appendix A attributes these to recovery and the module cannot originate them: ${
        orphaned.join(', ') || 'none'
      }`,
    ).toEqual([]);
  });

  it('marks no recovery refusal forcible either', () => {
    // `attempt_tree_missing` reads "no — requeues" rather than a bare "no", which
    // is the appendix saying what happens *instead* of halting. Both are refusals
    // nobody overrides, so the check is on the "no" rather than on the whole cell.
    for (const line of section(spec(), 'Appendix A — Refusal codes').split('\n')) {
      const match = /^\|\s*`([a-z_]+)`\s*\|([^|]*)\|([^|]*)\|\s*$/.exec(line.trim());
      if (match === null) continue;
      if (!(RECOVERY_REFUSAL_CODES as readonly string[]).includes(match[1] ?? '')) continue;
      expect((match[3] ?? '').trim().replace(/\*/g, ''), match[1]).toMatch(/^no\b/);
    }
  });

  it('marks no integration refusal forcible', () => {
    // §6.4 and Appendix A's opening claim: none of these changes what the run is,
    // and none of them is something a person overrides with `--force`. A forcible
    // integration refusal would mean merging over a failed tree binding.
    for (const line of section(spec(), 'Appendix A — Refusal codes').split('\n')) {
      const match = /^\|\s*`([a-z_]+)`\s*\|([^|]*)\|([^|]*)\|\s*$/.exec(line.trim());
      if (match === null) continue;
      if (!(INTEGRATION_REFUSAL_CODES as readonly string[]).includes(match[1] ?? '')) continue;
      expect((match[3] ?? '').trim().replace(/\*/g, '')).toBe('no');
    }
  });
});

/**
 * Appendix B's event names, from the fenced block that lists them.
 *
 * The payload shape after the name is deliberately not parsed. What this pins is
 * that the name reaches `events.jsonl` at all; the fields are checked by the
 * tests that assert on the events those modules emit, where a wrong field is a
 * visible failure rather than a documentation drift.
 */
function appendixB(): string[] {
  const body = section(spec(), 'Appendix B — New events');
  const start = body.indexOf('```text');
  const end = body.indexOf('```', start + 7);
  if (start === -1 || end === -1) throw new Error('Appendix B has no event block');

  const names = body
    .slice(start, end)
    .split('\n')
    .map((line) => /^([a-z][a-z_]+)\s{2,}\{/.exec(line.trim())?.[1])
    .filter((name): name is string => name !== undefined);

  if (names.length === 0) throw new Error('Appendix B parsed to zero events');
  return names;
}

/** Every event name any module under `src/` passes to `appendEvent`. */
function emittedEvents(): Set<string> {
  const found = new Set<string>();

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;

      // `appendEvent(<something>, '<name>'` — the second argument, as a literal.
      // A name assembled from a variable would not be found, and that is the
      // intended reading: an event whose name a module computes is one no reader
      // can look up either.
      for (const match of readFileSync(path, 'utf8').matchAll(
        /appendEvent\(\s*[^,]+,\s*'([a-z][a-z_]+)'/g,
      )) {
        found.add(match[1] ?? '');
      }
    }
  };

  walk(join(ROOT, 'src'));
  if (found.size === 0) throw new Error('no appendEvent call sites found under src/');
  return found;
}

describe('Appendix B is the canonical event vocabulary', () => {
  it('specifies only events that something emits', () => {
    // The direction that matters, and the one M2-12 found broken twice.
    // `run_git_identity_assigned` and `namespace_reclaimed` were specified from
    // the start of this milestone and emitted by nothing, so a run's history
    // recorded neither the mode it was born in nor what `clean` later removed —
    // both of them facts the spec says the audit trail carries.
    const emitted = emittedEvents();
    const silent = appendixB().filter((name) => !emitted.has(name));

    expect(
      silent,
      `Appendix B specifies these events and no module under src/ emits them: ${
        silent.join(', ') || 'none'
      }`,
    ).toEqual([]);
  });

  it('carries attempt_tree_missing, which §17.3 names as an event', () => {
    // The regression test for the omission itself. Window 10 says "event
    // `attempt_tree_missing`", recovery emits it, and the appendix listed every
    // other event this milestone added. A reader building on the audit trail
    // would have had no reason to expect it.
    expect(appendixB()).toContain('attempt_tree_missing');
    expect(emittedEvents().has('attempt_tree_missing')).toBe(true);
  });

  it('names no event twice', () => {
    const names = appendixB();
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('§12.4 specifies the marker trailers the Integrator verifies', () => {
  it('specifies exactly ten', () => {
    // The number is asserted on its own because it is the number the review
    // process kept getting wrong — eight were checked for a while, and the two
    // that were left out were the two describing what the validation was asked
    // to do.
    expect(specTrailers()).toHaveLength(10);
  });

  it('agrees with MARKER_TRAILERS, name for name and in order', () => {
    // Order is asserted rather than set membership. The trailers are compared
    // against the artifact in this sequence and rendered into the message in it,
    // so a reordering that a set comparison would call equal changes a commit
    // message every marker carries.
    expect([...MARKER_TRAILERS]).toEqual(specTrailers());
  });

  it('names no trailer twice', () => {
    const names = specTrailers();
    expect(new Set(names).size).toBe(names.length);
  });
});
