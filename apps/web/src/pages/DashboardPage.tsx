import { useProjectSelection } from '../app/project-context';
import { useRuns } from '../lib/queries';
import { Empty } from '../components/ui';
import { RunDetailPage } from './RunDetailPage';

/**
 * Dashboard — the run you are most likely to be looking at.
 *
 * The reference has Dashboard selected while showing a run in flight, which is
 * the honest default for a tool you open while something is happening. So this
 * resolves a run rather than being a page of its own: whatever is running, or
 * failing its way toward a decision, or most recently started.
 *
 * It renders the same component `/runs/:runId` does. A second copy that drifted
 * would be two dashboards, and only one of them would be right.
 */
export function DashboardPage(): JSX.Element {
  const { projectId } = useProjectSelection();
  const runs = useRuns(projectId);

  if (runs.data === undefined) {
    return <Empty title={runs.isLoading ? 'Loading…' : 'Nothing to show.'} />;
  }

  const focus = pickRun(runs.data);

  if (focus === undefined) {
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

  return <RunDetailPage runId={focus} />;
}

/**
 * Attention first, recency second.
 *
 * A run that is executing, or one stopped at a gate waiting for a person, is
 * more interesting than a newer one that finished. Sorting purely by date would
 * hide the run that actually needs somebody behind one that does not.
 */
export function pickRun(runs: readonly { runId: string; status: string; createdAt: string }[]):
  | string
  | undefined {
  const rank = (status: string): number => {
    switch (status) {
      case 'running':
        return 0;
      case 'waiting_for_approval':
        return 1;
      case 'approved':
        return 2;
      case 'plan_rejected':
      case 'failed':
        return 3;
      default:
        return 4;
    }
  };

  return [...runs].sort(
    (a, b) => rank(a.status) - rank(b.status) || b.createdAt.localeCompare(a.createdAt),
  )[0]?.runId;
}
