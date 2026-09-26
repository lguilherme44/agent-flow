/**
 * Where a `revise` instruction comes from (AR-08).
 *
 * **The evidence run passed multi-paragraph instructions as shell arguments twice.** Both
 * times the shell owned the text before Agent Flow saw it. A backtick is command
 * substitution, a `$` is expansion, an unescaped newline ends the command, and a lone
 * apostrophe in prose opens a quote that never closes — so the instruction either arrives
 * mangled or the terminal hangs, and the person retypes it shorter.
 *
 * "Shorter" is the actual cost, and it is not cosmetic. A revision is the one place someone
 * says what they want changed about a plan; a channel that punishes length collects short
 * instructions, and a short instruction re-plans badly.
 *
 * Four sources, one chosen: the argument, a file, stdin, or an editor. The choice is pure
 * and the reading is injected, so both are testable without a terminal.
 */

export type InstructionSource =
  | { readonly kind: 'argument'; readonly instruction: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'stdin' }
  | { readonly kind: 'editor' }
  | { readonly kind: 'refused'; readonly reason: string };

export interface InstructionFlags {
  readonly argument?: string;
  readonly file?: string;
  readonly edit?: boolean;
}

/**
 * What the text is called in a refusal, and what an empty one costs.
 *
 * Several commands read text this way and they are not the same text (D15). `revise` reads an
 * instruction about a plan; `feature` reads the description the whole run is planned
 * from — the measured one was 9 KB with backticks, quotes and paragraph breaks, and had
 * to be launched from a Node script with `spawn` because no shell would carry it. A
 * refusal that says "instruction" to somebody who typed `feature` sends them to the
 * wrong command's help.
 */
export interface InstructionWording {
  /** The noun in every refusal: `instruction`, `description`. */
  readonly noun: string;
  /** Why an empty text is refused rather than passed on. */
  readonly empty: string;
}

export const REVISION_WORDING: InstructionWording = {
  noun: 'instruction',
  empty: 'The instruction is empty; nothing to revise against.',
};

export const DESCRIPTION_WORDING: InstructionWording = {
  noun: 'description',
  empty: 'The description is empty; there is nothing to plan a feature from.',
};

/**
 * `answer` reads what a BLOCKED task needs to know (P7.1). It is the third text read this
 * way, and the one most likely to be long: an agent that stopped usually asked something a
 * sentence does not settle, and the reply tends to carry a snippet or a list.
 */
export const ANSWER_WORDING: InstructionWording = {
  noun: 'answer',
  empty: 'The answer is empty; the blocked task would get nothing it did not already have.',
};

/**
 * Exactly one source, or a refusal.
 *
 * Two sources refuse rather than resolving by precedence. Precedence would discard one of
 * them silently, and the discarded one is the longer text about half the time.
 */
export function chooseInstructionSource(
  flags: InstructionFlags,
  wording: InstructionWording = REVISION_WORDING,
): InstructionSource {
  // A lone `-` means stdin, as it does in every other tool that reads text.
  const fromStdin = flags.argument === '-';
  const fromArgument = flags.argument !== undefined && !fromStdin;

  const chosen = [fromArgument, flags.file !== undefined, fromStdin, flags.edit === true].filter(
    Boolean,
  ).length;

  if (chosen > 1) {
    return {
      kind: 'refused',
      reason: `Give the ${wording.noun} one way only: an argument, --file, --edit, or - for stdin.`,
    };
  }

  if (flags.file !== undefined) return { kind: 'file', path: flags.file };
  if (fromStdin) return { kind: 'stdin' };
  if (flags.edit === true) return { kind: 'editor' };
  if (fromArgument && flags.argument !== undefined) {
    return { kind: 'argument', instruction: flags.argument };
  }

  return {
    kind: 'refused',
    reason: `No ${wording.noun}. Pass it as an argument, or use --file <path>, --edit, or - to read stdin.`,
  };
}

export interface InstructionIO {
  /** `undefined` when the path does not resolve — the caller names it in the refusal. */
  readonly readFile: (path: string) => string | undefined;
  readonly readStdin: () => Promise<string>;
  readonly openEditor: () => Promise<string>;
}

export type ReadInstruction =
  | { readonly ok: true; readonly instruction: string }
  | { readonly ok: false; readonly reason: string };

export async function readInstruction(
  source: Exclude<InstructionSource, { kind: 'refused' }>,
  io: InstructionIO,
  wording: InstructionWording = REVISION_WORDING,
): Promise<ReadInstruction> {
  const text = await textOf(source, io);
  if (text === undefined) {
    return {
      ok: false,
      reason: source.kind === 'file' ? `No such file: ${source.path}` : 'Nothing to read.',
    };
  }

  // Trimmed at the ends only. The interior is the whole point: paragraph breaks, lists and
  // indentation are what a file carries that an argument cannot.
  const instruction = text.trim();
  if (instruction === '') {
    // An editor opened and closed without typing, or an empty pipe. Re-planning on an empty
    // revision spends the planner and returns roughly what was already there, which reads
    // to the person as though the tool ignored them.
    return { ok: false, reason: wording.empty };
  }

  return { ok: true, instruction };
}

async function textOf(
  source: Exclude<InstructionSource, { kind: 'refused' }>,
  io: InstructionIO,
): Promise<string | undefined> {
  switch (source.kind) {
    case 'argument':
      return source.instruction;
    case 'file':
      return io.readFile(source.path);
    case 'stdin':
      return io.readStdin();
    case 'editor':
      return io.openEditor();
  }
}
