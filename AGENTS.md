# Project Instructions

Standing rules for anyone — human or agent — working in this repository.
Everything outside the agent-flow block below is yours to write.

## Language

All source, comments, documentation, commit messages and test names are **English**.

The one exception is the product's Portuguese phrase book — `src/core/phrases/pt-BR.ts`
and `apps/deck/src/lib/i18n/translations/pt-BR.ts` — whose *values* are Portuguese and
whose keys, types and comments are English. Nothing else in the tree is bilingual.

## Architecture

Hexagonal, and the layering is enforced by `test/architecture.test.ts` — over 250 rules
that read the source. A violation is a failing test, not a review comment.

- **`src/core`** is pure. No Node built-in, no `process`, no filesystem, no clock, no
  provider or model name. Folds over state: facts in, a value out. Held to 95% coverage.
- **`src/contracts`** holds the shapes every layer agrees on, as Zod schemas. A new file
  here is a change to the agreement.
- **`src/app`** holds the use cases. Every state change goes through one.
- **`src/adapters`** is the only place that knows a provider, a CLI or Git exists.
- **`src/ports`** declares what the app needs from the world, as interfaces.
- **`src/server`** is HTTP only: it validates, calls a use case, and renders.
- **`src/cli`** is a renderer. It decides nothing a use case could decide.
- **`apps/deck`** is the dashboard. It has its own compiler and imports the server's
  contracts rather than copying them.

Four rules that are load-bearing and easy to break by accident:

- **§60 — no HTTP handler writes state directly.** Every write goes through a use case in
  `src/app`, so the CLI and the dashboard cannot disagree about a gate.
- **§93 — the server names a project by an id it issued, never by a path.** It reads no
  credential and no `process.env`. A request shape has no field for a directory.
- **§20.2 — a worktree is removed through Git, never with `rm -rf`.** A failed attempt's
  worktree is the only remaining copy of what its agent produced (§7.4).
- **One module spawns Git**, and it isolates hooks. Nothing else builds a git command.

## Tests

Every behaviour change needs a test, and a test that could pass for the wrong reason needs
a **positive control** beside it — an assertion that fails when the mechanism is removed.

Two lanes, both must be green:

- `npm run test` — the fast lane, 30 s per test, in-memory fakes.
- the subprocess lane runs automatically for any file that spawns a real process; a test
  using `makeTempRepo` lands there by content, not by configuration.

Also required before a change is done: `npm run typecheck` and `npm run lint`, both clean.

## Comments

Comments say **why**, and name what was measured. This codebase's comments carry the
reasoning that would otherwise be lost — the defect that motivated a guard, the
alternative that was rejected and what it cost. A comment that restates the code is
deleted; a decision without its reason is not finished.

<!-- agent-flow:begin -->

## Validation

These commands are run by agent-flow after implementation:

- `install`: `npm ci`
- `lint`: `npm run lint`
- `typecheck`: `npm run typecheck`
- `test`: `npm run test`
- `build`: `npm run build`

<!-- agent-flow:end -->
