import { useState } from 'react';
import type { PipelineStage, StageLogView } from '@contracts/index.js';
import { api, keys, type RunAddress } from '../../lib/api';
import { useResource } from '../../lib/store';
import { Empty, Skeleton } from '../../components/ui';

/**
 * One stage's own log, as the stage runner wrote it (§95).
 *
 * The event feed beside this answers *what happened* — a sequence of facts with times.
 * This answers *what the runner said*, which the feed carries two kilobytes of on a
 * failure and none of otherwise. Both are logs and they are not the same log; the tab
 * exists because collapsing them would mean choosing which question to stop answering.
 *
 * `implementation` and `code-review` are absent on purpose: they run once per task and
 * their logs belong to the task panel, which already shows them per attempt.
 */
const STAGES: readonly PipelineStage[] = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
  'verification',
  'final-review',
];

export function StageLog({ address }: { readonly address: RunAddress }) {
  const [stage, setStage] = useState<PipelineStage>('planning');
  const log = useResource<StageLogView>(keys.stageLog(address, stage), () => api.stageLog(address, stage));

  return (
    <div className="stage-log">
      <label className="stage-log__pick">
        <span className="visually-hidden">Stage log</span>
        <select className="input mono" value={stage} onChange={(event) => setStage(event.target.value as PipelineStage)}>
          {STAGES.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      {log.error !== undefined
        ? <Empty error>This stage log could not be read.</Empty>
        : log.loading
          ? <Skeleton rows={4} />
          : log.data?.present !== true
            ? <Empty hint={log.data?.perTask === true
              ? 'It runs once per task, so its logs are on the task panel — one per attempt.'
              : 'Nothing has been written for this stage in this run.'}>
              No log for {stage}.
            </Empty>
            : <>
              {log.data.truncated
                ? <p className="stage-log__cut">Showing the newest {log.data.lines.length} of {log.data.total} lines.</p>
                : null}
              <pre className="stage-log__body">{log.data.lines.join('\n')}</pre>
            </>}
    </div>
  );
}
