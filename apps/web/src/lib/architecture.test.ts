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

  it('keeps the selected task in one place', () => {
    // The failure UI-28 could most easily have introduced: a graph that
    // remembered which node was selected, beside a table that remembered which
    // row was. Two answers to one question, and the inspector reading whichever
    // it happened to be wired to. The graph takes the selection as a prop and
    // reports changes upward; it stores nothing.
    const graph = sources().find((entry) => entry.path === 'features/dag-view.tsx');
    expect(graph).toBeDefined();
    expect(codeOnly(graph?.text ?? ''), 'the graph keeps its own selection').not.toMatch(
      /useState\s*[<(]/,
    );

    // And exactly one component owns it.
    const owners = sources()
      .filter(({ text }) => /useState<string \| undefined>\(undefined\)/.test(codeOnly(text)))
      .filter(({ text }) => /selectedTask/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(owners).toEqual(['pages/RunDetailPage.tsx']);
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

/**
 * The team is the server's answer, drawn and never recomputed (M5, §43, I-33).
 *
 * A browser that ranked its own candidates would be a second assignment authority. Its
 * first disagreement with the run puts a decision nobody made on an operator's screen —
 * and the operator has no way to tell, because the screen is where they would have
 * looked to find out.
 */
describe('the browser draws the assignment and does not compute one (M5)', () => {
  const TEAM_FILES = ['features/team.tsx', 'features/dag-view.tsx', 'features/task-inspector.tsx'];

  it('scores nothing, weights nothing and ranks nothing', () => {
    // Reading `score` to draw it is the point of the table; multiplying it is the policy
    // reimplemented here. A `*` adjacent to one of the term names is the tell.
    //
    // **Both directions, and the first version only caught one.** It matched
    // `skillMatch *`, and a weighted sum is written `0.55 * skillMatch` — so the rule
    // passed over exactly the shape it exists to forbid. Found by injecting that line
    // and watching this test stay green, which is the only way to learn that a rule
    // reporting nothing is reporting on anything at all.
    const WEIGHTED =
      /\*\s*[\w.[\]!?]*\b(?:skillMatch|ownership|riskFit|score)\b|\b(?:skillMatch|ownership|riskFit|score)\s*\*|\bSCORE_WEIGHTS\b/;

    const offenders = sources()
      .filter(({ path }) => TEAM_FILES.includes(path))
      .filter(({ text }) => WEIGHTED.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('re-sorts no candidate list', () => {
    // The order *is* the ranking, and it is total and stable by construction on the
    // server (I-35). A `.sort()` here would be a second tie-break, and the two would
    // disagree the first time two members scored the same.
    const offenders = sources()
      .filter(({ path }) => TEAM_FILES.includes(path))
      .filter(({ text }) => /\bcandidates[^;]{0,60}\.sort\s*\(/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('decides no member’s status', () => {
    // I-39. `status` is derived on the server from the run's own task states; a
    // component comparing `assigned.length` against a capacity would be deriving it a
    // second time, and after a crash the two would disagree about who is working.
    const offenders = sources()
      .filter(({ path }) => path === 'features/team.tsx')
      .filter(({ text }) => /maxConcurrentTasks\s*(?:<=|>=|<|>|===)/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('reads the team from the one query that fetches it', () => {
    // One endpoint, one cache key. A second fetch would be a second instant, and a
    // repaint could show a member idle beside the task they are running.
    const fetchers = sources()
      .filter(({ text }) => /['"`]\/runs\/\$\{[^}]+\}\/team['"`]/.test(text))
      .map(({ path }) => path);

    expect(fetchers).toEqual(['lib/api.ts']);
  });
});

/**
 * The browser draws a review; it does not decide one (M6 §59, I-44).
 *
 * Four things the charter names by name — review status, a finding's blocking status, a
 * gate's pass/fail and a review's freshness — and one of them used to be computed here.
 */
describe('the browser renders the review and derives none of it (M6)', () => {
  it('compares no commit to decide freshness', () => {
    // `assessReviewFreshness` lived in `lib/review-freshness.ts` and compared a review's
    // `integrationHead` against the run's. Identity against the integrated tree is the
    // only thing that answers freshness, and only the server knows both halves — so a
    // comparison here is a second authority whose first disagreement puts a decision
    // nobody made on screen.
    // Narrow on purpose. `integrationHead === undefined` is a presence check and a
    // legitimate one; what is forbidden is comparing it against *another value*, which is
    // the freshness decision. A rule broad enough to catch the presence check would have
    // needed an allowlist, and a rule with an allowlist stops meaning anything.
    //
    // The `[A-Za-z_$]` at the end is load-bearing: without it `\s*` matches zero, the
    // lookahead lands on the space before `undefined`, and every presence check reads as
    // a comparison. The first version of this rule did exactly that.
    // `\?\.` as well as `.`: the first version matched only `a.integrationHead` and let
    // `gate.review?.integrationHead` through — which is how the mutation that reinstates
    // the derivation was written, and it passed.
    const COMPARISON =
      /integrationHead\s*===\s*(?!(?:undefined|null)\b)[A-Za-z_$]|===\s*[\w.?]*integrationHead\b/;

    const offenders = sources()
      .filter(({ text }) => COMPARISON.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('turns no exit code into a gate status', () => {
    // Colouring one command's own recorded exit code is display of a fact. Producing a
    // `GateStatus` from one is the decision `core/review/gates.ts` makes, and the
    // difference is whether the value crosses into the vocabulary the workflow gates on.
    const offenders = sources()
      .filter(({ text }) =>
        /exitCode[^;\n]{0,40}['"](?:passed|failed|not_run|not_applicable)['"]/.test(codeOnly(text)),
      )
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('decides no gate is unsatisfied by weighing required against status', () => {
    // `required && status !== 'passed'` is `unsatisfiedRequired`, and it is the sentence
    // that turns evidence into a refusal. One place answers it.
    const offenders = sources()
      .filter(({ text }) => /required[^;\n]{0,60}status\s*!==/.test(codeOnly(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('decides no finding blocking by comparing severities', () => {
    // Which severities block is configuration a person wrote, weighed by
    // `core/review/decision.ts`. A component ranking them would be a second policy.
    const offenders = sources()
      .filter(({ text }) =>
        /severity\s*===\s*'(?:critical|high)'|indexOf\([\w.]*severity/.test(codeOnly(text)),
      )
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});
