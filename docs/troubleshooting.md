# Troubleshooting

Each entry names what you would see, what it means, and what to do. If a message here
does not match the one you got, the message is the bug — say so.

---

## Running the workflow

### `runner_unavailable`, or `doctor` says a role has nowhere to run

The CLI a role points at is not installed, not on `PATH`, or present and not runnable —
which is a real state and the one a single boolean would hide. `doctor` reports all
three separately.

```bash
agent-flow doctor          # installed? executable? auth configured?
agent-flow doctor --deep   # actually invoke each runner (spends quota)
```

Then either install the CLI, or point the role at one you have:

```yaml
# ~/.agent-flow/config.yaml
roles:
  planner: { runner: claude, effort: high }
```

`enabled: true` is not redundant. The shipped defaults enable one runner, so a runner
block that omits the flag inherits `false` and every role pointing at it refuses to
resolve — with a message naming each broken role rather than the first.

**Fallback will not rescue this by default.** Fallback is restricted to infrastructure
failures (`quota_exceeded`, `auth_required`, `runner_unavailable`) and is only used if
you configured a replacement for that role. A model that produced *bad output* is never
retried elsewhere: that would replace a visible failure with a quiet one.

### `run_busy`

Two processes cannot execute one run, and one of them already has it. The message says
which — the CLI or the server — with the pid when the holder is on this machine.

Wait for it to finish. That is the whole remedy in the normal case, and the normal case
is you starting a run in the terminal while the dashboard is open.

### `run_busy`, and "the claim on it could not be read"

The rarer one. A claim exists and Agent Flow cannot tell you who holds it, so it refuses
rather than guessing — guessing is how a run gets executed twice.

1. Confirm no Agent Flow process is working on that run. `ps` for `agent-flow`, and
   check whether a dashboard is mid-execution.
2. Then remove the **highest-numbered** `execution.lock.*` file in the run directory:

```bash
ls .agent-flow/runs/AF-2026-001/execution.lock.*
rm .agent-flow/runs/AF-2026-001/execution.lock.7    # the highest one
```

There is no file called `execution.lock`. Claims are numbered generations and only the
highest is the holder.

If the claim was written by **another machine**, Agent Flow says so and will not judge
it. Stop the execution on that host, or — if that host is gone — remove the file here.

### The run was rejected and now will not start

Correct. A rejected plan is not executable, and approving it afterwards is refused too:
the run would record that its plan was both turned down and approved. Revise the plan
and approve the result, or approve over the rejection deliberately — which is recorded
on the run as a degradation.

### A task is `blocked`

It stopped because of something the design document does not answer. Retrying will not
supply that answer, or it will produce a guess. Fix the SDD or the plan. A forced retry
is available and says what it costs.

### A task is `review_required`

The validation commands disagreed with what the task expected. Read the commands' output
in the inspector's **Tests** tab. For a test-first task, `validationExpectation: fail`
means a *passing* suite is also reported — either the new test asserts nothing or the
behaviour already existed, and both are worth a person's attention.

### A refusal from worktree mode

Runs created with `git.useWorktrees: true` can refuse before executing anything —
`working_tree_dirty`, `planning_base_moved`, `git_version_unsupported`,
`agent_flow_state_not_ignored` and the rest. Every one of them is a check that **writes
nothing**: the run is unchanged, nothing was consumed, and the next attempt is free once
the repository is ready.

The one almost everybody meets first is a workspace that setup made dirty, because the
default `npm install` rewrites `package-lock.json`. Use a lockfile-respecting install
(`commands.install: npm ci`), and run `agent-flow doctor` — it probes exactly this
before a run rather than after, and names the file.

The full catalogue of refusal codes, each with its fix, is owed by **M2-12** and is not
written yet. Until then §6.3 of
[`specs/mvp2-safe-parallel-execution.md`](specs/mvp2-safe-parallel-execution.md) lists
every code and the condition that produces it, in the order they are checked.

---

## The dashboard

### `No Agent Flow project found under <dir>`

Nothing under that directory has a `.agent-flow/config.yaml`. Either run
`agent-flow init` in a repository, or point the server at a directory that contains one:

```bash
agent-flow ui ~/work
```

