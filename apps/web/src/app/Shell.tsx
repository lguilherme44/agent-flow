import { NavLink, Outlet } from 'react-router-dom';
import { Activity, FolderGit2, Layers, Radio, WifiOff } from 'lucide-react';
import { ProjectProvider, useProjectSelection } from './project-context';
import { useLiveEvents } from '../hooks/use-live-events';
import { useProjects, useRunnerHealth } from '../lib/queries';
import { StatusDot, cx } from '../components/ui';
import { runTone, runLabel } from '../lib/status';

/**
 * The frame (§66, §68, §69).
 *
 * Sidebar 216px, topbar 56px, page padding 18px — the numbers are tokens, not
 * literals, so the layout and the design system cannot drift apart.
 */
export function Shell(): JSX.Element {
  return (
    <ProjectProvider>
      <div className="flex h-full min-h-0 bg-bg">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          <main className="min-h-0 flex-1 overflow-hidden p-page">
            <Outlet />
          </main>
        </div>
      </div>
    </ProjectProvider>
  );
}

function Sidebar(): JSX.Element {
  const projects = useProjects();
  const { projectId, select } = useProjectSelection();

  return (
    <aside className="flex w-sidebar shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex h-topbar shrink-0 items-center gap-2 border-b border-border px-3">
        <Layers className="h-4 w-4 text-primary" aria-hidden />
        <span className="text-body-lg font-semibold">Agent Flow</span>
      </div>

      <nav className="flex flex-col gap-0.5 p-2" aria-label="Sections">
        <SidebarLink to="/runs" icon={<Activity className="h-4 w-4" aria-hidden />}>
          Runs
        </SidebarLink>
        <SidebarLink to="/projects" icon={<FolderGit2 className="h-4 w-4" aria-hidden />}>
          Projects
        </SidebarLink>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <h2 className="px-2 py-2 text-label uppercase tracking-wide text-faint">Projects</h2>

        {projects.data === undefined || projects.data.length === 0 ? (
          <p className="px-2 text-label text-faint">
            {projects.isLoading ? 'Loading…' : 'None found.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {projects.data.map((project) => {
              const active = project.id === projectId;
              return (
                <li key={project.id}>
                  <button
                    type="button"
                    onClick={() => {
                      select(active ? undefined : project.id);
                    }}
                    aria-current={active ? 'true' : undefined}
                    className={cx(
                      'flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left',
                      active ? 'bg-primary-soft text-text' : 'text-muted hover:bg-surface-2',
                    )}
                  >
                    <span className="w-full truncate text-body">{project.name}</span>
                    <span className="text-label text-faint">
                      {project.status === null ? 'idle' : runLabel(project.status).toLowerCase()}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <RunnerStrip />
    </aside>
  );
}

function SidebarLink(props: {
  to: string;
  icon: JSX.Element;
  children: string;
}): JSX.Element {
  return (
    <NavLink
      to={props.to}
      className={({ isActive }) =>
        cx(
          'flex items-center gap-2 rounded-sm px-2 py-1.5 text-body',
          isActive ? 'bg-surface-3 text-text' : 'text-muted hover:bg-surface-2 hover:text-text',
        )
      }
    >
      {props.icon}
      {props.children}
    </NavLink>
  );
}

/**
 * Runner health at the bottom of the sidebar.
 *
 * The shallow check only — the same one `doctor` runs for free. A dashboard that
 * probed for real on every poll would spend quota nobody asked it to spend, and
 * `doctor --deep` exists precisely so that decision stays explicit.
 */
function RunnerStrip(): JSX.Element {
  const { projectId } = useProjectSelection();
  const health = useRunnerHealth(projectId);

  if (health.data === undefined || health.data.length === 0) return <div />;

  return (
    <div className="shrink-0 border-t border-border p-2">
      <h2 className="px-2 pb-1 text-label uppercase tracking-wide text-faint">Runners</h2>
      <ul className="flex flex-col gap-1 px-2 pb-1">
        {health.data.map((runner) => {
          const usable = runner.installed && runner.executable && runner.auth !== 'not_configured';
          return (
            <li key={runner.id} className="flex items-center justify-between gap-2">
              <span className="truncate text-label text-muted">{runner.id}</span>
              <StatusDot
                tone={usable ? 'success' : 'danger'}
                label={usable ? 'ready' : 'unavailable'}
                showLabel={false}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Topbar(): JSX.Element {
  const { projectId } = useProjectSelection();
  const connection = useLiveEvents(projectId);
  const projects = useProjects();

  const selected = projects.data?.find((project) => project.id === projectId);

  return (
    <header className="flex h-topbar shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-page">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-body-lg font-medium">
          {selected?.name ?? 'All projects'}
        </span>
        {selected?.status == null ? null : (
          <StatusDot tone={runTone(selected.status)} label={runLabel(selected.status)} />
        )}
      </div>

      {/* A stream that silently died and a run that is simply idle look the
          same on screen. One of those the user should know about. */}
      <div className="flex items-center gap-1.5 text-label text-muted">
        {connection === 'live' ? (
          <>
            <Radio className="h-3.5 w-3.5 text-success" aria-hidden />
            Live
          </>
        ) : connection === 'polling' ? (
          <>
            <WifiOff className="h-3.5 w-3.5 text-warning" aria-hidden />
            Reconnecting — polling every 10s
          </>
        ) : (
          <>
            <Radio className="h-3.5 w-3.5 text-faint" aria-hidden />
            Connecting…
          </>
        )}
      </div>
    </header>
  );
}
