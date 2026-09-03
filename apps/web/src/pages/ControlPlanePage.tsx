import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import type { AttentionPriority, WorkspaceProjectView } from '@contracts/index.js';
import { useControl, useWorkspace } from '../lib/queries';
import { useProjectSelection } from '../app/project-context';
import { AttentionQueue } from '../features/attention';
import { Badge, Empty, Notice, Panel, Progress, SectionHeader, cx } from '../components/ui';
import { formatWhenCompact } from '../lib/format';
import { runtimeLabel, runtimeTone } from '../lib/status';
import type { RuntimeStatus } from '@contracts/index.js';

/**
 * The control plane home (M8 §11, §13, §37).
 *
 * The screen that has to answer four questions in a few seconds:
 *
 *   What needs me?
 *   What is running?
 *   What is blocked?
 *   What is delivered?
 *
 * In that order, which is the whole change. `/dashboard` opens the run most likely to want
 * you and is still there and still right for one project; it answers "what is happening"
 * for one repository and hides it for the other nine. A landing page that is a static list
 * of projects answers none of the four.
 *
 * **Attention comes first and comes whole.** The queue spans every project with an active
 * run, in the projection's order, so a P0 on a repository nobody has opened today is at the
 * top rather than three clicks in.
 */
export function ControlPlanePage(): JSX.Element {
  const workspace = useWorkspace();
  const { projectId } = useProjectSelection();

  // The attention items themselves come from the selected project's snapshot. The workspace
  // row carries only a *count* and a top priority, deliberately: computing the items for
  // fifty projects means four file reads each, and the question this page answers first is
  // "which of these wants me", which a count answers.
  const active = workspace.data?.projects.find(
    (project) => project.projectId === (projectId ?? mostUrgent(workspace.data.projects)?.projectId),
  );
  const control = useControl(active?.projectId, active?.runId);

  if (workspace.isError) {
    return (
      <div className="p-4">
        <Notice
          tone="danger"
          title="The workspace could not be read"
          detail="The server answered and reading the projects failed."
          consequence="Nothing here is stale — it is absent, which is a different thing."
        />
      </div>
    );
  }

  const projects = workspace.data?.projects ?? [];
  const withRuns = projects.filter((project) => project.runId !== undefined);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
      <AttentionQueue
        items={control.data?.attention ?? []}
        unread={active?.runId !== undefined && control.data === undefined && !control.isLoading}
        {...(active?.projectId === undefined ? {} : { projectId: active.projectId })}
        showRun={withRuns.length > 1}
        title={
          active === undefined
            ? 'Needs attention'
            : `Needs attention — ${active.name}`
        }
        className="max-h-[46vh] shrink-0"
      />

      <Panel
        divided
        header={
          <SectionHeader title="Projects">
            <span className="text-label text-muted">
              <span className="tabular">{withRuns.length}</span> with an active run ·{' '}
              <span className="tabular">{projects.length}</span> registered
            </span>
          </SectionHeader>
        }
      >
        {projects.length === 0 ? (
          <Empty
            title="No projects"
            hint="A project is a directory with .agent-flow/config.yaml."
          />
        ) : (
          <ul className="min-h-0 overflow-auto">
            {projects.map((project) => (
              <ProjectRow key={project.projectId} project={project} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

/**
 * One project, at the density fifty of them can afford.
 *
 * Everything on this row is a fact the server projected. The row does not decide whether a
 * project is healthy — it says what is true and lets the reader decide, which is why there
 * is no green tick anywhere on this page.
 */
function ProjectRow(props: { project: WorkspaceProjectView }): JSX.Element {
  const { project } = props;
  const idle = project.runId === undefined;

  return (
    <li className="border-b border-border last:border-b-0">
      <Link
        to={
          idle
            ? `/runs?project=${encodeURIComponent(project.projectId)}`
            : `/runs/${encodeURIComponent(project.runId as string)}?view=board&project=${encodeURIComponent(project.projectId)}`
        }
        className={cx(
          'grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-2.5',
          'sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto]',
          'hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none',
          'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary',
        )}
      >
        <span className="min-w-0">
          <span className="block truncate text-body-lg font-medium text-text">{project.name}</span>
          <span className="block truncate text-label text-muted">
            {project.feature ?? 'no active run'}
          </span>
        </span>

        <span className="min-w-0 max-sm:hidden">
          {idle ? (
            <span className="text-label text-faint">
              {project.lastActivityAt === undefined
                ? 'never run'
                : `last activity ${formatWhenCompact(project.lastActivityAt)}`}
            </span>
          ) : (
            <>
              {/* Absent rather than guessed. A row whose runtime could not be read is a row
                  missing one fact, and it must not take the page down with it — the first
                  version of this called `runtimeLabel(undefined)` and a single project with
                  an unreadable run blanked the whole control plane. */}
              {project.runtime === undefined ? null : (
                <Badge tone={runtimeTone(project.runtime as RuntimeStatus)} caps>
                  {runtimeLabel(project.runtime as RuntimeStatus)}
                </Badge>
              )}
              <span className="mt-1 flex items-center gap-2">
                {/* Sized by this wrapper rather than by a class on `Progress`: the
                    component writes `w-full` on its own container, and a width passed
                    through `className` lands in the same layer and loses. */}
                <span className="w-24 shrink-0">
                  <Progress value={project.progress} />
                </span>
                <span className="tabular text-micro text-faint">{project.progress}%</span>
              </span>
            </>
          )}
        </span>

        <span className="flex items-center gap-1.5 justify-self-end">
          {project.blockedCount === 0 ? null : (
            <Badge tone="danger" className="tabular">
              {project.blockedCount} blocked
            </Badge>
          )}
          {project.delivery === undefined ? null : (
            <Badge tone="muted" caps>
              {project.delivery.replace(/_/g, ' ')}
            </Badge>
          )}
          {project.teamLoad === undefined ? null : (
            <Badge tone="muted" className="tabular">
              {project.teamLoad.running}/{project.teamLoad.capacity}
            </Badge>
          )}
        </span>

        <span className="justify-self-end">
          {project.attentionCount === 0 ? (
            <span className="text-micro text-faint">—</span>
          ) : (
            <Badge tone={project.topPriority === undefined ? 'muted' : PRIORITY_TONE[project.topPriority]} className="tabular">
              {project.attentionCount} · {project.topPriority}
            </Badge>
          )}
        </span>
      </Link>
    </li>
  );
}

const PRIORITY_TONE: Record<AttentionPriority, 'danger' | 'warning' | 'info' | 'muted'> = {
  P0: 'danger',
  P1: 'warning',
  P2: 'danger',
  P3: 'info',
  P4: 'muted',
};

/**
 * Which project the queue opens on when nothing is selected.
 *
 * The most urgent one, not the first alphabetically. A control plane whose default view is
 * "whichever project sorts first" makes the operator do the ranking the projection already
 * did.
 */
function mostUrgent(
  projects: readonly WorkspaceProjectView[],
): WorkspaceProjectView | undefined {
  const withAttention = projects.filter((project) => project.attentionCount > 0);
  if (withAttention.length === 0) {
    return projects.find((project) => project.runId !== undefined);
  }

  return [...withAttention].sort((a, b) => {
    const byPriority = (a.topPriority ?? 'P4').localeCompare(b.topPriority ?? 'P4');
    if (byPriority !== 0) return byPriority;
    return b.attentionCount - a.attentionCount;
  })[0];
}
