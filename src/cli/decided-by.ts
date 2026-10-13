import { existsSync, readFileSync } from 'node:fs';
import type { GateDecision } from '../contracts/index.js';
import { readInstruction, type InstructionIO, type InstructionWording } from './instruction-source.js';

/**
 * `--decided-by` and `--words` on every human decision at the terminal — `approve`, `reject`,
 * `revise`, `answer`, `cancel`, and `retry` when it overrides a gate — who decided, in their
 * own words.
 *
 * **Required, and never filled in.** This terminal records as `keyboard`, which an AI driving
 * the CLI is too, so the name and the words are the only thing on the run that says a human
 * decided. A default from git's `user.name` or the OS user would make an AI's approval look
 * like a person's — the one outcome the flags exist to prevent — so there is none.
 *
 * The words arrive the way an e2e observation does: an argument, `-` for stdin, or
 * `--words-file` for anything a shell would mangle. Presence is judged here, before anything
 * is read; the bounds are the use case's (`readGateDecision`), so they cannot drift from
 * the API's.
 */
export interface DecidedByFlags {
  /** `--decided-by <name>`: the human who decided. */
  readonly decidedBy?: string;
  /** `--words <text>`: their exact words, or `-` for stdin. */
  readonly words?: string;
  /** `--words-file <path>`: those words from a file. */
  readonly wordsFile?: string;
}

export const DECISION_WORDING: InstructionWording = {
  noun: 'words',
  empty: 'The words are empty; there is no decision to record.',
};

/**
 * Addressed to whoever typed the command — usually an AI — so it asks for the human and
 * says plainly that the AI may not supply either field itself.
 */
const MISSING = [
  'A human decision (a gate move, an answer, a cancel, a forced retry) is recorded with the name and the exact words of the human who made it:',
  '  --decided-by "<their name>" --words "<their exact words>"',
  '  (or --words-file <path>, or --words - to read stdin)',
  'This terminal records as keyboard, as an AI driving it does, so these are what say a person decided.',
  'Ask the human for both. An AI must not invent either, nor take them from git or the OS user.',
].join('\n');

export async function readDecidedBy(
  flags: DecidedByFlags,
  io: InstructionIO,
  /**
   * The command's own text already uses the terminal — read from stdin (`revise -`) or
   * written in an editor (`revise --edit`) — so the words cannot come from stdin. With
   * `--edit` the words would drain stdin first and the editor would then open on a closed
   * one, which is not a refusal anybody could read.
   */
  options: { readonly stdinTaken?: boolean } = {},
): Promise<{ readonly ok: true; readonly decision: GateDecision } | { readonly ok: false; readonly reason: string }> {
  const by = flags.decidedBy?.trim();
  if (by === undefined || by === '' || (flags.words === undefined && flags.wordsFile === undefined)) {
    return { ok: false, reason: MISSING };
  }
  if (flags.words !== undefined && flags.wordsFile !== undefined) {
    return {
      ok: false,
      reason: 'Give the words one way only: --words "<text>" (or - for stdin), or --words-file <path>.',
    };
  }
  if (flags.words === '-' && options.stdinTaken === true) {
    return {
      ok: false,
      reason:
        'The instruction already uses the terminal (- for stdin, or --edit), so the words ' +
        'cannot be read from stdin too: give them with --words "<text>" or --words-file <path>.',
    };
  }

  const source =
    flags.wordsFile !== undefined
      ? { kind: 'file' as const, path: flags.wordsFile }
      : flags.words === '-'
        ? { kind: 'stdin' as const }
        : { kind: 'argument' as const, instruction: flags.words ?? '' };
  const read = await readInstruction(source, io, DECISION_WORDING);
  if (!read.ok) return { ok: false, reason: read.reason };

  return { ok: true, decision: { by, words: read.instruction, channel: 'cli' } };
}

/**
 * The machine, for the words. No editor: a decision is the human's sentence, quoted, and an
 * editor buffer is where an AI would compose one.
 */
export function nodeDecisionIO(): InstructionIO {
  return {
    readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
    readStdin: async () => {
      let text = '';
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) text += chunk as string;
      return text;
    },
    openEditor: () => Promise.reject(new Error('the words of a decision are never written in an editor')),
  };
}
