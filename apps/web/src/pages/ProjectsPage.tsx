import { Link } from 'react-router-dom';
import { FolderGit2 } from 'lucide-react';
import { useProjectSelection } from '../app/project-context';
import { useProjects } from '../lib/queries';
import { Card, Empty, StatusDot, cx } from '../components/ui';
import { runLabel, runTone } from '../lib/status';

/** Projects (§81) — what this server found, and which one is selected. */
export function ProjectsPage(): JSX.Element {
  const projects = useProjects();
  const { projectId, select } = useProjectSelection();

  if (projects.data === undefined) {
    return <Empty title={projects.isLoading ? 'Looking for projects…' : 'Nothing to show.'} />;
  }

  if (projects.data.length === 0) {
    return (
      <Empty
        title="No Agent Flow project found."
        hint={
          <>
            Run <code className="font-mono">agent-flow init</code> in a repository, then
            restart the UI.
          </>
        }
      />
    );
  }

  return (
    <div className="grid grid-cols-3 gap-3 overflow-auto">
      {projects.data.map((project) => {
        const active = project.id === projectId;

        return (
          <Card
            key={project.id}
            className={cx(active && 'border-primary')}
            title={
              <span className="flex items-center gap-1.5">
                <FolderGit2 className="h-3.5 w-3.5" aria-hidden />
                {project.name}
              </span>
            }
          >
            <div className="flex h-full flex-col gap-2 p-3">
              <p className="truncate font-mono text-label text-faint" title={project.path}>
                {project.path}
              </p>

              <div className="flex items-center gap-2">
                {project.status === null ? (
                  <span className="text-label text-muted">idle</span>
                ) : (
                  <StatusDot tone={runTone(project.status)} label={runLabel(project.status)} />
                )}
                {project.stack === undefined ? null : (
                  <span className="text-label text-faint">{project.stack}</span>
                )}
              </div>

              <div className="mt-auto flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    select(active ? undefined : project.id);
                  }}
                  className="rounded-sm border border-border bg-surface-2 px-2 py-1 text-label hover:bg-surface-3"
                >
                  {active ? 'Clear selection' : 'Select'}
                </button>

                {project.currentRunId === null ? null : (
                  <Link
                    to={`/runs/${project.currentRunId}`}
                    onClick={() => {
                      select(project.id);
                    }}
                    className="rounded-sm bg-primary px-2 py-1 text-label text-white hover:brightness-110"
                  >
                    Open {project.currentRunId}
                  </Link>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
