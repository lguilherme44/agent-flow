import { useEffect, useMemo, useRef, useState } from 'react';
import type { Timeline } from '../../lib/replay';
import { describe } from '../../lib/sentence';
import { formatClock, formatDay } from '../../lib/time';
import { Empty } from '../../components/ui';
import { useT } from '../../lib/i18n';

/**
 * The log, newest first, said in sentences.
 *
 * Lines after the playhead are still drawn, dimmed: a person scrubbing backwards wants to
 * see what they are scrubbing past. The line at the playhead is kept in view, so dragging
 * the recorder reads as paging through the log. Clicking a line moves the playhead to it,
 * and selects its task when it names one.
 */
export function Feed({
  timeline,
  t,
  live,
  onJump,
  selected,
  runId,
  onOpenStageLog,
}: {
  timeline: Timeline;
  t: number;
  live: boolean;
  onJump: (at: number, task?: string) => void;
  selected: string | undefined;
  runId?: string;
  onOpenStageLog?: (stage: string) => void;
}) {
  // `t` is the playhead instant in this component's props; the dictionary is `dict`.
  const dict = useT();
  const [needle, setNeedle] = useState('');
  const [onlySelected, setOnlySelected] = useState(false);
  const [expandedIndices, setExpandedIndices] = useState<ReadonlySet<number>>(new Set());
  const currentRef = useRef<HTMLButtonElement>(null);

  const toggleExpand = (index: number) => {
    setExpandedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const rows = useMemo(() => {
    const q = needle.trim().toLowerCase();
    const list = [...timeline.events].reverse().map((event) => ({ event, said: describe(event, dict) }));
    return list.filter(({ event, said }) => {
      const task = (event.detail['task'] ?? event.detail['taskId']) as string | undefined;
      if (onlySelected && selected !== undefined && task !== selected) return false;
      if (q === '') return true;
      return `${event.type} ${said.title} ${said.detail ?? ''} ${task ?? ''}`.toLowerCase().includes(q);
    });
  }, [timeline.events, needle, onlySelected, selected, dict]);

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

  if (timeline.events.length === 0) return <Empty hint={dict.feed.fillsAsItMoves}>{dict.feed.nothingYet}</Empty>;

  let lastDay = '';
  return (
    <div className="feed">
      <div className="filters" style={{ marginBottom: 8 }}>
        <input className="input" style={{ width: '100%', flex: 1 }} placeholder={dict.feed.filterPlaceholder} value={needle} onChange={(event) => setNeedle(event.target.value)} aria-label={dict.feed.filterAria} />
        {selected === undefined ? null : (
          <button type="button" className="toggle" aria-pressed={onlySelected} onClick={() => setOnlySelected((value) => !value)}>
            {dict.feed.onlyThis(selected)}
          </button>
        )}
      </div>
      {rows.map(({ event, said }) => {
        const day = formatDay(event.at_ms, dict.time);
        const separator = day !== lastDay ? <div className="feed__day">{day}</div> : null;
        lastDay = day;
        const task = (event.detail['task'] ?? event.detail['taskId']) as string | undefined;
        const isCurrent = current === event.index && !live;

        const isFailure = event.type === 'stage_failed' || (event.type === 'task_finished' && event.detail['status'] === 'failed');
        const rawExcerpt = event.detail['rawExcerpt'] as string | undefined;
        const failureClass = (event.detail['failureClass'] ?? event.detail['reason']) as string | undefined;
        const deniedCommand = event.detail['deniedCommand'] as string | undefined;
        const problems = Array.isArray(event.detail['problems']) ? (event.detail['problems'] as unknown[]).map(String) : undefined;
        const stage = event.detail['stage'] as string | undefined;
        const hasFailureDetails = isFailure && Boolean(rawExcerpt || failureClass || deniedCommand || (problems && problems.length > 0));
        const isExpanded = expandedIndices.has(event.index);

        return (
          <div key={event.index}>
            {separator}
            <button
              ref={isCurrent ? currentRef : undefined}
              type="button"
              className="feed__row"
              data-current={isCurrent}
              data-future={!live && event.at_ms > t}
              onClick={() => {
                onJump(event.at_ms, task);
                if (hasFailureDetails) toggleExpand(event.index);
              }}
              title={event.type}
            >
              <span className="feed__time">{formatClock(event.at_ms)}</span>
              <span className="feed__dot" data-tone={said.tone} aria-hidden="true" />
              <span className="feed__text">
                <div className="feed__title">
                  {said.title}
                  {hasFailureDetails ? (
                    <button
                      type="button"
                      className="feed__row-expand-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpand(event.index);
                      }}
                    >
                      {isExpanded ? dict.feed.less : dict.feed.details}
                    </button>
                  ) : null}
                </div>
                {said.detail === undefined ? null : <div className="feed__detail">{said.detail}</div>}
              </span>
            </button>
            {isExpanded && hasFailureDetails ? (
              <div className="feed__failure-box">
                <div className="feed__failure-meta">
                  {failureClass ? <span className="chip" data-tone="bad">{failureClass}</span> : null}
                  {deniedCommand ? <span className="chip" data-tone="warn">{dict.feed.deniedTool(deniedCommand)}</span> : null}
                  {stage && onOpenStageLog ? (
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      onClick={() => onOpenStageLog(stage)}
                    >
                      {dict.feed.openStageLog(stage)}
                    </button>
                  ) : null}
                </div>
                {problems && problems.length > 0 ? (
                  <ul style={{ margin: '6px 0 6px 16px', padding: 0 }}>
                    {problems.map((prob, i) => (
                      <li key={i}>{prob}</li>
                    ))}
                  </ul>
                ) : null}
                {rawExcerpt ? (
                  <pre className="feed__failure-excerpt">{rawExcerpt}</pre>
                ) : null}
                {stage && runId ? (
                  <div className="feed__failure-hint">
                    {dict.feed.logOnDisk} .agent-flow/runs/{runId}/logs/{stage}.log
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
