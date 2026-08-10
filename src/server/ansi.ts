/**
 * Terminal escape removal (§74).
 *
 * A CLI writing colour into a log is normal; a browser rendering the raw bytes
 * is not. Stripping happens on the way *out* rather than on the way in, because
 * the log on disk should stay exactly what the process produced — the file is
 * evidence, and sanitised evidence is a different thing.
 *
 * The escape byte is built with `fromCharCode` rather than typed, so this file
 * contains no control characters of its own. A literal one in source survives
 * copy-paste, diffs and editors badly, and this module is the one place where
 * getting it wrong is silent.
 */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/**
 * Operating-system commands: window titles, hyperlinks. Removed first, because
 * their payload can contain something that looks like a colour sequence, and
 * stripping colours first would leave the payload behind as text.
 */
const OSC = new RegExp(`${ESC}\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\)`, 'g');

/** Control sequences: colour, cursor movement, erase. */
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

/** Anything left that begins with an escape, plus lone escapes. */
const REMAINING = new RegExp(`${ESC}[@-_]?`, 'g');

export function stripAnsi(text: string): string {
  return text.replace(OSC, '').replace(CSI, '').replace(REMAINING, '');
}
