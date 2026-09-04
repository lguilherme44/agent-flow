# How this is tested

Three layers, answering three different questions. None of them is a cheaper version of
another, and the most important thing to understand about the arrangement is where each
one stops.

```
Vitest        unit, integration, architecture     1768 tests, no browser, no coding CLI
Playwright    deterministic browser E2E           26 scenarios, real server, real Git
              visual regression                   22 views, 4 widths, 2 platforms
gsd-browser   black-box packaged acceptance       2 journeys, against the tarball
dogfood       real coding CLIs, two stacks        manual, never in CI
```

Counts move as tests are added, and they are here to convey scale rather than to be
matched. What is worth relying on is which question each layer answers, and where it
stops.

```bash
npm run verify                 # everything this repository requires locally, cheapest first
npm run verify:release         # the same, plus what must be green before publishing

npm run gate:node              # typecheck ×3, lint, Vitest, dashboard unit, both builds
npm run gate:browser           # Playwright, against the real local server
npm run gate:visual            # Playwright, screenshots (this platform's baselines)
npm run gate:packaging         # pack, install elsewhere, drive the installed product
npm run gate:security          # dependency advisories, and what only GitHub can answer
```

Each lane is declared once in [`scripts/gates.mjs`](../scripts/gates.mjs); CI invokes the
same lanes; `test/gates.test.ts` fails if any of them drift. **The Gate contract** below is
about why that file exists.

---

## Vitest — everything that does not need a browser

