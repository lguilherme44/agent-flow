import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  RunTabs,
  availableSurfaces,
  defaultSurface,
  isTaskSurface,
  paramsForSurface,
  surfaceFromParams,
  type RunSurface,
} from './run-tabs';

/**
 * The secondary navigation M8.5 introduced, and the URL contract it finally honours.
 *
 * These are mostly tests about *addresses*, and that is deliberate. The failure this file
 * exists to prevent is the one it was written to fix: `routeFor` emitted `?panel=review`
 * for two milestones, `RunDetailPage` read only `?view=`, and nothing was ever red —
 * because the only assertions were about the string the function returned rather than
 * about what any page did with it.
 */

const ALL: readonly RunSurface[] = [
  'board',
  'graph',
  'tasks',
  'overview',
  'review',
  'delivery',
  'team',
];

describe('surfaceFromParams', () => {
  const of = (query: string): ReturnType<typeof surfaceFromParams> =>
    surfaceFromParams(new URLSearchParams(query));

  it('reads the three view spellings the app already emits', () => {
    expect(of('view=board')).toBe('board');
    expect(of('view=tasks')).toBe('tasks');
    expect(of('view=overview')).toBe('overview');
  });

  it('keeps `dag` as a spelling of the graph, because every M8 link says it', () => {
    // The docs, the attention routes and every bookmark somebody has. A rename that broke
    // them would be a rename that cost more than it bought.
    expect(of('view=dag')).toBe('graph');
    expect(of('view=graph')).toBe('graph');
  });

  it('reads every `?panel=` the attention queue emits', () => {
    // Five of `routeFor`'s seven branches, none of which did anything before this.
    expect(of('panel=approval')).toBe('overview');
    expect(of('panel=review')).toBe('review');
    // Quality gates render inside the review panel, above everything. Sending a quality
    // item anywhere else puts the reader one surface from the sentence they were promised.
    expect(of('panel=quality')).toBe('review');
    expect(of('panel=delivery')).toBe('delivery');
    expect(of('panel=team')).toBe('team');
  });

  it('prefers `view` when a URL carries both', () => {
    // `paramsForSurface` drops `panel` when it writes `view`, so this only happens on a
    // hand-written address — and the one the person typed last is the explicit one.
    expect(of('view=tasks&panel=team')).toBe('tasks');
  });

  it('asks for nothing when the URL says nothing, and refuses a word it does not know', () => {
    expect(of('')).toBeUndefined();
    expect(of('view=whatever')).toBeUndefined();
    expect(of('panel=logs')).toBeUndefined();
  });
});

describe('paramsForSurface', () => {
  const write = (from: string, surface: RunSurface): string =>
    paramsForSurface(new URLSearchParams(from), surface).toString();

  it('writes nothing for the board, because the board is where a run opens', () => {
    // A landing view that stamps a parameter makes every shared link longer for no gain.
    expect(write('project=demo&view=tasks', 'board')).toBe('project=demo');
  });

  it('writes `dag` for the graph, matching every link that predates this file', () => {
    expect(write('project=demo', 'graph')).toBe('project=demo&view=dag');
  });

  it('keeps the project, which is what makes a run id unambiguous', () => {
    // Run ids restart at 001 per project per year, so two repositories initialised in the
    // same year both hold `AF-2026-001`.
    expect(write('project=demo', 'review')).toBe('project=demo&view=review');
  });

  it('clears `panel` once a tab has been chosen', () => {
    // Otherwise the address keeps asking for the surface the reader has just left, and a
    // reload lands somewhere other than where they are.
    expect(write('panel=team&project=demo', 'overview')).toBe('project=demo&view=overview');
  });

  it('round-trips every surface', () => {
    for (const surface of ALL) {
      expect(surfaceFromParams(paramsForSurface(new URLSearchParams(), surface)) ?? 'board').toBe(
        surface,
      );
    }
  });
});

