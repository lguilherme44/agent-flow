import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunEvent } from '@contracts/index.js';
import { buildTimeline } from '../../lib/replay';
import { LANE } from '../../lib/recorder';
import { ptBR as t, word } from '../../lib/i18n';
import { Recorder, type RecorderProps } from './Recorder';

/**
 * What a person can read off the recorder without hovering.
 *
 * The screenshot that opened this: a ten-hour run drawn as anonymous green and red blocks,
 * glyphs nobody could name, and lanes labelled by id alone. These tests pin the three
 * things that make it decodable — a legend that explains only what is on screen, a stage
 * label that shrinks before it disappears, and the task's title beside its id.
 */

const T0 = Date.parse('2026-09-10T19:00:00.000Z');
const HOUR = 3_600_000;
const at = (offsetSeconds: number): string => new Date(T0 + offsetSeconds * 1_000).toISOString();
const event = (offsetSeconds: number, type: string, detail: Record<string, unknown> = {}): RunEvent => ({ at: at(offsetSeconds), type, detail });

/**
 * Ten hours on a 1200px plot is about 40 px an hour. `planning` ran forty minutes — room
 * for `plano`, not for `planejamento` — and `sdd` two minutes, room for nothing.
 */
const LOG: RunEvent[] = [
  event(0, 'run_created'),
  event(60, 'stage_started', { stage: 'planning', runner: 'agy' }),
  event(2_460, 'stage_completed', { stage: 'planning', runner: 'agy' }),
  event(2_461, 'stage_started', { stage: 'sdd' }),
  event(2_581, 'stage_failed', { stage: 'sdd' }),
  event(2_600, 'run_approved'),
  event(2_601, 'task_started', { task: 'TASK-001' }),
  event(4_400, 'task_finished', { task: 'TASK-001', status: 'completed' }),
  event(4_401, 'task_attempt_validated', { task: 'TASK-001' }),
];

/**
 * The same run under worktree isolation, which writes five event types the plain run does
 * not: a git identity, a classification, the operator's own audit line, the integration
 * branch and a task's workspace. Every one of them reached the tape as `other` until the
 * fold in `replay.ts` learned them.
 */
const ISOLATED_LOG: RunEvent[] = [
  event(0, 'run_created'),
  event(0, 'run_git_identity_assigned', { isolationMode: 'worktree' }),
  event(0, 'workflow_classified', { workflow: 'standard' }),
  event(1, 'execution_lock_acquired', { operation: 'approve' }),
  event(1, 'run_approved'),
  event(1, 'operator_action', { action: 'approve', actor: 'cli' }),
  event(2, 'integration_branch_created', { branch: 'agent-flow/AF-1/integration' }),
  event(2, 'task_workspace_created', { task: 'TASK-001' }),
  event(3, 'task_started', { task: 'TASK-001' }),
  event(2_400, 'task_finished', { task: 'TASK-001', status: 'completed' }),
  event(2_401, 'task_attempt_validated', { task: 'TASK-001' }),
];

const TITLE = 'Parse the config file before the first read';

function plotWidth(width: number): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width,
    height: 200,
    top: 0,
    left: 0,
    right: width,
    bottom: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

function draw(overrides: Partial<RecorderProps> = {}) {
  const props: RecorderProps = {
    timeline: buildTimeline(LOG, T0 + 10 * HOUR),
    domain: [T0, T0 + 10 * HOUR],
    t: T0 + 10 * HOUR,
    live: true,
    finished: false,
    truncated: false,
    onScrub: () => undefined,
    selected: undefined,
    onSelect: () => undefined,
    rows: [
      { id: 'TASK-001', title: TITLE },
      { id: 'FIX-001', title: '' },
    ],
    liveStates: new Map([['TASK-001', 'completed']]),
    past: undefined,
    ...overrides,
  };
  return render(<Recorder {...props} />);
}

