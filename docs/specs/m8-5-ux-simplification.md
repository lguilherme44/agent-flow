# M8.5 — the dashboard simplification pass

M8 made the product true. It did not make it readable.

Everything the run page knew, it drew: a run panel with a hero header, an isolation strip
and a nine-step pipeline; a task panel with its own title, search box, five filter chips
and a five-count strip; the board or the graph or the table inside it; an inspector; four
summary cards; and the review, delivery, team and collaboration panels stacked under all
of it. Every one of those is a projection the server folded, and every one of them was
correct. They were also all on screen at once.

Measured at 1440×900 against the reference run, before any of this:

| | |
|---|---|
| document height | **1753px**, for a 900px viewport |
| board | **555px** — 32% of the page |
| chrome above the board | **450px** |
| panels below the fold | **850px** |
| statements of the task count on one screen | **3** (`3 / 9` header, `3 / 9` summary, `TOTAL 9` strip) |
| partitions of the same nine tasks | **2** (five-count strip, six lane badges) |
| uses of the word "running" meaning three different things | **4** |

This milestone moved nothing out of the product and removed no fact from it. It changed
how many of them are on screen at one time.

---

## The rule

```text
show the next decision first
hide the rest behind intentional interaction
```

Operationally: **if an operator does not need a fact in the next thirty seconds, it does
not get permanent space on the main screen.** It gets a tab.

The test of that rule is what is *absent*. A run page showing the pipeline, the task
counts and four summary cards at the same time as the board has failed it, whatever each
of those looks like on its own — which is why the composition test in
`RunDetailPage.test.tsx` asserts six `queryBy…` calls returning null.

---

## The three layers

**Always visible.** The sidebar, one header row, an attention strip when there is one, the
tab strip, and the chosen surface.

```text
run id · IMPLEMENTING · feature        3/9 tasks · 41m22s · stage 7 of 9 · 50% ▓▓▓  [⏵]
P1  the plan is waiting for a decision                            Review the plan →
Board  Graph  Tasks  Overview  Review  Delivery  Team              [search] [filters]
──────────────────────────────────────────────────────────────────────────────────────
                          the surface, filling the viewport
```

The header carries only what changes while you watch. `Started by you` is a constant in
local mode; `Today at 19:34` is the run's birthday. Both moved to Overview. `stage 7 of 9`
is the nine-chip pipeline's answer in nine characters — the strip itself, with its
durations, runners and models, is one click away.

**On demand.** The inspector: a pane beside the table and the graph, a drawer over the
board. Not a width rule. The board's lanes are 244px each and there are six of them, so a
400px pane leaves 560 — two lanes and a sliver, photographed at 1200 with `IN PROGRESS`
sliced down its middle. A table reflows its own columns and a canvas refits its own
viewport, and both are genuinely better beside the detail than under it.

**Secondary navigation.** Overview, Review, Delivery, Team — and Graph and Tasks, which are
the other two renderings of the task list.

**A tab whose projection has nothing behind it is not rendered.** This is the same "absent
rather than empty" the review, delivery and collaboration panels already applied to
themselves, moved up one level so it costs a door rather than a room. Most runs have no
reviewer and no forge, and they show four tabs rather than seven.

---

## What this found

Simplification is a search. Three defects were sitting under the density and came out when
it lifted; none of them was introduced by this pass, and none of them could have failed a
gate.

### `?panel=` and `?task=` were links to nowhere

`routeFor` in `attention.ts` has emitted `?panel=approval`, `?panel=review`,
`?panel=quality`, `?panel=delivery`, `?panel=team` and `&task=<id>` since M8. `RunDetailPage`
read only `?view=`. **Six of the attention queue's seven destinations navigated to a page
that ignored what they asked for** — a P1 row reading "Review the findings" landed on the
run with the review panel 1300 pixels below the fold and nothing pointing at it.

Three tests covered this and all three were green. `attention.test.tsx` asserted the
*string* `routeFor` returns. `M8-ACC-19` asserted two regular expressions against
`RunDetailPage.tsx`'s source and stated in its own comment that `?task=` round-tripped
while asserting nothing about it. A URL parameter nobody reads fails no compiler, no
linter and no assertion.

The URL contract now lives in `apps/web/src/lib/run-surface.ts` — plain `.ts`, no JSX,
precisely so the node acceptance suite can *call* `surfaceFromParams` over every surface
rather than grep for it.

### The delivery panel rendered as unstyled HTML

`DeliveryPanel` shipped in M7 written against ten class names — `card`, `card__header`,
`delivery__detail`, `delivery__facts`, `delivery__checks`, `delivery__check--success`,
`badge--delivery-published` and their neighbours — that **no stylesheet in this repository
defines** and that are not Tailwind utilities either. An unstyled `<h2>`, a `<dl>` with
browser default margins and a bulleted `<ul>`, inside an app where every other panel is a
`Panel`.

