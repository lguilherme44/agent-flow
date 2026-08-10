import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Executable versions of the rules UI-B is judged against.
 *
 * Every one of these describes a way the dashboard could quietly become a second
 * source of truth about a run. Prose in a doc comment says so today; these say so
 * when somebody adds a store in eight months because it seemed easier.
 */

const SRC = join(import.meta.dirname, '..');

function sources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        out.push({ path: relative(SRC, full), text: readFileSync(full, 'utf8') });
      }
    }
  };

  walk(SRC);
  return out;
}

/** Strips comments and string literals, so prose cannot trip an identifier scan. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

describe('server state lives in the query cache and nowhere else (§88)', () => {
  it('keeps no client-side store', () => {
    // A store holding a copy of `RunState` is the failure §88 names. The cache is
    // the only place server state lives, and a cache that can be invalidated is the
    // only kind that cannot disagree with the server.
    const offenders = sources()
      .filter(({ text }) =>
        /\bzustand\b|createStore\s*\(|useReducer\s*\(|RunStateSchema/.test(codeOnly(text)),
      )
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('imports nothing from the contracts as a value', () => {
    // Type-only, always: importing a schema would pull Zod into the bundle and,
    // worse, invite the browser to validate — which is the server's job, done once,
    // on the way in.
    const offenders: string[] = [];

    for (const { path, text } of sources()) {
      for (const match of text.matchAll(/(?:^|\n)\s*(import[^;]*?)from\s+'@contracts\//g)) {
        if (!/import\s+type/.test(match[1] ?? '')) offenders.push(path);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('polls only when the stream is down (§89)', () => {
    // A dashboard that polls *looks* live until you watch a task finish and count to
    // nine. The one timer in the app belongs to the SSE fallback, and this is what
    // stops a second one appearing next to it.
    const timers = sources().filter(({ text }) =>
      /\brefetchInterval\b|\bsetInterval\s*\(/.test(codeOnly(text)),
    );

    expect(timers.map((entry) => entry.path)).toEqual(['hooks/use-live-events.ts']);
  });
});

describe('the browser sends ids and sentences, never locations (§93)', () => {
  it('builds every request from the one client', () => {
    // `lib/api.ts` is the only file that may call `fetch`. Everything else goes
    // through it, so "no path is ever sent" is a property of one file rather than of
    // however many components happen to make requests.
    const offenders = sources()
      .filter(({ path }) => path !== 'lib/api.ts')
      .filter(({ text }) => /\bfetch\s*\(/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('never puts a plan hash in a request body', () => {
    // §90: the server recomputes the hash from the plan on disk. The browser shows
    // one — it was just displayed to the reader — and sends none, because a hash that
    // arrived from a client could credit an approval to a plan nobody read.
    const client = readFileSync(join(SRC, 'lib/api.ts'), 'utf8');
    const posts = client.slice(client.indexOf('export const api'));

    expect(posts).not.toMatch(/planHash/);
    expect(posts).not.toMatch(/\bpath\b\s*[,:]/);
    expect(posts).not.toMatch(/\bcommand\b\s*[,:]/);
  });
});
