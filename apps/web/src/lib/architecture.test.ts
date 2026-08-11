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
  return withoutComments(text)
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/** Comments gone, strings kept — for rules about what the screen says. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
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

describe('the graph is drawn from the server’s answer, never derived (UI-28)', () => {
  it('works out no readiness of its own', () => {
    // `ready` and `blocked` are §22's rules, computed by `core/dag` and served
    // through the application layer. A browser that decided either would be a
    // second scheduler — one that is never wrong on screen and never right on
    // disk, because nothing would ever compare them.
    const offenders = sources()
      .filter(({ text }) =>
        /readyTasks|blockedByFailure|topologicalOrder|buildDag/.test(codeOnly(text)),
      )
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('builds its adjacency from the served edges, not from a task’s own field', () => {
    // `TaskSummaryView.dependencies` is there to be *displayed* — the inspector
    // lists them. Building the picture from it would mean the graph and the
    // server could disagree about which edges exist, and the server is the one
    // that validated them against the plan.
    for (const file of ['lib/dag-layout.ts', 'features/dag-view.tsx']) {
      const source = sources().find((entry) => entry.path === file);
      expect(source, `${file} is missing`).toBeDefined();
      expect(codeOnly(source?.text ?? ''), `${file} reads a task's dependencies`).not.toMatch(
        /\.dependencies\b/,
      );
    }
  });

  it('claims no critical path', () => {
    // §92 defers it, and the highlight this view has answers a different, much
    // cheaper question: what a task waits for and what waits on it. Calling that
    // a critical path would be a claim about duration the view cannot support.
    //
    // Comments are stripped and strings are kept — the opposite of `codeOnly`.
    // A doc comment explaining why this is *not* a critical path is the thing
    // that keeps somebody from renaming it into one; a label on screen saying it
    // is one is the failure.
    const offenders = sources()
      .filter(({ text }) => /critical[\s_-]?path/i.test(withoutComments(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
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