Nothing was going to catch it. A class nobody writes down fails no compiler, no linter and
no DOM assertion, because the element is there and simply has no style. And the only
delivery fixture in the repository was `DELIVERY_NONE`, whose state is `disabled`, so the
component's own guard clause returned `null` in every unit test and in all 296 visual
baselines. There was no `delivery.test.tsx`.

**A component no fixture renders is a component with no guaranteed appearance.** It has a
fixture now — `checks_red`, deliberately, because that is the composition M7 §57 has the
most to say about — a test file, and a baseline at four widths. The first photograph found
a second defect immediately: `Last sync` was printing a raw ISO string, the only
unformatted date anywhere in the app. It also drew the `ForgeFailure` on the projection,
which nothing ever had: a run whose publication was refused for want of a token showed the
state and never the reason.

### The shell and the content used two palettes and two typefaces

`ops-control.css` opened with a second `:root` — `--surface-1`, `--text-primary`,
`--sidebar-w`, its own radii, shadows and spacing — beside the `--af-*` set in
`tokens.css`. Probed in the browser, the sidebar rendered `#11151E` against a panel's
`#0B111C` on a `#070B14` page, with text `#F0F2F5` against `#F1F5F9`. Nobody chose either
step; they are what two answers to one question produce.

It also opened with a Google Fonts `@import` for Inter and JetBrains Mono, and
`.app-layout` set `font-family` to a stack headed by Inter. `tailwind.config.js` states in
its own comment that nothing loads Inter, that every browser falls through to `system-ui`,
and that both committed baseline sets are pictures of that fallback. The probe said `Inter
loaded`, and the computed family on `h1`, on every `Panel` and on the command bar was
Inter. **A loopback tool with no authentication and no cloud was reaching the public
internet to decide how wide a column is**, and every measured width in `tokens.css` was
reasoned about in a face the app was not using.

And **sixty-one of that file's hundred and seventeen classes were dead**: a whole DAG
renderer, a whole log viewer, an agent list, an attention block and a metrics row — the
skeleton of a mockup that shipped beside the app it was a mockup of.

---

## What was removed

| | why |
|---|---|
| Focus mode | It collapsed the summary cards and the secondary panels so the tasks could have the screen. The tasks have the screen. |
| Fullscreen DAG | The Graph tab already fills the viewport minus a 44px bar, a 48px header and a 37px strip. |
| The count strip, on the board | The second statement of the same nine tasks, directly above lane badges partitioning them a different way. It keeps the Tasks tab, where nothing else counts the run. |
| `Integration Head` on the approval card | The isolation strip already reports it beside the branch it is the tip of. Invisible while they were 900px apart; obvious on one surface. |
| `Tasks 3 / 9` from the Overview metadata row | Third copy of a number the header shows always and the execution summary shows with a bar. |
| The `OPERATIONAL` and `SYSTEM` sidebar headings | Two categories nobody navigates by, on a list of seven. A hairline says it for free. |
| The sidebar version block and the topbar `L` avatar | Three constants and a duplicate. A footer of constants is a footer people stop looking at. |
| `--af-bottom-height` | Sized a band that no longer exists. A token nothing reads is a measurement nobody can trust. |
| 61 CSS rules, a second `:root`, and a webfont import | Above. |

`Agent Flow is running`, the stream indicator's label, became `Live`. It was the fourth use
of the word on a screen where the other three were about the run.

---

## Acceptance

| | evidence |
|---|---|
| the board is the dominant surface and opens by default | `run-detail.png` at four widths; `RunDetailPage.test.tsx` asserts the tab and the six absences |
| the main screen shows no subsystem permanently | six `queryBy…` assertions, and the composition baseline |
| every panel is one click away | `run-overview.png`, `run-tasks.png`, `delivery.png`, `team-panel.png`, `review-panel.png` |
| a tab with nothing behind it is absent | `availableSurfaces` unit tests; `delivery.spec.ts` asserts the tab is absent without a forge |
| attention is clear but not overwhelming | `AttentionStrip` renders nothing on a healthy run — asserted with `toBeEmptyDOMElement` |
| the deep links work | `M8-ACC-19` calls `surfaceFromParams` over every surface; two page tests navigate by `?panel=` and `?task=` |
| existing workflow semantics intact | 4279 node tests, including the M8 acceptance suite and the stage-timeline `cached` coverage |
| mobile and tablet usable | 390px board is 1654px of document with zero page overflow, five readable filter chips and every lane name |
| visual gates green | 227 baselines at four widths, on both platform sets |

## What is not covered

- **A run that is genuinely at every tab at once.** The reference fixture has no forge, so
  `delivery.spec.ts` supplies its own; the seven-tab composition is exercised in unit tests
  and by `availableSurfaces`, not photographed as one shot.
- **The Overview surface's vertical emptiness.** Four cards and a pipeline leave roughly
  370px of ground at 1440×900. That is a short page in a full-height container rather than
  a defect, and filling it would mean inventing content.
- **Keyboard traversal end to end.** The tab strip's roving tabindex and the drawer's focus
  trap are each tested; a single walk from the sidebar through the strip into a card and
  out again is not.