describe('availableSurfaces', () => {
  it('offers only the tabs that have something behind them', () => {
    // Absent rather than empty, which is the discipline the review, delivery and
    // collaboration panels already applied to themselves one level down. Most runs have no
    // reviewer and no forge, and a permanently empty tab is the same box on every
    // dashboard forever.
    expect(availableSurfaces({ tasks: true, review: false, delivery: false, team: false })).toEqual([
      'board',
      'graph',
      'tasks',
      'overview',
    ]);
  });

  it('always offers Overview, because every run has a pipeline and a plan', () => {
    expect(availableSurfaces({ tasks: false, review: false, delivery: false, team: false })).toEqual(
      ['overview'],
    );
  });

  it('drops the three task renderings together, because they render one list', () => {
    // A plan with no tasks has nothing to lane, nothing to graph and nothing to tabulate.
    const surfaces = availableSurfaces({
      tasks: false,
      review: true,
      delivery: true,
      team: true,
    });

    expect(surfaces).toEqual(['overview', 'review', 'delivery', 'team']);
  });

  it('keeps them in one order however many are present', () => {
    // The order is the order the questions arrive in, and a strip that reshuffled as a run
    // gained a reviewer would move the tab under somebody's cursor.
    expect(availableSurfaces({ tasks: true, review: true, delivery: true, team: true })).toEqual(
      ALL,
    );
  });
});

describe('defaultSurface', () => {
  it('opens on the board when there is one', () => {
    expect(defaultSurface(ALL)).toBe('board');
  });

  it('opens on the overview when the plan has produced no tasks', () => {
    // A board that opened on six empty columns would answer the operator's first question
    // with a shrug; the pipeline says what the run is waiting for.
    expect(defaultSurface(['overview'])).toBe('overview');
  });
});

describe('isTaskSurface', () => {
  it('names the three that share the filter and the selection', () => {
    expect(isTaskSurface('board')).toBe(true);
    expect(isTaskSurface('graph')).toBe(true);
    expect(isTaskSurface('tasks')).toBe(true);
    expect(isTaskSurface('overview')).toBe(false);
    expect(isTaskSurface('review')).toBe(false);
  });
});

describe('RunTabs', () => {
  it('is a real tablist, so a screen reader is told what it is looking at', () => {
    render(<RunTabs surfaces={ALL} active="board" onSelect={() => undefined} />);

    expect(screen.getByRole('tablist', { name: 'Run surfaces' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(ALL.length);
    expect(screen.getByRole('tab', { name: 'Board' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Graph' })).toHaveAttribute('aria-selected', 'false');
  });

  it('keeps exactly one tab in the tab order', () => {
    // The roving-tabindex contract: Tab reaches the strip once and the arrows move inside
    // it. Seven stops would make the strip the longest thing on the page to walk past.
    render(<RunTabs surfaces={ALL} active="overview" onSelect={() => undefined} />);

    const reachable = screen.getAllByRole('tab').filter((tab) => tab.tabIndex === 0);
    expect(reachable).toHaveLength(1);
    expect(reachable[0]).toHaveAccessibleName('Overview');
  });

  it('moves with the arrow keys, and wraps', async () => {
    const onSelect = vi.fn();
    render(<RunTabs surfaces={['board', 'graph', 'tasks']} active="board" onSelect={onSelect} />);

    screen.getByRole('tab', { name: 'Board' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onSelect).toHaveBeenLastCalledWith('graph');

    await userEvent.keyboard('{ArrowLeft}');
    // Wrapping rather than stopping: a strip whose first tab swallows Left is a strip
    // where the last one is three keypresses away from the first.
    expect(onSelect).toHaveBeenLastCalledWith('tasks');
  });

  it('reports the active tab as the current page as well as the selected tab', () => {
    // These tabs are also addresses — every one of them is linkable and bookmarkable —
    // and `aria-current` is what says so to a reader who arrived by one.
    render(<RunTabs surfaces={ALL} active="team" onSelect={() => undefined} />);

    expect(screen.getByRole('tab', { name: 'Team' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('tab', { name: 'Board' })).not.toHaveAttribute('aria-current');
  });

  it('renders the filter beside the tabs rather than inside them', () => {
    // The toolbar is a sibling of the tablist, not a child: a search box announced as one
    // of seven tabs is a search box the arrow keys land on.
    render(
      <RunTabs surfaces={ALL} active="board" onSelect={() => undefined}>
        <button type="button">a filter</button>
      </RunTabs>,
    );

    expect(screen.getByRole('button', { name: 'a filter' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(ALL.length);
  });
});
