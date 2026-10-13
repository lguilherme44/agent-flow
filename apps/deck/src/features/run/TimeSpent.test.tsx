import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunTimelineView } from '@contracts/index.js';
import { clearStore } from '../../lib/store';
import { TimeSpent } from './TimeSpent';
import { I18nProvider, en, ptBR, type Locale } from '../../lib/i18n';

/**
 * Where the run's wall clock went, drawn.
 *
 * The fixture is the run that asked for this block, in round numbers: 337 minutes of wall
 * clock of which the model worked 72. What is asserted is what a reader needs to see —
 * every cause in the legend with its minutes, the model's dollars beside it, the bar's
 * widths as shares of the wall clock, and the stage table — and that a run whose runners
 * reported no cost shows no money at all.
 *
 * Run in both languages, because the currency is a word too: the English one once rendered
 * no symbol at all, and a `not.toContain('$')` in one language only would have passed on it.
 */

const MIN = 60_000;
const address = { projectId: 'flowcanvas', runId: 'AF-2026-001' };

const TIMELINE: RunTimelineView = {
  startedAt: '2026-10-05T12:00:00.000Z',
  endedAt: '2026-10-05T17:37:00.000Z',
  wallMs: 337 * MIN,
  modelMs: 72 * MIN,
  validationMs: 15 * MIN,
  waitingForHumanMs: 75 * MIN,
  quotaWaitMs: 142 * MIN,
  reworkMs: 20 * MIN,
  otherMs: 13 * MIN,
  costUsd: 32,
  modelCostUsd: 24,
  reworkCostUsd: 8,
  inFlight: false,
  stages: [
    { stage: 'discovery', attempts: 1, modelMs: 15 * MIN, costUsd: 12 },
    { stage: 'planning', attempts: 3, modelMs: 30 * MIN },
  ],
  tasks: [],
  segments: [],
};

function serve(view: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(view), { status, headers: { 'content-type': 'application/json' } }),
      ),
    ),
  );
}

const LOCALES: readonly { locale: Locale; t: typeof en }[] = [
  { locale: 'en', t: en },
  { locale: 'pt-BR', t: ptBR },
];

function show(locale: Locale) {
  return render(
    <I18nProvider locale={locale}>
      <TimeSpent address={address} />
    </I18nProvider>,
  );
}

for (const { locale, t } of LOCALES) {
  describe(`where the time went (${locale})`, () => {
    beforeEach(() => clearStore());
    afterEach(() => vi.unstubAllGlobals());

    it('lists every cause with its minutes, and the model’s and rework’s dollars', async () => {
      serve(TIMELINE);
      show(locale);

      const block = await screen.findByLabelText(t.timeSpent.title);
      const legend = within(block).getByRole('list');
      const item = (label: string) => within(legend).getByText(label).closest('li')?.textContent ?? '';

      // The symbol itself, so a currency that renders as a bare number fails here.
      expect(t.timeSpent.usd('24.00')).toContain('$');
      expect(item(t.timeSpent.model)).toContain('1h 12m');
      expect(item(t.timeSpent.model)).toContain(t.timeSpent.usd('24.00'));
      expect(item(t.timeSpent.rework)).toContain(t.timeSpent.usd('8.00'));
      expect(item(t.timeSpent.quota)).toContain('2h 22m');
      expect(item(t.timeSpent.human)).toContain('1h 15m');
      expect(item(t.timeSpent.validation)).toContain('15m');
      // Waiting is never priced.
      expect(item(t.timeSpent.human)).not.toContain('$');
      expect(within(block).getByText(t.timeSpent.notABill)).toBeInTheDocument();
      // The greedy quota rule is said wherever quota time is shown.
      expect(within(block).getByText(t.timeSpent.quotaNote)).toBeInTheDocument();
      expect(within(block).queryByText(t.timeSpent.staleNote)).toBeNull();
    });

    it('sizes each part of the bar as its share of the wall clock', async () => {
      serve(TIMELINE);
      const { container } = show(locale);
      await screen.findByLabelText(t.timeSpent.bar);

      const width = (part: string) =>
        Number.parseFloat(
          (container.querySelector(`.time-spent__part[data-part="${part}"]`) as HTMLElement).style.width,
        );

      expect(width('quota')).toBeCloseTo((142 / 337) * 100, 3);
      expect(width('model')).toBeCloseTo((72 / 337) * 100, 3);
      const total = ['model', 'validation', 'human', 'quota', 'rework', 'other'].reduce(
        (sum, part) => sum + width(part),
        0,
      );
      expect(total).toBeCloseTo(100, 6);
    });

    it('tabulates the stages, saying "not reported" where no cost was', async () => {
      serve(TIMELINE);
      show(locale);

      const table = await screen.findByRole('table', { name: t.timeSpent.byStage });
      const planning = within(table).getByText(t.words.planning).closest('tr');

      expect(planning?.textContent).toContain('3');
      expect(planning?.textContent).toContain('30.0');
      expect(planning?.textContent).toContain(t.timeSpent.notReported);
      expect(within(table).getByText('12.00')).toBeInTheDocument();
    });

    it('shows no money at all when no runner reported any', async () => {
      const { costUsd: _c, modelCostUsd: _m, reworkCostUsd: _r, ...unpriced } = TIMELINE;
      serve({ ...unpriced, quotaWaitMs: 0, stages: [{ stage: 'planning', attempts: 1, modelMs: MIN }] });
      show(locale);

      const block = await screen.findByLabelText(t.timeSpent.title);

      expect(block.textContent).not.toContain('$');
      expect(within(block).queryByText(t.timeSpent.notABill)).toBeNull();
      expect(within(block).queryByText(t.timeSpent.quotaNote)).toBeNull();
    });

    it('says when a silent run’s open stage was cut at its last event', async () => {
      serve({ ...TIMELINE, inFlight: true, stale: true });
      show(locale);

      expect(await screen.findByText(t.timeSpent.staleNote)).toBeInTheDocument();
    });

    it('says it could not read the timeline rather than drawing an empty bar', async () => {
      serve({}, 500);
      show(locale);

      expect(await screen.findByText(t.timeSpent.couldNotRead)).toBeInTheDocument();
    });
  });
}
