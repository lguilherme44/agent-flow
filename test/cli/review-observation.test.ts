import { describe, expect, it } from 'vitest';
import { awaitingObservationText, readObservation } from '../../src/cli/review.js';
import type { InstructionIO } from '../../src/cli/instruction-source.js';
import { createProgram } from '../../src/cli/index.js';
import { SECOND_PERSON_OBSERVING } from '../fakes/second-person.js';

/**
 * `agent-flow review --e2e-observed` at the command line: where the human's words and name
 * come from. The use case judges them; this only has to deliver them intact, from one
 * source, and refuse an observation nobody put their name to.
 */

const FILE_TEXT = [
  'Opened the cart on the iPhone 15 (iOS 18.2).',
  '',
  "The header shows the new total; it didn't before.",
].join('\n');

const io: InstructionIO = {
  readFile: (path) => (path === '/notes/observed.md' ? `\n${FILE_TEXT}\n\n` : undefined),
  readStdin: () => Promise.resolve('  seen via stdin  '),
  openEditor: () => Promise.reject(new Error('review never opens an editor')),
};

describe('readObservation', () => {
  it('reads nothing when no observation flag was given', async () => {
    expect(await readObservation({ fix: true }, io)).toEqual({ ok: true });
  });

  it('takes the argument and the name, trimmed at the ends', async () => {
    expect(await readObservation({ e2eObserved: '  Saw it.  ', observedBy: ' Luis ' }, io)).toEqual({
      ok: true,
      observation: { by: 'Luis', words: 'Saw it.' },
    });
  });

  it('carries the tested build when the human named one', async () => {
    expect(
      await readObservation({ e2eObserved: 'Saw it.', observedBy: 'Luis', e2eHead: ' abcdef0 ' }, io),
    ).toEqual({ ok: true, observation: { by: 'Luis', words: 'Saw it.', head: 'abcdef0' } });
  });

  // Dogfood 09/10: what the human saw, attached as images (the use case copies them in).
  it('carries the evidence files with the observation, and refuses them without one', async () => {
    expect(
      await readObservation({ e2eObserved: 'Saw it.', observedBy: 'Luis', evidence: ['a.png', 'b.png'] }, io),
    ).toEqual({ ok: true, observation: { by: 'Luis', words: 'Saw it.', evidence: ['a.png', 'b.png'] } });

    const alone = await readObservation({ evidence: ['a.png'] }, io);
    expect(alone.ok).toBe(false);
    if (!alone.ok) expect(alone.reason).toContain('--e2e-observed');
  });

  it('accepts --evidence as a repeatable flag at the command line', () => {
    const review = createProgram().program.commands.find((command) => command.name() === 'review');
    expect(review?.options.some((option) => option.long === '--evidence')).toBe(true);
  });

  it('reads a file whole, paragraphs and apostrophes included', async () => {
    expect(
      await readObservation({ e2eObservedFile: '/notes/observed.md', observedBy: 'Luis' }, io),
    ).toEqual({ ok: true, observation: { by: 'Luis', words: FILE_TEXT } });
  });

  it('reads stdin for -', async () => {
    expect(await readObservation({ e2eObserved: '-', observedBy: 'Luis' }, io)).toEqual({
      ok: true,
      observation: { by: 'Luis', words: 'seen via stdin' },
    });
  });

  it('refuses an observation nobody put their name to', async () => {
    for (const observedBy of [undefined, '   ']) {
      const read = await readObservation(
        { e2eObserved: 'Saw it.', ...(observedBy === undefined ? {} : { observedBy }) },
        io,
      );
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.reason).toContain('--observed-by');
    }
  });

  it('refuses a name or a build with no observation to attach them to', async () => {
    for (const flags of [{ observedBy: 'Luis' }, { e2eHead: 'abcdef0' }]) {
      const read = await readObservation(flags, io);
      expect(read.ok, JSON.stringify(flags)).toBe(false);
      if (read.ok) return;
      expect(read.reason).toContain('--e2e-observed');
    }
  });

  it('refuses both text flags at once rather than silently dropping one', async () => {
    const read = await readObservation(
      { e2eObserved: 'a', e2eObservedFile: '/notes/observed.md', observedBy: 'Luis' },
      io,
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toContain('--e2e-observed-file');
  });

  it('refuses an empty observation and a missing file', async () => {
    const empty = await readObservation({ e2eObserved: '   ', observedBy: 'Luis' }, io);
    expect(empty).toEqual({ ok: false, reason: expect.stringContaining('observation is empty') as unknown });
    const missing = await readObservation({ e2eObservedFile: '/nope.md', observedBy: 'Luis' }, io);
    expect(missing).toEqual({ ok: false, reason: 'No such file: /nope.md' });
  });
});

describe('what review prints when only the observation is missing', () => {
  it('asks for the human, names the build, and never tells the reader to observe', () => {
    const text = awaitingObservationText('abcdef0123456789abcdef0123456789abcdef01');
    expect(text).toMatch(/\bhuman\b/);
    expect(text).toContain('abcdef0');
    expect(text).toContain('--observed-by');
    expect(text).toContain('--e2e-head abcdef0');
    expect(text).not.toMatch(SECOND_PERSON_OBSERVING);
  });

  it('says no commit names the tree when there is none', () => {
    const text = awaitingObservationText(undefined);
    expect(text).not.toContain('--e2e-head');
    expect(text).not.toMatch(SECOND_PERSON_OBSERVING);
  });
});

describe('the review command registers its flags', () => {
  it('offers the observation flags on review', () => {
    const review = createProgram().program.commands.find((command) => command.name() === 'review');
    const flags = review?.options.map((option) => option.long) ?? [];
    expect(flags).toEqual(
      expect.arrayContaining([
        '--fix',
        '--e2e-observed',
        '--e2e-observed-file',
        '--observed-by',
        '--e2e-head',
      ]),
    );
  });
});