If the message also lists directories that were **skipped for resolving outside the
workspace**, those are symlinks into repositories elsewhere. That is a normal way to
work and the refusal is deliberate — point the server at a directory that actually
contains them.

If your repositories are deeper than two levels down, raise the depth:

```bash
agent-flow ui ~/work --depth 4      # or ui.workspaceDepth in the global config
```

### `This server has no project called <id>`

The `?project=` in the address is not an id this server issued — usually a link from a
different workspace, or a project that has since moved. Use **Show the whole workspace**,
or pick the project in the sidebar.

### `<run> is not in this project`

Run ids restart at 001 per project per year, so `AF-2026-001` exists in more than one
repository. Open the run from **Runs**, where every link carries its project.

### The dashboard is blank, and the terminal says the bundle is not built

In a development checkout:

```bash
npm run build:web
```

The command says this rather than serving a blank page. An installed package always
ships the bundle; if an installed one says this, the package is broken — see below.

### The footer says `Reconnecting — polling`

The event stream dropped and a ten-second fallback is covering the gap. Everything still
updates, just later. If it stays that way, the server has probably stopped — reload and
check the terminal.

### A number on screen looks stale

It is not cached in the browser. Nothing in the dashboard holds a copy of a run's state;
every value came from the server. If two numbers on one screen disagree, that is worth
reporting — they read from different endpoints over one `state.json`, and disagreement
means the server is inconsistent, not the page.

---

## Tests

### `http://127.0.0.1:4788 is already used`

The visual suite's port is occupied — almost always a `vite preview` from an earlier
run. **Do not** take the message's suggestion of `reuseExistingServer: true`. That is
exactly what this refusal exists to prevent: adopting a running server skips the build
inside the server command, and the screenshots then compare a bundle nobody has built
since the last change. A green suite that means nothing is worse than a red one.

```bash
lsof -ti :4788 | xargs kill
```

### Every screenshot fails at once

You are comparing against another platform's baselines, or the browser changed.

- Baselines are per platform: `desktop-1440-darwin` and `desktop-1440-linux`.
- On macOS the suite uses your installed Chrome; on Linux, the Chromium pinned to the
  Playwright version in the lockfile.
- Regenerate the Linux set only in the pinned container, never on a Mac:

```bash
npm run test:visual:linux     # docker; writes apps/web/visual/__screenshots__/*-linux
npm run test:visual:update    # this platform's baselines
```

`test/visual-ci.test.ts` fails if the container image in the script and the one in the
workflow ever name different versions, which is the mistake that produces a diff on
every glyph and reads like a design change.

### The E2E suite fails on every scenario

It builds the CLI and the dashboard itself before running, so a stale artifact is not the
cause. Look at the first failure's error rather than the count: if `agent-flow ui never
answered`, the message includes the server's own output, which usually names a
configuration problem in the temp fixture.

Each test creates its own temp repository and its own port. If ports are the problem,
something else is holding thousands of them — the suite asks the operating system for a
free one rather than computing it.

### `gsd-browser is not on PATH`, or a version mismatch

The packaging smoke pins it, and refuses to run against anything else:

```bash
npm i -g @opengsd/gsd-browser@0.2.2
```

Never `latest`. A black-box check that changes underneath you is worse than none.

### The gsd-browser smoke hangs, or sees a page from the last run

A daemon was left running. Each invocation uses its own named session and closes it
afterwards, so this means a previous run was killed mid-flight:

```bash
gsd-browser daemon stop --session agent-flow-packaging-<pid>
pkill -f gsd-browser-bin        # last resort
```

### `no interactive element named "…"`

The snapshot did not find it. The failure prints every interactive name it did see, which
is usually enough to tell a renamed control from a page that never loaded. If the names
look right but the text differs, the button's label changed and the smoke should follow
it — that is the smoke doing its job.

### The packaging smoke leaves `apps/web/dist` missing

It renames the checkout's dashboard bundle away for the duration, to prove the packaged
server is not reading it, and restores it in a `finally`. A run killed at the wrong
moment can leave `apps/web/dist.hidden-by-packaging-smoke` behind. It is a build
artifact:

```bash
rm -rf apps/web/dist.hidden-by-packaging-smoke
npm run build:web
```
