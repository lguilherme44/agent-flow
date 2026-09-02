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
npm run check                  # typecheck + e2e typecheck + lint + Vitest + dashboard unit
npm run test:e2e               # Playwright, against the real local server
npm run test:visual            # Playwright, screenshots (this platform's baselines)
npm run test:packaging         # pack, install elsewhere, drive the installed product
npm run test:packaging:browser # the same, through gsd-browser
```

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

## What CI runs

| Job | |
|---|---|
| `check` (Node 20, 22) | typecheck, lint, Vitest, build, dashboard unit tests, dashboard build |
| `e2e` | Playwright E2E in the pinned Playwright container |
| `visual` | Screenshot regression against the Linux baselines, in that same container |
| `coverage` | A report, not a gate |

`visual` is one job rather than a Node matrix: a page does not render differently under
Node 20 than under 22, and duplicating it would double the slowest job in the file to
learn nothing. Both browser jobs upload the Playwright report — expected, actual and
diff for every mismatch — when they fail.

Packaging and gsd-browser are local. See above for why.

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