`npm run test` (the CLI, the core, the application services, the server) and
`npm run test:web` (the dashboard's components, in jsdom).

**No CLI is ever invoked.** Runners are exercised through a scripted `AgentRunner`;
adapters are tested by asserting the exact argv they build and by parsing output
recorded from the real tools. That is what makes the suite free, fast and runnable in
CI — and it is also its limit: it proves nothing about the CLIs themselves.

**Git, on the other hand, is never faked.** Everything MVP 2 touches has an
`*.integration.test.ts` that runs against a real repository in a temporary directory,
under a temporary home so a failing test costs a rerun rather than one of the
developer's own worktrees: hook isolation, worktree creation and locking, `write-tree`,
`commit-tree` determinism, marker/tree binding, merges, ancestry and conflict aborts.
The reason is empirical — probing real Git during M2-02 changed three design decisions
that had looked settled on paper, and platform differences in `worktree` behaviour are
exactly the class of thing a mock cannot surface. Faked Git would have made those tests
green and wrong.

Some rules are executable rather than written down, in `test/architecture.test.ts`:
`src/core/` imports no Node built-ins and names no provider; topological ordering exists
in exactly one module; no HTTP handler writes state or decides an approval; no request
contract accepts a filesystem path; there is one project registry and one execution
lock; and no E2E spec intercepts `/api/**`.

## Playwright — the browser gate

Two suites, two configurations, because they need opposite things.

### `playwright.e2e.config.ts` — deterministic E2E

Scenarios that stub **nothing**. Each test gets its own temp repository, runs the real
`agent-flow feature` to produce a run, boots the real `agent-flow ui`, and then drives a
browser against it. Browser → Fastify → application services → StateStore → filesystem,
all production code.

The only thing replaced is the coding CLI, through the one seam designed for it —
`runners.<id>.command` in the global configuration — by a script that speaks both
adapter dialects and answers from the `ROLE: X_AGENT` line every shipped prompt opens
with. Both real adapters parse it, so a cross-provider plan review is genuinely
cross-provider. No quota is spent and no network is touched.

Run directories are never seeded. The plan, its hash, the review citing that hash and
the event trail are produced by the code under test, so no fixture can quietly stop
matching the contract.

An architecture test forbids `page.route`. An E2E that intercepts the API proves the
React app can render a fixture — which the unit suite already proves in a hundredth of
the time — and deletes the only thing an E2E can prove.

**Concurrency here is held still, never timed.** The scenarios that prove two or three
agents ran at once do it with a latch, not a stopwatch: the fake writes a marker file
when it enters a task and blocks on the absence of a release file the test writes. So
"three agents were inside three worktrees simultaneously" is a state the test brought
about and then looked at, with no sleep deciding anything on either side. A timing race
would pass on a fast machine and fail on a loaded one, which is the same as not testing
it.

The same rule covers the crash scenario. The coordinator is spawned as a process the
test still holds and killed with `SIGKILL` at a point the test arranged — one task
parked, the previous wave already integrated — so no handler runs and nothing is
flushed. That is a real crash rather than a simulated one, and the state it leaves is
the state §17 is about.

`closure.spec.ts` is the composition, added by M2-12: a two-wave graph with a fan-in
(three tasks ready at once, one that must wait), the crash above, a retry that fails
validation and then succeeds on a fresh worktree, and a cleanup that removes what the
run owns while a foreign branch and a foreign worktree survive it. The dependent task
*reads* its dependencies' files before writing its own, so a broken wave barrier fails
inside the attempt rather than being caught by an assertion about commit shape.

### `playwright.config.ts` — visual regression

133 screenshots at 1440, 1280, 1200 and 1024. The last two are the sides of the
boundary where the inspector stops sharing the row with the table and becomes a drawer,
and the two sides of a boundary are the only places a boundary can be wrong.

Determinism comes from a stubbed API, a pinned clock, and a fixed locale and timezone.
Fixtures are allowed here and only here: the question is whether the layout is right,
and a layout does not have opinions about where its data came from.

Two things this suite gets right that are easy to get wrong:

- **`reuseExistingServer: false`, always.** The build is inside the server command, so a
  `vite preview` left running from an earlier session cannot be adopted — which used to
  mean the screenshots compared a bundle nobody had built since the last change. An
  occupied port is now a named refusal, not a silent adoption.
- **Baselines are per-platform, and both are committed.** Font rasterisation differs, so
  `desktop-1440-darwin` and `desktop-1440-linux` never meet. The Linux set is generated
  in the pinned Playwright container by `scripts/visual-linux.sh` and compared in that
  same container by CI, which is what makes them reproducible from a Mac.
  `test/visual-ci.test.ts` fails if the two ever name different image versions.

## gsd-browser — the packaged product, as a stranger meets it

The question Playwright cannot answer:

> Can a browser that knows nothing about React or Fastify use Agent Flow *as it was
> installed*?

`scripts/gsd-smoke.mjs` packs a tarball, installs it into a throwaway prefix outside the
repository, renames the checkout's own dashboard bundle away, and then drives the result
with a tool that has no knowledge of this codebase — navigate, snapshot, click a ref,
assert on visible text, console and network.

- **GSD-01** — dashboard → run → DAG → task → inspector. No console errors, no failed
  requests, two nodes in the graph, the selected task in the inspector.
- **GSD-02** — waiting for approval → approve → start → both tasks completed, confirmed
  in the browser and then on disk.

**It does not replace Playwright and must not grow into it.** Playwright knows this
application: it selects by the roles the components render, waits on the queries they
issue, and asserts against the contracts the server declares. That knowledge is what
makes it the deterministic gate, and it is exactly what disqualifies it from answering
the packaging question. Two hundred precise assertions belong there; two journeys
belong here.

Visual comparison stays with Playwright. `gsd-browser visual-diff` exists and is not
used — a second baseline mechanism would be two things to keep in step for no gain.

### Version pinning, and why it is local

gsd-browser is pinned at **0.2.2**. The smoke refuses to run against any other version
and prints the exact install command rather than reaching for `latest`; a black-box
check that changes underneath you is worse than none.

It runs **locally, as a mandatory step before publishing** — not in CI. It is a native
binary distributed per platform with no published checksum, and CI already has a
deterministic browser gate that needs no such dependency. Pinning it in a workflow would
add a supply-chain surface to buy a second opinion CI does not need. The brief permits
this trade explicitly; this paragraph is the record of taking it.

Each run uses its own named session (`agent-flow-packaging-<pid>`) and closes the page
and the daemon afterwards. A test that inherits a browser is a test whose starting state
came from somewhere it cannot see.

---

## The gate contract — one definition of green

Every job below runs `npm run gate:<lane>` and nothing else. The lanes, the commands
inside them, and what each command's result is *worth* are declared once, in
[`scripts/gates.mjs`](../scripts/gates.mjs).

| Lane | Jobs | |
|---|---|---|
| `node` | `check` (Node 20, 22) | typecheck ×3, lint, Vitest, dashboard unit, both builds |
| `browser` | `e2e` | Playwright E2E in the pinned Playwright container |
| `visual` | `visual` | Screenshot regression against the Linux baselines, same container |
| `packaging` | `packaging` | Pack, install elsewhere, drive the installed product |
| `security` | `dependencies`, `secrets`, `codeql` | Advisories, secrets over history, static analysis |
| `coverage` | `coverage` | A report, not a gate |

`visual` is one job rather than a Node matrix: a page does not render differently under
Node 20 than under 22, and duplicating it would double the slowest job in the file to
learn nothing. Both browser jobs upload the Playwright report — expected, actual and
diff for every mismatch — when they fail.

### What a result is worth

Four classes, because "green" was one word covering four different situations:

| | |
|---|---|
| `required-local` | A person can run it, and must see it green before calling work done. CI runs it too. |
| `required-ci` | Blocking, and only GitHub can produce the evidence — `codeql`, and `secrets` over full history. |
| `required-release` | Blocking before publishing, not before committing — the gsd-browser smoke. |
| `report-only` | Runs every time, never blocks, stays visible — coverage, and the toolchain audit. |

Scheduling is modelled separately, as `recurrence`, because it is independent of
blocking: the secret scan runs weekly **and** blocks on every push, and one field cannot
say both.

**Every lane ends by naming what it did not run.** `npm run gate:security` exits 0 and
prints `not observed  secrets, codeql`, `not run  node, browser, visual, packaging`. That
line is the whole point of the redesign: a green lane is no longer readable as a finished
contract.

### Why this exists

The gap M7 closed with was not a broken check. It was **two hand-kept lists**:

```text
what a milestone runs      npm run check   →  typecheck ×3, lint, Vitest, dashboard unit
what CI blocks on          ci.yml          →  typecheck, lint, Vitest, build ×2, dashboard unit
```

Neither is a subset of the other. `test:packaging` was in the second and not the first, so
it was red for a whole milestone with CI reporting it on every push and no local command
ever asking. `typecheck:web` and `typecheck:e2e` were in the first and not the second, so
a type error in browser code could reach `master`. The same defect, in both directions, in
one repository.

The fix is not a sixth list. It is that there is now one, and that
[`test/gates.test.ts`](../test/gates.test.ts) refuses any of the derived copies drifting
from it — with the rules proved by mutation rather than assumed:

| Positive control | Rule that fires |
|---|---|
| `test:packaging` downgraded to `report-only`, or removed | R6 |
| a `run:` step in CI naming a command the manifest does not | R1 |
| a required gate moved into a lane no CI job runs | R2, R3 |
| a lane's `package.json` script deleted | R7 |

**The M6 validation registry is a different thing and must stay one.** That one asks "did
the feature this run implemented pass its quality gates" — somebody else's code, evaluated
inside a run. This one asks "may Agent Flow itself ship". Nothing in `src/` imports
`scripts/gates.mjs`, and it is not a schema module: nothing here is ever written to disk.

---

## Collaboration — the layers M4 needed that no other feature did

Two claims in M4 cannot be made by a unit test, and each has its own suite.

**"The outbox never enters a validated tree"** is a claim about what `git add -A` and
`git write-tree` do to a file that is present at that moment, so it runs against real Git
in a temporary repository: an attempt that speaks captures a tree byte-identical to one
that stays silent, `filesChanged` never names the outbox, and it never reaches the
operator's own `git status`. A fake would only ever confirm what the fake was told.

**"The harvest happens between the agent exiting and the tree being captured"** is a claim
about *line order* inside one method, which no type can enforce. An architecture rule
asserts it directly, alongside the rules that forbid any collaboration module from
importing a shell, a Git module or anything that can move a run.

Three more layers exist because the failure they catch is specific:

| Layer | What it caught |
|---|---|
| concurrency | eight tasks in one wave, harvested in both orders, producing an identical projection — the property MVP 2 spent a milestone on for integration, restated for speech |
| acceptance (`test/e2e/collaboration-acceptance.test.ts`) | that with `collaboration.enabled: false` the prompt a runner receives is **byte-identical** to the pre-M4 one, proved by comparing two runs rather than by reading the code |
| visual | three defects every green component test had missed — a panel clipping its own content, a contested notice repeating what the list below it already said, and an empty state rendered over a list of handoffs |

That last row is the one worth repeating. The component tests asserted that elements
existed, and they did; the screenshot showed the second thread and the whole blackboard
section cut off below the fold of a 288-pixel box. **"The element exists" is not "the
layout is right"**, and only a picture tells the difference.

## Review — the layers M6 needed, and the one that found everything

M6's suites are shaped by a single discovery: **a mechanism can be written, reviewed,
covered by tests, and unreachable by any real agent.** Three of the milestone's defects
were that exact shape — a function nothing called, an event nothing emitted, and a key the
emitter and the reader disagreed about — and every one of them passed a suite of 3900
tests.

So the instrument is a rule rather than a habit. Two architecture rules ask §70's question
mechanically:

| Rule | What it forbids |
|---|---|
| reachability | an export under `src/core/review/` with no *transitive* caller in shipped code. `test/` is excluded from the reachable set on purpose — a caller that exists only in a test is the situation being rejected |
| emitters | a type in `REVIEW_EVENT_TYPES` that nothing outside `src/contracts/` writes |

Writing the browser rules found a third instance of the same shape in the test suite
itself: `sourceFiles` walked `.ts` only, so every rule scanning `apps/web/src` was reading
**0 of its 47 components**. A rule forbidding the browser from deciding anything passed
while the browser was free to decide everything. The proof was a mutation — a
`decideQuality` planted in `review.tsx` did not fail the suite — and the fix was one
`endsWith`.

The other layers exist for failures a unit test cannot reach:

| Layer | What it proves |
|---|---|
| crash (`test/e2e/review-crash.test.ts`) | the five kill points of the charter. Resume duplicates no review, loses no finding, generates corrective work exactly once, approves no stale tree, re-runs no recorded gate |
| adversarial | a malformed review is not an approval; a traversal path is *removed* from a finding rather than flagged; an oversized proposal is truncated before it is parsed |
| acceptance (`test/e2e/review-acceptance.test.ts`) | the 28 criteria, each tagged so a scan can produce the table rather than a person reading it |
| visual | four states that only a picture distinguishes — `failed` against `not run`, `stale` against `current`, an approved thread against a blocked one, and a gate list that fits on one line at 1024 |

**The fixture question is the one that keeps being answered wrongly.** Every test of
`projectFindings` handed it an event literal, and in production an *emitter* writes that
event — so the literal did not represent the state the test claimed to be about, and the
key mismatch survived. There is now one test that runs the real corrective round, appends
a real `task_finished`, and asserts the real projection reports `fixed`. It is worth more
than the six that surround it.

## Forge — where "the API answered" stops being enough

M7's suites exist for four distinctions the network makes and a local test cannot:

```text
"the API answered"      ≠  "the right remote object was created"
"the branch published"  ≠  "it holds the approved SHA"
"the PR exists"         ≠  "it represents this run"
"CI is green"           ≠  "the local workflow approved"
```

| Layer | What it proves |
|---|---|
| adapter contract | every status class, malformed JSON, an oversized body, missing fields, an unexpected enum, bounded pagination — with an injected `fetch` and no network |
| idempotency | the five kill points of §53, each simulated by letting the remote succeed and then discarding the local record |
| architecture | M7-A01 … M7-A15, including the transitive one: proving a file imports no Git module does not prove it cannot *cause* Git to run |
| live | a real Issue, a real branch, a real pull request, real checks, and a rerun that creates nothing twice |

**The live run is where two defects came from, and neither was reachable locally.** The
delivery panel logged an error on every dashboard render because its endpoint was unstubbed
in the visual harness — absence on the page is not absence on the wire — and the packaging
smoke had been asserting eleven prompts since M6 added a twelfth.

That second one is the more uncomfortable finding, and it is what M8's first phase went
back and closed. `test:packaging` was **not** in the canonical gate list every milestone
ran, so a check CI runs and blocks on was one the local Definition of Done never asked
about, and it was red for a whole milestone. Deriving the prompt count from the checkout
fixed the instance; **the gap itself is fixed by the gate contract above**, and a mutation
test now proves the rule fires rather than assuming it.

## Control plane — where a fixture stops being evidence

M8's suites are shaped by one thing the earlier milestones kept proving: **a projection can
be correct on every fixture and wrong the first time it meets a real run.**

| Layer | What only it can prove |
|---|---|
| unit | every task state maps to exactly one lane; the ladder is total and deterministic |
| architecture | the browser reaches none of those decisions — M8-A01 … A18 |
| server | the snapshot *composes* the readers: its task views are byte-identical to `/tasks` |
| component | the reason survives to the screen; status is never colour alone; a payload renders as text |
| visual | the board at four widths, with the lanes that fit and the ones that do not |
| **real data** | everything above, against runs this repository actually produced |

That last row is not a formality, and it earned its place within an hour:

- **A run with three failed GitHub checks produced an empty attention queue.** Every
  fixture in the suite had a green or absent delivery, so nothing had ever asked. There is
  a `remote_checks_red` kind now, at P2, whose sentence says which kind of failure it is
  rather than leaving the reader to know.
- **One task produced two P1 rows** — "exhausted automatic recovery" and "waiting for a
  review decision" — telling one person to do one thing in two ways.
- **The board blamed the agent for a block the graph derived.** `blocked` is two things: a
  record the executor writes when a runner answers BLOCKED, and a condition
  `blockedByFailure` derives for everything downstream of a failure. Only the first carries
  a `blockReason`, so reading its absence as "the agent asked for help" put that sentence on
  the card of every task the agent never touched. Found twice — once in the queue, once on
  the board — because the second copy was written before the first was fixed.
- **The board was entirely below the fold.** An escalation banner and a degradation list
  the queue already summarised left 75 pixels of board at 1440×900. The detail moved below
  the work; nothing was deleted.

None of those is visible in a screenshot of a nine-task fixture, and all four were visible
in the first thirty seconds of pointing the dashboard at `.agent-flow/runs/`.

### 390px, and what a picture cannot assert

The mobile scenario is pinned to one Playwright project and sets its own viewport, so there
is exactly one baseline per platform rather than four identical copies. Every shot carries
assertions the picture cannot make: the six lane names as text, all five counts, a card's
reason sentence, and — the one that found a real defect — the page overflow as a number.

`document.documentElement.scrollWidth` must not exceed the viewport, and *only* the
document. The pipeline and the board scroll inside their own regions by design, so a check
that forbade every scrollable element would forbid the design rather than the defect. It
measured 577 against 390 the first time it ran: the drawer's own off-canvas
`translateX(-100%)`, counted by Chromium, produced by no content.

Lane stacking is read from bounding boxes rather than from a class name. A media query that
stops applying is invisible to a class assertion; the positive control makes the point —
removing `max-lg:flex-col` turns one shared left edge into six.

### The gate contract's own tests

`test/gates.test.ts` is a contract test whose rules are proved by **mutation** rather than
assumed — see [the gate contract](#the-gate-contract--one-definition-of-green) above. The
same discipline caught two of M8's architecture rules reading nothing: they used `codeOnly`,
which blanks string literals, so a rule looking for `case 'review_required'` was reading
`case ''`. Planting the construct is what found it.

## M8.5 — where a green gate stops meaning anything

The simplification pass found three defects, and the interesting thing about all three is
that no gate in this repository could have caught any of them. They are worth naming as a
class, because the class recurs.

**A URL parameter nobody reads.** `routeFor` emitted `?panel=review` for two milestones
and the run page read only `?view=`. Three tests covered it and all three were green:
`attention.test.tsx` asserted the *string* the function returned; `M8-ACC-19` asserted two
regular expressions against `RunDetailPage.tsx`'s source, and its own comment claimed
`?task=` round-tripped while nothing checked it. The fix is not a better regex. The URL
contract moved to `apps/web/src/lib/run-surface.ts` — plain `.ts`, no JSX — so the node
suite can `await import` it and *call* `surfaceFromParams` over every surface. **An
acceptance test that greps its subject goes green on a rename and red on a reformat.**

**A CSS class nobody defines.** `DeliveryPanel` was written against ten of them and
rendered as raw HTML. The element exists; it simply has no style, so the compiler, the
linter and every `getByRole` are all satisfied. The only thing that reports it is a
picture — and a picture needs a fixture that renders the component. The only delivery
fixture was `DELIVERY_NONE`, whose state is `disabled`, so the guard clause returned `null`
in every unit test and in all 296 baselines. **A component no fixture renders is a
component with no guaranteed appearance**, and the first photograph of this one found a
second defect within seconds: an unformatted ISO date.

**A stylesheet nobody compares.** `ops-control.css` carried a second `:root` and a Google
Fonts import while `tailwind.config.js` stated in its own comment that no font was loaded.
Both files were internally consistent. The disagreement lived between them, and the only
instrument that saw it was `getComputedStyle` in a real browser:

```js
// visual/harness or an ad-hoc probe — the shape that found it
getComputedStyle(document.querySelector('.sidebar')).fontFamily
// → "Inter, system-ui, …"   while tailwind.config.js said nothing loads Inter
```

**And an appearance-only change is invisible to a DOM suite.** Making empty board lanes
stop drawing a border and a fill was mutation-tested against `board.test.tsx` *before* the
rule for it existed: thirteen assertions stayed green with the boxes restored. The
assertion that bites is structural — an empty lane renders no `<ul>` — plus the baseline.
When you change how something looks and every test still passes, that is information about
the tests.

The pattern in all four: **ask what instrument would report this, and prove the instrument
works before trusting its silence.** Every rule added in M8.5 was mutation-tested; the
sequence is in the milestone's own report.

That is one half of the class. The other half is worse, because the instrument is fine.

### The same class from the other side: the instrument looked, and the code flattened

The four above share a blind instrument. There is a second shape where the instrument is
fine and the *code* removes the distinction before anything can observe it — and it
recurred three times in one evening, in `core`, all on the pipeline view.

A stage served from cache read `pending`. A stage generating at that instant read
`pending`. A stage with one task completed and ten queued read `pending`. Three different
facts, one symbol, and the symbol asserts the strongest possible claim: *nothing happened
here*.

Each had its own cause, and the causes are worth separating because the fixes are not
interchangeable:

- **Reported, never recorded.** Both cache paths called `onProgress`, which reaches the
  terminal of whoever typed the command and nowhere else. A dashboard opened afterwards
  had no event to read. The fix is a `stage_reused` event, not a better renderer.
- **Derived from a field that lags.** `running` asked `state.stage`, which is set to
  `discovery` before discovery runs and again when it finishes — and the function's own
  header said so, in prose, above the line that used it anyway. Observed mid-flight: the
  field read `architecture-impact` while the log was already inside `sdd`.
- **Fell off the end of a ternary.** Implementation with partial progress matched no
  branch and landed on the final `: 'pending'`.

**The default branch is where unmodelled states go to die, and `pending` is the most
dangerous default there is**, because it does not admit ignorance — it asserts absence. A
reader acts on it: they conclude the run has not started, or has stalled, and go looking
for a problem that is not there.

Why no test caught any of the three: every one of them had coverage, and the coverage
exercised the branches somebody thought about. Nobody writes a case for `default:` — that
is what `default:` is for. The assertion that would have bitten is not about a branch at
all but about the mapping: **each distinct fact must produce a distinct output**, checked
across the whole input space rather than at the points that were already understood.

Each of the three was checked by reverting it and watching the new test go red, and each
was read back off the live API rather than off a fixture — which for these is the check that
matters, because the whole failure is a projection collapsing three inputs into one output
and a fixture is a hand-written input.

**Computed style is the other section's main instrument, and it earns exactly one hop of
this chain.** This paragraph has been wrong twice, in opposite directions, and both drafts
are worth keeping on the record because the second is the subtler mistake.

The first claimed all three fixes were verified by reading colour off the page. False: two
were read off the API. The correction then said computed style "would say nothing here,
because the colour was always faithfully rendering whatever the projection handed it" —
which threw away a true half with the false one. `stageTone()` maps a status to a tone, and
**the API cannot see that mapping**: `cached` can arrive in the response and still be drawn
as an unrecognised status, one layer further out, in the exact shape this section is about.

So it was measured, on a pipeline carrying one of each status plus one the switch has no
opinion about:

| `status` | chip background | marker |
|---|---|---|
| `completed` | `rgba(52,211,153,0.12)` success | `rgb(52,211,153)` filled |
| `cached` | `rgba(59,130,246,0.12)` info | `rgb(59,130,246)` filled |
| `running` | `rgba(124,58,237,0.16)` primary | `rgb(124,58,237)` filled |
| `pending` | `rgba(0,0,0,0)` — nothing | hollow |
| unrecognised | `rgb(21,29,43)` surface-3 | hollow |

**And the numbers correct the reasoning that predicted them.** The draft that argued for
measuring said an unrecognised `cached` would draw "the same grey as `pending`". It does
not: it draws `surface-3`, a visible box, where `pending` draws nothing. The background
channel separates them fine.

**The collapse is on the marker, and that is the sharper claim.** An unrecognised status and
`pending` both draw a hollow ring — and hollow-versus-filled is precisely how this pipeline
says "not yet" against "settled". Which means there are *two independent browser-side
guards*, not one, and each covers a different channel: `case 'cached'` in `stageTone` keeps
the fill's hue, and `solid={… || stage.status === 'cached'}` in `StageStep` keeps it filled
at all. Delete either and `cached` slides one channel back toward "nothing happened here" —
the same flattening as the three `core` defects above, reached from the browser instead.

The rule that generalises: **each hop in the chain needs its own instrument, and the API is
not the last hop when the output is a picture.** With the corollary this paragraph earned
the hard way: **cutting an over-claim is not the same as cutting the claim**, and a
correction is an assertion too — it wants the same measurement it is demanding.

### And the picture is not the instrument for a tone

Following that rule to its end found a fourth case, and it is the sharpest of the night
because the blind instrument is the one this repository trusts most for exactly this
question. `playwright.config.ts` opens by saying that DOM assertions all passed while a
card title wrapped and a badge upper-cased itself, and that "only a picture tells the
difference". **For a status tone on a pipeline chip, the picture cannot.**

Changing the reference fixture's SDD stage from `completed` to `cached` turns that chip blue
with a full-strength blue ring — obvious to anybody looking at it. The visual suite passed,
227 of 227, against a baseline still showing it green. Measured by moving one knob at a time:

| configuration | pixels counted as different |
|---|---|
| `threshold: 0` — count every differing pixel | **6182** (ratio 0.0048) → would fail |
| `threshold: 0.2`, the default this repo uses | **134** — the ring, and nothing else |
| those 134 against `maxDiffPixelRatio: 0.002` (2592 px) | passes |

**Two independent margins, either one sufficient on its own.** The per-pixel threshold
discards 98% of the difference: a `TONE_BG` fill is 12% alpha, so success-soft and info-soft
composite to `(16,40,43)` and `(17,31,54)` over the panel ground — around nine units of 255
apart, well inside a 0.2 YIQ distance. What survives is the marker's ring, full-strength and
about 134 pixels, which the ratio allowance then absorbs.

**Neither number is wrong and the config should not change.** The comment above
`maxDiffPixelRatio` is right that zero tolerance turns antialiasing into a red suite nobody
trusts, and it was written by somebody who had measured that. The mistake would be believing
the gate covers something it does not.

So tone is covered where coverage works, and the split is worth stating because it is not
obvious:

- **the mapping** — `lib/status.test.ts`, a pure function, exhaustive over the contract enum,
  mutation-proved (deleting `case 'cached'` turns three assertions red). No brittleness and
  no tolerance.
- **the word** — `toContainText('cached')` on the pipeline list. §97 has required status to
  be icon *plus text* since the first panel, and this is why that requirement pays twice: the
  channel that makes a greyscale screenshot and a colour-blind reader work is also the only
  channel a screenshot diff can hold.
- **the picture** — layout, clipping, wrapping, overflow, alignment. What it was always for.

The general form, and it applies past this repository: **a gate with a tolerance has a
blind spot the exact size of that tolerance, and it is worth knowing its dimensions rather
than its name.** Ours is 0.2 YIQ per pixel and 0.2% of the frame. Anything a design
deliberately makes subtle — a 12% wash, a hairline, a one-step surface change — lives inside
it.

---

## Dogfood — the real CLIs, never in CI

The layers above are free, fast and deterministic because no coding CLI is ever
invoked. That is also the exact shape of what they cannot see, so MVP 2 is not closed
by them alone: §27 of the specification requires the whole matrix to run against live
CLIs on two stacks — a Node repository and a Flutter one — with real quota spent and
real models deciding what the code should be.

It is manual, it is never in CI, and what it finds goes to
[`engineering/findings.md`](engineering/findings.md).

**It is worth the cost because it finds a different class of defect.** The M2-12 pass
found a repository gate that reported itself as a model failure — a dirty working tree
reaching the user as "the runner produced output that never satisfied the contract" —
on the very first real run. No unit test could have: the fake never makes the working
tree dirty, because a fake has no opinions and leaves no droppings.

### What is measured, and the honest answer about speed

Per worktree, on the M2-12 pass, against small repositories on an Apple Silicon laptop:

| | Node | Flutter |
|---|---|---|
| `git worktree add` | 47 ms | 35 ms |
| dependency install | `npm install` 0.2 s | `flutter pub get` 0.5 s |
| one validation run | `node --test` ~0.2 s | `flutter test` 4.5 s |
| worktree on disk | 28 KB | **43 MB** |

Two of those numbers matter more than the rest.

**Disk is the real cost of Flutter isolation, not time.** `flutter pub get` is fast
because `~/.pub-cache` is global and shared across worktrees — nothing is re-downloaded
— but `.dart_tool/` is per checkout and is most of the 43 MB. At four concurrent tasks
that is ~170 MB for a package with no dependencies of its own; a real application scales
from there. This is what `agent-flow doctor` projects before you turn isolation on, and
what `MAX_ISOLATED_TASK_CONCURRENCY` bounds.

**Validation cost is what decides whether parallelism pays.** A stack whose validation
run is 4.5 s pays that per task per attempt, and the overlap has to be worth more than
the sum of the fixed costs to come out ahead. On these repositories nothing is worth
measuring a speedup on — the agent's own latency dominates everything else by an order
of magnitude — so no wall-clock ratio is claimed here. **The number that would look best
in a README is the one that is not reported.**

**Parallelism also cannot be measured on a plan that has none.** The Flutter planner
returned a strictly chained RED → GREEN graph — seven tasks, seven waves, one task each
— so effective concurrency was 3 and observed concurrency was 1 throughout. That is a
property of the plan rather than of the executor, and it is the ordinary case for
test-first work: a plan whose tasks genuinely depend on each other has nothing to
overlap. Isolation still applied, and still earned its place.

**So: parallelism does not pay off everywhere, and where it does not, that is the
recorded result rather than a benchmark chosen to look better.** Isolation is worth
having on its own terms — it keeps two agents out of one tree, it makes a failed attempt
something you can still read, and it is what lets a crashed run resume from evidence.

---

## What none of this covers

- **The real CLIs.** Every runner is faked, at the process boundary or above it. What
  the tools actually do is recorded in
  [`runner-capabilities.md`](runner-capabilities.md), with the command that proves each
  claim and the version it was probed against, and end-to-end runs against live Claude
  Code and Codex are logged in [`engineering/findings.md`](engineering/findings.md).
- **Windows.** Path containment is now decided with `node:path` and its Windows rules
  are asserted on Linux with `path.win32`, but no CI job runs on Windows and the process
  timeout still cannot signal a process tree there.
- **Cost.** Nothing here measures what a run spends.
