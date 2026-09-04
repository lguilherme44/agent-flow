/**
 * The URL contract for a run's secondary navigation (M8.5 §16, §17).
 *
 * **The screen used to show all of it at once.** The run panel, the nine-step pipeline,
 * the isolation strip, the task table, the inspector, four summary cards, the review
 * panel, the delivery panel, the team panel and the collaboration panel were one
 * scrolling page. Measured at 1440×900 before this: 1753px of document for a 900px
 * viewport, of which the board held 555 — a third of the page for the thing the page is
 * for, with 450px of header above it and 850px of panels below the fold.
 *
 * Nothing moved out of the product. Every panel is still one click away, and every one
 * of them is still a projection the server folded. What changed is that only one of them
 * is on screen at a time, which is the difference between a tool and a wall.
 *
 * **This also makes six of the seven attention deep links work for the first time.**
 * `routeFor` in `attention.tsx` has been emitting `?panel=approval`, `?panel=review`,
 * `?panel=quality`, `?panel=delivery` and `?panel=team` since M8, and `RunDetailPage`
 * read only `?view=`. Its unit tests assert the *string* the function returns, so
 * nothing was ever red: a P1 row reading "Review the findings" navigated to a run page
 * that ignored the word `review` and left the panel 1300 pixels below the fold. A URL
 * parameter nobody reads fails no compiler, no linter and no assertion — the same shape
 * as a CSS class nobody defines. `PANEL_SURFACE` below is where that stops.
 *
 * **Plain `.ts`, deliberately, and that is what makes the acceptance test executable.**
 * `M8-ACC-19` used to assert two regular expressions against `RunDetailPage.tsx` — a
 * check that goes green on a rename and red on a reformat, and whose own comment claimed
 * `?task=` round-tripped while asserting nothing about it. The node suite can import a
 * `.ts` file from `apps/web` and cannot import a `.tsx`, so moving the pure half here is
 * what lets that test call these functions instead of reading them.
 */

/**
 * One rendering of the run, or one of its projections.
 *
 * `board`, `graph` and `tasks` are three renderings of the *same* task list, sharing the
 * filter and the selection — which is what makes them views rather than pages, and why
 * moving between them must not feel like navigating away (§88). The rest are separate
 * projections that used to be stacked panels.
 */
export type RunSurface = 'board' | 'graph' | 'tasks' | 'overview' | 'review' | 'delivery' | 'team';

/** The three that render the task list, so callers can ask the question once. */
export function isTaskSurface(surface: RunSurface): boolean {
  return surface === 'board' || surface === 'graph' || surface === 'tasks';
}

export const SURFACE_LABEL: Record<RunSurface, string> = {
  board: 'Board',
  graph: 'Graph',
  tasks: 'Tasks',
  overview: 'Overview',
  review: 'Review',
  delivery: 'Delivery',
  team: 'Team',
};

/**
 * Tab order, and it is the order the questions arrive in.
 *
 * The board first because it is the answer to "what is happening and what is stuck",
 * which is what an operator opens a run to find out. Overview — the pipeline, the plan,
 * the artifacts, the model spend — is what they read once they have decided to look.
 */
const SURFACE_ORDER: readonly RunSurface[] = [
  'board',
  'graph',
  'tasks',
  'overview',
  'review',
  'delivery',
  'team',
];

/**
 * Which surface an attention item's `?panel=` lands on.
 *
 * `approval` is part of the run's overview — the gate, its verdict and the plan hash are
 * facts about the plan, and the plan is what Overview describes. `quality` is part of
 * the review: the unsatisfied gates render inside `ReviewPanel`, above everything, and
 * sending a quality item anywhere else would put the reader one surface away from the
 * sentence they were promised.
 */
const PANEL_SURFACE: Record<string, RunSurface> = {
  approval: 'overview',
  review: 'review',
  quality: 'review',
  delivery: 'delivery',
  team: 'team',
};

/**
 * The surface a URL asks for, or `undefined` when it asks for none.
 *
 * Reads `?view=` first, then `?panel=` — the two parameters the app already emits.
 *
 * **No contract import, and that is load-bearing rather than incidental.** An earlier draft
 * of this file exported a `surfaceForFocus(focus: AttentionFocus)` that nothing called but
 * its own test, and typing it meant importing `@contracts` — from a plain `.ts` inside
 * `apps/web`, which the root program compiles without the `@contracts` alias, and by a
 * relative path the architecture rule forbidding value imports from the contracts cannot
 * see. Deleting speculative API removed both problems at once. The focus-to-route mapping
 * lives where it is used, in `attention.ts`'s `routeFor`.
 * `?view=dag` is spelled that way in every link M8 shipped and in the docs, so it stays
 * an accepted spelling of `graph` rather than becoming a broken bookmark.
 */
export function surfaceFromParams(params: URLSearchParams): RunSurface | undefined {
  const view = params.get('view');
  if (view === 'dag' || view === 'graph') return 'graph';
  if (view !== null && SURFACE_ORDER.includes(view as RunSurface)) return view as RunSurface;

  const panel = params.get('panel');
  if (panel !== null && panel in PANEL_SURFACE) return PANEL_SURFACE[panel];

  return undefined;
}

/**
 * The spelling a surface is written as in the URL.
 *
 * `graph` writes `dag`, matching every link and every document that predates this file.
 * The board is the default and writes nothing: a landing view that stamps a parameter
 * makes every shared link longer for no gain, and makes "no parameter" mean something
 * different from what it means today.
 */
export function paramsForSurface(params: URLSearchParams, surface: RunSurface): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete('panel');

  if (surface === 'board') next.delete('view');
  else if (surface === 'graph') next.set('view', 'dag');
  else next.set('view', surface);

  return next;
}

/**
 * Which tabs this run has.
 *
 * **Absent rather than empty**, which is the discipline the review, delivery and
 * collaboration panels already followed one level down: most runs have no reviewer and
 * no forge, and a permanently empty tab is the same box on every dashboard forever —
 * it just costs 60 horizontal pixels instead of 200 vertical ones. A tab that is here is
 * a tab with something behind it.
 *
 * `overview` is unconditional. Every run has a pipeline and a plan.
 */
export function availableSurfaces(has: {
  tasks: boolean;
  review: boolean;
  delivery: boolean;
  team: boolean;
}): readonly RunSurface[] {
  return SURFACE_ORDER.filter((surface) => {
    switch (surface) {
      case 'board':
      case 'graph':
      case 'tasks':
        return has.tasks;
      case 'review':
        return has.review;
      case 'delivery':
        return has.delivery;
      case 'team':
        return has.team;
      case 'overview':
        return true;
    }
  });
}

/**
 * The tab a run opens on.
 *
 * The board, when the plan has produced tasks. A plan with none has nothing to lane, and
 * a board that opened on six empty columns would answer the operator's first question
 * with a shrug — so a run that has not planned yet opens on its overview, where the
 * pipeline says what it is waiting for.
 */
export function defaultSurface(available: readonly RunSurface[]): RunSurface {
  return available.includes('board') ? 'board' : 'overview';
}

/** Every surface, in tab order. Exported for the tests that enumerate them. */
export const RUN_SURFACES = SURFACE_ORDER;