describe('Recorder', () => {
  beforeEach(() => {
    const observer = { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    // `function`, not an arrow. Vitest 4 made `vi.fn()` constructible, and the price is that
    // a mock whose implementation is an arrow function now throws on `new` — which is
    // exactly how the component asks for its observer. A constructor that returns an object
    // hands that object back, so the spies below are still the ones the component calls.
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn(function ResizeObserverStub() {
        return observer;
      }),
    );
    plotWidth(1200);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('explains only the colours and marks that are on screen', () => {
    draw();
    const legend = screen.getByRole('list', { name: t.recorder.legend });

    expect(within(legend).getByText(word(t, 'completed'))).toBeInTheDocument();
    expect(within(legend).getByText(word(t, 'failed'))).toBeInTheDocument();
    // Nothing in this log is still running or was reused; the legend does not say so.
    expect(within(legend).queryByText(word(t, 'running'))).not.toBeInTheDocument();
    expect(within(legend).queryByText(word(t, 'reused'))).not.toBeInTheDocument();

    expect(within(legend).getByText(t.recorder.marks.created)).toBeInTheDocument();
    expect(within(legend).getByText(t.recorder.marks.approved)).toBeInTheDocument();
    expect(within(legend).getByText(t.recorder.marks.validated)).toBeInTheDocument();
    expect(within(legend).queryByText(t.recorder.marks.finding)).not.toBeInTheDocument();
  });

  it('shortens a stage label before dropping it', () => {
    const { container } = draw();
    const labels = [...container.querySelectorAll('.svg-tape-label')].map((node) => node.textContent);
    expect(labels).toEqual([t.stageShort.planning]);
    expect(labels).not.toContain(t.stageLong.planning);
  });

  it('puts the task title beside its id when the gutter is wide enough', () => {
    const { container } = draw();
    const titles = [...container.querySelectorAll('.svg-lane-title')];
    // One title: FIX-001 has none to show.
    expect(titles).toHaveLength(1);
    expect(titles[0]?.textContent).toMatch(/^Parse the config/);
    expect(titles[0]?.textContent).toMatch(/…$/);
    // The grab area starts where the lanes do, and CSS learns that from the component.
    expect(container.querySelector<HTMLElement>('.recorder')?.style.getPropertyValue('--gutter')).toBe('260px');
  });

  it('gives the title up on a narrow plot rather than overlapping the bars', () => {
    plotWidth(600);
    const { container } = draw();
    expect(container.querySelectorAll('.svg-lane-title')).toHaveLength(0);
    expect(container.querySelector<HTMLElement>('.recorder')?.style.getPropertyValue('--gutter')).toBe('84px');
  });

  it('on a phone, folds the legend behind a button and drops the keyboard hints', () => {
    plotWidth(370);
    const { container } = draw();
    // Nineteen legend entries were a third of the screen before the tape began.
    const toggle = screen.getByRole('button', { name: new RegExp(t.recorder.legend) });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelectorAll('.recorder__legend-item')).toHaveLength(0);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelectorAll('.recorder__legend-item').length).toBeGreaterThan(0);
    // A screen with no keyboard has no use for the shortcuts.
    expect(container.querySelector('.recorder__keys')).toBeNull();
  });

  it('on a wide touch screen — a phone held sideways — folds too: no keyboard came with the width', () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('coarse'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const { container } = draw();
    expect(screen.getByRole('button', { name: new RegExp(t.recorder.legend) })).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.recorder__keys')).toBeNull();
  });

  it('on a desk, shows the legend open with no button to press', () => {
    const { container } = draw();
    expect(screen.queryByRole('button', { name: new RegExp(t.recorder.legend) })).toBeNull();
    expect(container.querySelectorAll('.recorder__legend-item').length).toBeGreaterThan(0);
    expect(container.querySelector('.recorder__keys')).not.toBeNull();
  });

  it('names every mark it draws', () => {
    const { container } = draw();
    const kinds = [...container.querySelectorAll('.svg-mark')].map((node) => node.getAttribute('data-kind'));
    expect(kinds).toEqual(expect.arrayContaining(['created', 'approved', 'validated']));
  });

  it('names every mark a run under worktree isolation draws, and none of them is `other`', () => {
    // The run `deck-recorder.spec.ts` records, in miniature. It reached CI nine marks of
    // twenty-seven as `other`, because the whole isolation vocabulary — the git identity,
    // the classification, the operator's own action, the integration branch and a task's
    // workspace — had a sentence and a dictionary word and no entry in the fold's table.
    // "The legend names it" was true the whole time: `other` is a name, and naming
    // everything `other` is the failure. So this asserts the stronger thing.
    const { container } = draw({
      timeline: buildTimeline(ISOLATED_LOG, T0 + 10 * HOUR),
      rows: [{ id: 'TASK-001', title: TITLE }],
    });
    const legend = screen.getByRole('list', { name: t.recorder.legend });
    const named = [...legend.querySelectorAll('.recorder__legend-item span')].map((node) => node.textContent);
    const kinds = [...container.querySelectorAll('.svg-mark')].map((node) => node.getAttribute('data-kind') ?? '');
    const marks: Readonly<Record<string, string | undefined>> = t.recorder.marks;

    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).not.toContain('other');
    for (const kind of new Set(kinds)) {
      expect(named, `the legend does not name ${kind}`).toContain(marks[kind]);
    }

    // The control: `other` is still reachable, so the assertion above is a claim about
    // this vocabulary rather than about a bucket that was quietly deleted.
    const stranger = draw({
      timeline: buildTimeline([...ISOLATED_LOG, event(4, 'something_new', { task: 'TASK-001' })], T0 + 10 * HOUR),
      rows: [{ id: 'TASK-001', title: TITLE }],
    });
    const strangerKinds = [...stranger.container.querySelectorAll('.svg-mark')].map((node) => node.getAttribute('data-kind'));
    expect(strangerKinds).toContain('other');
  });

  it('names the task only on a lane bar, so a count of attempts can leave the decoration out', () => {
    const { container } = draw();
    // `.svg-attempt` is drawn in three roles with the same class and the same
    // `data-outcome`: the legend swatch, the stage tape cell and the lane bar. Only the
    // lane bar belongs to a task, and `[data-task]` is what a caller counting attempts has
    // to say — `deck-recorder.spec.ts` counted 4 running bars for 2 parked agents until it
    // did.
    const everywhere = container.querySelectorAll('.svg-attempt[data-outcome="completed"]');
    const lanes = [...container.querySelectorAll('.svg-attempt[data-outcome="completed"][data-task]')];

    // The control: the unscoped selector really does pick up more than the lanes here — a
    // legend entry for `completed` and the `planning` tape cell — so the scope is doing
    // work rather than describing a distinction the DOM does not make.
    expect(everywhere.length).toBeGreaterThan(lanes.length);
    expect(lanes.map((node) => node.getAttribute('data-task'))).toEqual(['TASK-001']);
  });

  it('draws a task mark above its bar, not across it', () => {
    const { container } = draw();
    const bar = container.querySelector('.svg-attempt[data-task="TASK-001"]');
    const mark = container.querySelector('.svg-mark[data-kind="validated"]');
    expect(bar).not.toBeNull();
    expect(mark).not.toBeNull();
    const barTop = Number(bar?.getAttribute('y'));
    const markY = Number(/translate\([-\d.]+ ([-\d.]+)\)/.exec(mark?.getAttribute('transform') ?? '')?.[1]);
    expect(Number.isFinite(markY)).toBe(true);
    // The lowest pixel of the mark sits on or above the top of the bar.
    expect(markY + LANE.mark + 1).toBeLessThanOrEqual(barTop);
  });
});
