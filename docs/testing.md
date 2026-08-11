# How this is tested

Three layers, answering three different questions. None of them is a cheaper version of
another, and the most important thing to understand about the arrangement is where each
one stops.

```
Vitest        unit, integration, architecture     1063 tests, no browser, no process
Playwright    deterministic browser E2E           16 scenarios, real server
              visual regression                   133 screenshots, 4 widths, 2 platforms
gsd-browser   black-box packaged acceptance       2 journeys, against the tarball
```

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

Some rules are executable rather than written down, in `test/architecture.test.ts`:
`src/core/` imports no Node built-ins and names no provider; topological ordering exists
in exactly one module; no HTTP handler writes state or decides an approval; no request
contract accepts a filesystem path; there is one project registry and one execution
lock; and no E2E spec intercepts `/api/**`.

## Playwright — the browser gate

Two suites, two configurations, because they need opposite things.

### `playwright.e2e.config.ts` — deterministic E2E

Sixteen scenarios that stub **nothing**. Each test gets its own temp repository, runs
the real `agent-flow feature` to produce a run, boots the real `agent-flow ui`, and then
drives a browser against it. Browser → Fastify → application services → StateStore →
filesystem, all production code.

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
