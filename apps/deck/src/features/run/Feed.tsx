import { useEffect, useMemo, useRef, useState } from 'react';
import type { Timeline } from '../../lib/replay';
import { describe } from '../../lib/sentence';
import { formatClock, formatDay } from '../../lib/time';
import { Empty } from '../../components/ui';

/**
 * The log, newest first, said in sentences.
 *
 * Lines after the playhead are still drawn, dimmed: a person scrubbing backwards wants to
 * see what they are scrubbing past. The line at the playhead is kept in view, so dragging
 * the recorder reads as paging through the log. Clicking a line moves the playhead to it,
 * and selects its task when it names one.
 */
export function Feed({ timeline, t, live, onJump, selected }: { timeline: Timeline; t: number; live: boolean; onJump: (at: number, task?: string) => void; selected: string | undefined }) {
  const [needle, setNeedle] = useState('');
  const [onlySelected, setOnlySelected] = useState(false);
  const currentRef = useRef<HTMLButtonElement>(null);

  const rows = useMemo(() => {
    const q = needle.trim().toLowerCase();
    const list = [...timeline.events].reverse().map((event) => ({ event, said: describe(event) }));
    return list.filter(({ event, said }) => {
      const task = (event.detail['task'] ?? event.detail['taskId']) as string | undefined;
      if (onlySelected && selected !== undefined && task !== selected) return false;
      if (q === '') return true;
      return `${event.type} ${said.title} ${said.detail ?? ''} ${task ?? ''}`.toLowerCase().includes(q);
    });
  }, [timeline.events, needle, onlySelected, selected]);

  const current = useMemo(() => {
    let newest: number | undefined;
    for (const event of timeline.events) {
      if (event.at_ms <= t) newest = event.index;
      else break;
    }
    return newest;
  }, [timeline.events, t]);

  useEffect(() => {
    if (live) return;
    const row = currentRef.current;
    // Scroll the panel, never the page: `scrollIntoView` would drag the whole document
    // to the log every time the playhead moved.
    const pane = row?.closest<HTMLElement>('.panel__body');
    if (row === null || row === undefined || pane === null || pane === undefined) return;
    const rowRect = row.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    pane.scrollTop += rowRect.top - paneRect.top - pane.clientHeight / 2 + rowRect.height / 2;
  }, [current, live]);

  if (timeline.events.length === 0) return <Empty hint="The audit log fills as the run moves.">Nothing has been written yet.</Empty>;

  let lastDay = '';
  return (
    <div className="feed">
      <div className="filters" style={{ marginBottom: 8 }}>
        <input className="input" style={{ width: '100%', flex: 1 }} placeholder="Filter lines…" value={needle} onChange={(event) => setNeedle(event.target.value)} aria-label="Filter log lines" />
        {selected === undefined ? null : (
          <button type="button" className="toggle" aria-pressed={onlySelected} onClick={() => setOnlySelected((value) => !value)}>
            {selected} only
          </button>
        )}
      </div>
      {rows.map(({ event, said }) => {
        const day = formatDay(event.at_ms);
        const separator = day !== lastDay ? <div className="feed__day">{day}</div> : null;
        lastDay = day;
        const task = (event.detail['task'] ?? event.detail['taskId']) as string | undefined;
        const isCurrent = current === event.index && !live;
        return (
          <div key={event.index}>
            {separator}
            <button
              ref={isCurrent ? currentRef : undefined}
              type="button"
              className="feed__row"
              data-current={isCurrent}
              data-future={!live && event.at_ms > t}
              onClick={() => onJump(event.at_ms, task)}
              title={event.type}
            >
              <span className="feed__time">{formatClock(event.at_ms)}</span>
              <span className="feed__dot" data-tone={said.tone} aria-hidden="true" />
              <span className="feed__text">
                <div className="feed__title">{said.title}</div>
                {said.detail === undefined ? null : <div className="feed__detail">{said.detail}</div>}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
