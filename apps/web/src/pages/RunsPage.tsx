import { Link } from 'react-router-dom';
import { useProjectSelection } from '../app/project-context';
import { useRuns } from '../lib/queries';
import { Empty, Progress, StatusDot, cx } from '../components/ui';
import { formatWhen } from '../lib/format';
import { runLabel, runTone } from '../lib/status';

/** Runs (§79) — history for the selected project, or for all of them. */
export function RunsPage(): JSX.Element {
  const { projectId } = useProjectSelection();
  const runs = useRuns(projectId);

  if (runs.isError) {
    return (
      <Empty
        title="Runs could not be read."
        hint={runs.error instanceof Error ? runs.error.message : undefined}
      />
    );
  }

  if (runs.data === undefined) return <Empty title="Loading runs…" />;

  if (runs.data.length === 0) {
    return (
      <Empty
        title="No runs yet."
        hint={
          <>
            Start one with <code className="font-mono">agent-flow feature &quot;…&quot;</code>
          </>
        }
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto rounded-lg border border-border bg-surface">
      <table className="w-full border-collapse text-body">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-border text-label uppercase tracking-wide text-faint">
            <th scope="col" className="w-32 px-3 py-2 text-left font-medium">
              Run
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Feature
            </th>
            <th scope="col" className="w-40 px-3 py-2 text-left font-medium">
              Status
            </th>
            <th scope="col" className="w-40 px-3 py-2 text-left font-medium">
              Progress
            </th>
            <th scope="col" className="w-44 px-3 py-2 text-left font-medium">
              Started
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.data.map((run) => {
            const progress =
              run.taskCount === 0 ? 0 : (run.completedTasks / run.taskCount) * 100;

            return (
              <tr key={`${run.projectId}:${run.runId}`} className="border-b border-border/60 hover:bg-surface-2">
                <td className="px-3 py-2">
                  <Link
                    to={`/runs/${run.runId}`}
                    className="tabular font-medium text-text hover:text-primary"
                  >
                    {run.runId}
                  </Link>
                </td>
                <td className="max-w-0 px-3 py-2">
                  <span className="block truncate" title={run.feature}>
                    {run.feature}
                  </span>
                  {/* Which project, when the list spans all of them. */}
                  {projectId === undefined ? (
                    <span className="text-label text-faint">{run.projectId}</span>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <StatusDot tone={runTone(run.status)} label={runLabel(run.status)} />
                  {run.degradations > 0 ? (
                    <span className={cx('ml-2 text-label text-warning')}>
                      {run.degradations} degraded
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Progress value={progress} className="flex-1" label={`${run.runId} progress`} />
                    <span className="tabular w-12 shrink-0 text-right text-label text-muted">
                      {run.completedTasks}/{run.taskCount}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 text-muted">{formatWhen(run.createdAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
