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

Runs created with `git.useWorktrees: true` refuse rather than degrade. **Every refusal
below writes nothing**: the run is unchanged, no attempt was spent, no agent was
invoked, and the next try is free once the repository is ready. None of them is
overridable with `--force`, and that is deliberate — forcing past any of them would mean
building on a tree nobody planned against, or merging over a broken evidence binding.

The one almost everybody meets first is a workspace that setup made dirty, because the
default `npm install` rewrites `package-lock.json`. Use a lockfile-respecting install
(`commands.install: npm ci`), or commit the lockfile, and run `agent-flow doctor` — it
probes exactly this before a run rather than after, and names the file.

**Nothing in this catalogue tells you to delete a branch, `reset --hard` or force-push.**
Every code here names a state you resolve by adding to the repository, never by throwing
work away. If a fix below looks like it discards something, it does not: an attempt
worktree is a duplicate of what the integration branch already holds, and an integration
branch that is merged nowhere is the run's product and is never removed automatically.

#### The repository is not usable for isolation at all

Checked at `createRun`, where refusing costs nothing, and again before executing.

| Code | What is true | What to do |
|---|---|---|
| `not_a_git_repository` | There is no repository here. | `git init`, or set `git.useWorktrees: false`. |
| `repository_is_bare` | A bare repository has no working tree to cut worktrees from. | Use a normal clone. |
| `repository_has_no_commits` | There is no commit to use as a base for a branch. | Make the first commit. |
| `repository_has_submodules` | Worktree mode does not populate submodules, so an attempt would build against an incomplete tree. | Turn worktree mode off for this project. |
| `git_version_unsupported` | Worktree mode needs `git worktree add --lock --reason`, which is Git 2.33.0 or newer. | Upgrade Git. `agent-flow doctor` prints your version against the floor. |
| `repository_root_unresolvable` | Git could not answer where the repository root is, so no path can be attributed to this repository. | Check for a broken symlink above the repository. |
| `worktree_path_too_long` | The composed worktree path exceeds what this platform accepts. Mostly Windows. | Use a shorter home directory path, or enable long paths. |
| `git_unavailable` | Git could not be executed at all. | Check that it is installed and on `PATH`. |

#### The repository moved out from under a run

These describe your checkout at a moment, and they are the ones you resolve and retry.

| Code | What is true | What to do |
|---|---|---|
| `working_tree_dirty` | An isolated run's plan is written against a commit, and your checkout holds changes that are not in one. The refusal names the files. | Commit or stash them. Nothing is lost either way. |
| `planning_base_moved` | `HEAD` is no longer the commit this run was planned against, so the plan describes a different repository. | Check that commit back out, or start a new run against where you are now. |
| `agent_flow_state_not_ignored` | `.agent-flow/runs/` is tracked, so run state would enter the validated tree and every attempt would look dirty. | Add `.agent-flow/runs/`, `.agent-flow/cache/` and `.agent-flow/current-run` to `.gitignore`. |
| `git_identity_missing` | The run carries no Git namespace — it was created before MVP 2, or created sequential. | Start a new run. A run's mode is fixed at creation and never changes. |

#### The run's own namespace is not what it left behind

Rare, and each one means something outside the run edited its refs.

| Code | What is true | What to do |
|---|---|---|
| `git_run_key_collision` | This run's namespace already holds refs it did not create. | Start a new run. Do not delete the existing refs to make room — they belong to something. |
| `namespace_missing` | The integration branch this run recorded work on no longer resolves. | It cannot be rebuilt from here: the run's product was its branch. Start a new run. If the branch was moved rather than deleted, `git reflog` still knows where it was. |
| `integration_head_diverged` | The integration branch is at a commit that is not the one the run recorded, so its own history is not what it left. | Start a new run. Recovering onto a rewritten branch would merge over work the run cannot account for. |

#### An attempt's evidence does not hold up

Raised by the Integrator, and by recovery. The distinctions matter because the fixes
differ — reporting all of these as one code would tell somebody their marker was forged
when the truth is that a file is missing.

