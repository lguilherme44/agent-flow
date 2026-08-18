import { describe, it, expect } from 'vitest';
import { chooseInstructionSource, readInstruction } from '../../src/cli/instruction-source.js';

/**
 * AR-08 — the shell-quoting hazard, removed.
 *
 * The evidence run passed multi-paragraph instructions to `revise` as shell arguments
 * twice. Both times the shell owned the text before Agent Flow saw it: a backtick is
 * command substitution, a `$` is expansion, an unescaped newline ends the command, and a
 * lone apostrophe in prose opens a quote that never closes. None of that is visible in the
 * instruction that arrives — it arrives already mangled, or the shell hangs waiting for a
 * quote, and the person retypes it shorter.
 *
 * "Shorter" is the actual cost. An instruction is the one place a person says what they
 * want changed, and a channel that punishes length gets short instructions.
 */

describe('choosing where the instruction comes from', () => {
  it('takes the argument when that is all there is', () => {
    const chosen = chooseInstructionSource({ argument: 'split TASK-003' });
    expect(chosen).toEqual({ kind: 'argument', instruction: 'split TASK-003' });
  });

  it('reads a file when asked', () => {
    expect(chooseInstructionSource({ file: 'notes.md' })).toEqual({
      kind: 'file',
      path: 'notes.md',
    });
  });

  it('treats a lone dash as stdin, which is what a dash means everywhere else', () => {
    expect(chooseInstructionSource({ argument: '-' })).toEqual({ kind: 'stdin' });
  });

  it('opens an editor when asked', () => {
    expect(chooseInstructionSource({ edit: true })).toEqual({ kind: 'editor' });
  });

  it('refuses two sources rather than silently preferring one', () => {
    // Preferring one would discard the other, and the discarded one is the text the
    // person spent longer writing about half the time.
    const chosen = chooseInstructionSource({ argument: 'quick note', file: 'notes.md' });
    expect(chosen).toMatchObject({ kind: 'refused' });
    if (chosen.kind !== 'refused') return;
    expect(chosen.reason).toContain('one');
  });

  it('refuses when there is no instruction at all', () => {
    const chosen = chooseInstructionSource({});
    expect(chosen).toMatchObject({ kind: 'refused' });
    if (chosen.kind !== 'refused') return;
    // Names the alternatives, because the reason a person got here is not knowing them.
    expect(chosen.reason).toContain('--file');
  });
});

describe('reading it', () => {
  const io = {
    readFile: (path: string) =>
      path === 'notes.md' ? 'Split TASK-003.\n\nIt does two things.\n' : undefined,
    readStdin: async () => 'from a pipe\n',
    openEditor: async () => 'typed in $EDITOR\n',
  };

  it('keeps a file instruction whole, blank lines and all', async () => {
    // The point of the milestone. A shell argument cannot carry this.
    const read = await readInstruction({ kind: 'file', path: 'notes.md' }, io);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.instruction).toContain('\n\n');
    expect(read.instruction).toBe('Split TASK-003.\n\nIt does two things.');
  });

  it('reads stdin', async () => {
    const read = await readInstruction({ kind: 'stdin' }, io);
    expect(read.ok && read.instruction).toBe('from a pipe');
  });

  it('reads what the editor left behind', async () => {
    const read = await readInstruction({ kind: 'editor' }, io);
    expect(read.ok && read.instruction).toBe('typed in $EDITOR');
  });

  it('refuses a file that is not there, naming it', async () => {
    const read = await readInstruction({ kind: 'file', path: 'missing.md' }, io);

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toContain('missing.md');
  });

  it('refuses an empty instruction rather than re-planning identically', async () => {
    // An editor opened and closed without typing, or a pipe with nothing in it. Re-planning
    // on an empty revision spends the planner and returns roughly what was already there —
    // which reads to the person as though the tool ignored them.
    const read = await readInstruction(
      { kind: 'editor' },
      { ...io, openEditor: async () => '   \n\n' },
    );

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toMatch(/empty|nothing/i);
  });

  it('passes the argument through untouched', async () => {
    const read = await readInstruction({ kind: 'argument', instruction: 'do it' }, io);
    expect(read.ok && read.instruction).toBe('do it');
  });
});
