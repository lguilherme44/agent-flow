# Deck — design notes

What `agent-flow ui` opens, built from nothing: no reference to the previous dashboard, no
component library, no utility framework. Two typefaces, six tones, one idea.

## The idea

**The run is a recording.** The product already writes `events.jsonl` — every fact with a
timestamp — and the previous dashboard only ever showed the last line. Deck shows the tape.
The run page is built around a *recorder*: the ten stages drawn to true duration, one lane
per task with a bar per attempt, the run's own marks (approval, revision, degradation,
findings), and a playhead. Drag it back and the graph, the task panel and the log show what
the trail said was true at that instant. Release it at the right edge and the server's
answer takes over.

That is the surprise, and it is also the honest surface for the questions people actually
ask after a run: *what was happening when TASK-004 failed the second time*, *how long did
planning take before the review refused it*, *when did somebody force the gate*.

## What the browser may decide

Nothing, and the same rules that held the previous dashboard now scan both bundles
(`test/architecture.test.ts`, `browserFiles()`). Deck adds four of its own:

| Rule | What it pins |
|---|---|
| `DECK-A01` | `lib/replay.ts` imports the contract and `./time`, nothing else. No React, no network, no cache. |
| `DECK-A02` | The fold carries `task_finished.status` **verbatim** as `outcome: string`. It never imports `TaskState`, so it cannot narrow what the log wrote into what the browser recognises. |
| `DECK-A03` | The resource cache exports `invalidate` and no write. The browser asks again; it never remembers. |
| `DECK-A04` | Exactly one file branches on a task-state literal: `lib/tone.ts`, where a word becomes a colour, once. |

Consequences worth knowing:

- **Live is the server's.** When the playhead is live, task states come from `/tasks`,
  stage states from `/stages`, lanes and attention from `/control`. The fold draws history
  only.
- **Unknown is drawn as unknown.** An attempt a second start ran over, with no end
  recorded, is a hatched bar labelled `unknown`. `task_interrupted` ends a bar in the log's
  own word. Nothing is smoothed.
- **Attention is merged, never re-ranked.** The deck page fetches each active run's control
  snapshot and sorts the union by the server's priority, then age. An `AttentionItem.id`
  is stable but not unique within a run — three degradations share one — so React keys
  carry `since` as well. The first version did not, and a duplicate key rendered eight rows
  where six were asked for, out of order. Read the DOM, not the code.

## Vocabulary

**Tones.** `ok` done · `live` moving · `warn` waiting on a person, degraded · `bad` failed
· `idle` not yet · `ghost` absent, unknown, cached. A component sets `data-tone` and reads
`--tone` / `--tone-dim`. `lib/tone.ts` is the only place a status becomes one of these.

**Type.** The UI face is the system stack. Every identifier, number and timestamp is set in
the mono stack with tabular figures, and the run id is set large in it on purpose — a run
id looks like a tail number, and this is a cockpit.

**Ground.** `#0a0b0e`, with a faint dot grid (`24px`, 4.5% white) that reads as an
instrument surface without ever becoming a border. One hairline of amber under the wordmark
is the frame's only colour.

**The tape.** The pipeline as ten cells, the same encoding at 8px in a project lane and at
22px in the run header, and again drawn to true duration on the recorder. A cell narrower
than its word drops the word and keeps the colour (`@container`).

## Screens

| | |
|---|---|
| `/` | Stats · needs-you queue (folded to six) · one lane per project |
| `/p/<project>/runs/<run>` | Header (id, runtime, three progress axes, the tape, the actions the server offers) · this run's attention · **recorder** · graph / task / log |
| `/runs` | History, filtered locally |
| `/crew` | Runner health · routing by role |

A run is always addressed with its project. Run ids restart per project per year, and
`AF-2026-001` exists in several repositories on the same machine. `?task=` and `?at=` ride
along, so a moment in a run is a link.

## Interaction

- The playhead is a `role="slider"`. Drag with a pointer; `←` `→` step through log lines,
  `⇧` steps a minute, `Home` is the start, `End` and `Esc` are live.
- Clicking a lane, a node or a log line selects the task and, for a line, moves the
  playhead to it.
- The gate dialog is a native `<dialog>`: focus is trapped by the browser and `Esc`
  closes. Approve carries no hash. Forcing is a second, separate button and says what it
  records.
- `prefers-reduced-motion` stops every pulse.

## What it does not do

- Pause, resume, cancel: the server has routes; the core has no semantics for them yet.
- Configuration writes, adding a project: unchanged from the previous dashboard.
- Analytics and prompts pages: still in the previous dashboard, one flag away.

## Working on it

```bash
npm run dev:deck          # Vite on :4784, proxying /api to a running `agent-flow ui`
npm run test:deck         # the fold, the scale, the router, the sentences
npm run typecheck:deck
npm run build:deck        # what `ui` serves; restart `ui` after a rebuild — the static
                          # plugin registers a route per file at startup
```