| Code | What is true | What to do |
|---|---|---|
| `attempt_evidence_missing` | The attempt left no `attempt-<n>.json` that parses, so there is nothing a marker could bind to. Usually a crash before validation finished. | Retry the task. The attempt is requeued as a fresh one; the old worktree is kept. |
| `attempt_evidence_unsatisfied` | The artifact parses and records that validation did not pass. Only a satisfied attempt is integrated. | Read `attempt-<n>.json` for what failed, fix it, and retry. |
| `attempt_marker_missing` | The evidence is sound and the attempt branch does not resolve to a commit — the marker was never published, or its ref was deleted. | Retry the task. Do not recreate the ref by hand; a marker is a function of the artifact and is rebuilt from it. |
| `attempt_marker_mismatch` | The marker exists and does not bind to the evidence: the tree or the nonce disagrees. This is the forged-or-corrupted case. | **This is never repaired automatically, and you should not repair it either.** The task is set to `review_required`. Look at what wrote that ref before doing anything else. |
| `attempt_tree_missing` | The validated tree the receipt names is no longer in the repository — usually a `git gc` between a crash and the resume. | Nothing to do: recovery requeues the task as a new attempt and never fabricates a tree. |
| `integration_history_unrecognised` | The marker is already an ancestor of the integration branch, and no merge commit on that branch introduced it — so the branch was rebuilt. | Start a new run. The branch no longer records how its contents got there. |

#### Two tasks in one wave both fail validation, each blaming the other's test

A task is judged in **its own worktree, against its own base**, by running your
validation commands — and `commands.test` runs your whole suite. So a task inherits
every test that is red in the base it was cut from, including tests a *sibling* task
wrote on purpose.

That is fine until a plan is test-first and puts two RED tasks in one wave:

```text
wave 2   TASK-002  write failing weekly tests      expectation: fail   ← integrates
         TASK-004  write failing formatter tests   expectation: fail   ← integrates

wave 3   TASK-003  implement weekly      → formatter tests still red → unsatisfied
         TASK-005  implement formatter   → weekly tests still red    → unsatisfied
```

Each task did its own job. Neither can go green alone, because each inherits the other's
failure and can only fix its own. Retrying will not help: a retry is cut from the same
head, so it inherits the same red.

**The fix is in the plan, and it is small.** Either:

- put a module's tests and its implementation in **one** task — the usual answer, and
  what to ask for when you `revise`: *"each task must deliver both the implementation
  and its tests together"*; or
- keep them separate and make sure a wave never holds more than one unpaired RED per
  validation command, so the next wave's task inherits only its own.

The general rule, worth remembering when you read a plan before approving it:

> A wave may contain at most one unpaired RED per validation command.

`agent-flow revise "<instruction>"` re-plans and closes the approval gate, so nothing
is implemented against the old graph. Nothing is lost — the tasks that did integrate
stay on the integration branch.

#### Integration itself could not proceed

| Code | What is true | What to do |
|---|---|---|
| `integration_conflict` | Two tasks in one wave changed the same region. The first integrated; the second could not. The conflicting paths are recorded on the run and shown in the dashboard. | The first task's work is safe and stays merged. Retry the second — its new attempt is cut from the integration head as it now stands, so the conflict is usually gone. If the two tasks genuinely overlap, the upstream fix is a plan whose tasks are independent. |
| `integration_worktree_unavailable` | The integration worktree could not be used — most often a merge left in progress by a process that died, which recovery could not abort. | Look at the integration worktree before anything else. Agent Flow will not force it, and neither should you until you know what is in there. |
| `integration_head_missing` | A run was asked to be reviewed before its integration branch was ever initialised, so there is no tree to verify or review. | Run the implementation first. Review reads the integration tree and will not fall back to your checkout. |
| `integration_unreadable` | Git could not *answer* a question the sequence depends on — a branch head, a commit object. Distinct from answering it with something unacceptable. | This one describes a repository that could not be read at all, rather than a repository state. Check disk, permissions and `git fsck`. |

The normative source for all of the above is Appendix A of
[`specs/mvp2-safe-parallel-execution.md`](specs/mvp2-safe-parallel-execution.md), and
§6.3 lists the precondition codes in the order they are checked. A test parses that
appendix and fails if it and the code disagree in either direction, so a code you see
here is a code the product can actually raise.

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
