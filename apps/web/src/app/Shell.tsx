import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  BookOpen,
  BarChart3,
  Cpu,
  FileText,
  FolderGit2,
  LayoutDashboard,
  Menu,
  Plus,
  Settings,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { ProjectProvider, useProjectSelection } from './project-context';
import { TaskSelectionProvider, useGlobalTaskSelection } from './task-selection-context';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { I18nProvider, useI18n } from '../lib/i18n/i18n-context';
import { LanguageSelector } from '../components/LanguageSelector';
import { useLiveEvents, type ConnectionState } from '../hooks/use-live-events';
import { useProjects, useRunnerHealth } from '../lib/queries';
import { Button, Notice, cx } from '../components/ui';
import { runLabel, runTone, TONE_DOT } from '../lib/status';

/**
 * The frame (§66, §68, §69).
 *
 * Sidebar 216px, topbar 56px, page padding 18px — all tokens, so the layout and
 * the design system cannot drift apart.
 *
 * The sidebar carries the whole product's navigation, and as of UI-26 every one of
 * §68's seven destinations has a page behind it. `pending` stays on `NavEntry`
 * because the honesty it buys is worth keeping: a destination with no page belongs
 * in this list, visibly disabled, rather than absent — a person cannot tell whether
 * something missing is missing or merely elsewhere.
 */
export function Shell(): JSX.Element {
  return (
    <I18nProvider>
      <ProjectProvider>
        <TaskSelectionProvider>
          <ShellLayout />
        </TaskSelectionProvider>
      </ProjectProvider>
    </I18nProvider>
  );
}

/**
 * The layout, and the one piece of state it owns: whether the drawer is open.
 *
 * Its own component because the state has to sit above both the sidebar and the topbar,
 * and `Shell` is where the providers are — a `useState` there would re-render every
 * provider on a menu toggle.
 *
 * **The drawer only exists below 1024** (see `ops-control.css`). Above it the sidebar is a
 * column, the toggle and the backdrop are `display: none`, and this state is inert. That
 * is deliberate: one layout with a boundary, rather than two layouts to keep in step.
 */
function ShellLayout(): JSX.Element {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { pathname } = useLocation();

  // Navigating is the point of the drawer, so navigating closes it. Without this the menu
  // stays over the page you just asked for, and the first thing a person does on arriving
  // is dismiss it.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Escape closes it, like every other dismissible surface in this app.
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [drawerOpen]);

  return (
    <div className="app-layout">
      <Sidebar open={drawerOpen} />
      {drawerOpen ? (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close the navigation"
          onClick={() => {
            setDrawerOpen(false);
          }}
        />
      ) : null}
      <main className="main-content">
        <Topbar
          drawerOpen={drawerOpen}
          onToggleDrawer={() => {
            setDrawerOpen((open) => !open);
          }}
        />
        <UnknownProject />
        <Outlet />
      </main>
    </div>
  );
}

/**
 * A project id in the URL that this server did not issue (§95).
 *
 * Every page under it would independently render "could not be read", once per
 * query, which describes a server problem rather than the actual one: the id is
 * fine, it just does not belong to this workspace. Said once, here, where the
 * selection lives — and only after the registry has arrived, so a slow first load
 * does not accuse a perfectly good link.
 */
function UnknownProject(): JSX.Element | null {
  const { projectId, select } = useProjectSelection();
  const projects = useProjects();

  if (projectId === undefined || projects.data === undefined) return null;
  if (projects.data.some((project) => project.id === projectId)) return null;

  return (
    <Notice
      className="shrink-0"
      tone="warning"
      title={`This server has no project called ${projectId}.`}
      consequence="Nothing is wrong with the workflow — the id in the address is not one this workspace knows."
      action={
        <Button
          size="sm"
          onClick={() => {
            select(undefined);
          }}
        >
          Show the whole workspace
        </Button>
      }
    />
  );
}

interface NavEntry {
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Absent page. Rendered, disabled, and honest about it. */
  readonly pending?: boolean;
}

function useNavEntries(): readonly NavEntry[] {
  const { t } = useI18n();
  return [
    { to: '/dashboard', label: t.nav.dashboard, icon: LayoutDashboard },
    { to: '/runs', label: t.nav.runs, icon: Activity },
    { to: '/projects', label: t.nav.projects, icon: FolderGit2 },
    { to: '/agents', label: t.nav.agents, icon: Cpu },
    { to: '/prompts', label: t.nav.prompts, icon: FileText },
    { to: '/analytics', label: t.nav.analytics, icon: BarChart3 },
    { to: '/settings', label: t.nav.settings, icon: Settings },
  ];
}

function Sidebar(props: { open: boolean }): JSX.Element {
  const { t } = useI18n();
  const navEntries = useNavEntries();
  const projects = useProjects();
  const { projectId, select } = useProjectSelection();

  return (
    // `data-open` rather than a class, so the CSS boundary owns the behaviour and this
    // component owns nothing about widths. Above 1024 the attribute is present and inert.
    <aside className="sidebar" data-open={props.open ? 'true' : 'false'}>
      <div className="sidebar-header">
        <div className="brand">
          <div className="brand-logo">AF</div>
          <div className="brand-info">
            <span className="brand-name">Agent<span className="text-primary-bright">Flow</span></span>
            <span className="brand-env">
              <span className="status-indicator live"></span>Local
            </span>
          </div>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="Primary">
        <div className="nav-group">
          <span className="nav-label">Operational</span>
          {navEntries.slice(0, 3).map((entry) => (
            <SidebarLink key={entry.to} entry={entry} />
          ))}
        </div>
        <div className="nav-group">
          <span className="nav-label">System</span>
          {navEntries.slice(3).map((entry) => (
            <SidebarLink key={entry.to} entry={entry} />
          ))}
        </div>

        <div className="nav-group">
          <span className="nav-label">{t.nav.projects}</span>
          {projects.data === undefined || projects.data.length === 0 ? (
            <p className="px-2 text-xs text-muted">
              {projects.isLoading
                ? 'Loading…'
                : projects.isError
                  ? 'The registry could not be read.'
                  : 'No Agent Flow project found.'}
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {projects.data.map((project) => {
                const active = project.id === projectId;
                const tone = project.status === null ? 'muted' : runTone(project.status);
                // §65: a name and a run per row. A column of names and coloured
                // dots answers "which of these needs me" only by hovering each
                // one in turn.
                const runText =
                  project.currentRunId === null || project.status === null
                    ? 'idle'
                    : `${project.currentRunId} ${runLabel(project.status).toLowerCase()}`;

                return (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => select(active ? undefined : project.id)}
                    className={cx('nav-item', active && 'active')}
                  >
                    <span
                      className={cx('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[tone])}
                      aria-hidden
                    />
                    <span className="flex min-w-0 flex-col items-start">
                      <span className="truncate">{project.name}</span>
                      <span className="truncate text-xs text-muted">{runText}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          
          <button
            type="button"
            disabled
            className="nav-item opacity-50 cursor-not-allowed mt-2"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add Project
          </button>
        </div>
      </nav>

      <SidebarFooter />
    </aside>
  );
}

function SidebarLink(props: { entry: NavEntry }): JSX.Element {
  const { entry } = props;
  const Icon = entry.icon;

  if (entry.pending === true) {
    return (
      <span
        title={`${entry.label} is not implemented yet`}
        aria-disabled="true"
        className="nav-item opacity-55 cursor-not-allowed"
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        {entry.label}
      </span>
    );
  }

  return (
    <NavLink
      to={entry.to}
      end
      className={({ isActive }) =>
        cx('nav-item', isActive && 'active')
      }
    >
      {({ isActive }) => (
        <>
          <Icon aria-hidden />
          {entry.label}
          {isActive && <span className="absolute inset-y-1 left-0 w-0.5 rounded-r bg-color-running" aria-hidden />}
        </>
      )}
    </NavLink>
  );
}

function SidebarFooter(): JSX.Element {
  const { projectId } = useProjectSelection();
  const health = useRunnerHealth(projectId);

  const runners = health.data ?? [];
  const down = runners.filter(
    (runner) => !runner.installed || !runner.executable || runner.auth === 'not_configured',
  );

  return (
    <div className="sidebar-footer">
      <div className="user-profile">
        <div className="avatar">
          <Terminal className="h-4 w-4" aria-hidden />
        </div>
        <div className="user-details">
          <span className="user-name">Agent Flow v0.1.0</span>
          <span className="user-role flex items-center gap-1">
            Local mode
            <span
              className={cx(
                'status-indicator',
                runners.length === 0
                  ? 'bg-neutral'
                  : down.length === 0
                    ? 'live'
                    : 'offline',
              )}
              aria-hidden
            />
          </span>
        </div>
      </div>
      
      {down.length > 0 && (
        <NavLink
          to="/agents"
          className="mt-2 flex items-center gap-1.5 rounded-sm text-xs text-color-warning hover:underline"
        >
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{`${down.length} runner${down.length === 1 ? '' : 's'} unavailable`}</span>
        </NavLink>
      )}

      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-muted">Language</span>
        <LanguageSelector />
      </div>
    </div>
  );
}

/**
 * A context bar, not a page title (§69).
 */
function Topbar(props: { drawerOpen: boolean; onToggleDrawer: () => void }): JSX.Element {
  const { projectId } = useProjectSelection();
  const { selectedTaskId } = useGlobalTaskSelection();
  const connection = useLiveEvents(projectId);

  return (
    <header className="command-bar glass-panel">
      {/* The only way to the navigation below 1024, so it is a real button with a real
          accessible name — not an icon a screen reader reads as "button". */}
      <button
        type="button"
        className="sidebar-toggle flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-border bg-surface-2 text-muted hover:text-text"
        aria-label={props.drawerOpen ? 'Close the navigation' : 'Open the navigation'}
        aria-expanded={props.drawerOpen}
        onClick={props.onToggleDrawer}
      >
        <Menu className="h-4 w-4" aria-hidden />
      </button>

      <div className="run-context">
        <Breadcrumbs selectedTaskId={selectedTaskId} />
      </div>

      <div className="command-actions">
        <LiveIndicator connection={connection} />

        <a
          href="https://github.com/lguilherme44/agent-flow#readme"
          target="_blank"
          rel="noreferrer"
          className="btn btn-outline btn-sm flex items-center gap-1.5"
        >
          <BookOpen className="h-3.5 w-3.5" aria-hidden />
          Docs
        </a>

        <span
          className="flex h-7 w-7 items-center justify-center rounded-full border border-border-strong bg-surface-2 text-xs font-semibold text-text"
          title="Local mode — this server has no authentication"
        >
          L
        </span>
      </div>
    </header>
  );
}

function LiveIndicator(props: { connection: ConnectionState }): JSX.Element {
  const { t } = useI18n();
  const { connection } = props;

  return (
    <span
      className={cx(
        'badge',
        connection === 'live'
          ? 'badge-success'
          : connection === 'polling'
            ? 'badge-blocked'
            : 'badge-neutral',
      )}
    >
      <span
        className={cx(
          'pulse-dot',
          connection === 'live'
            ? 'bg-color-success'
            : connection === 'polling'
              ? 'bg-color-warning'
              : 'bg-text-secondary',
        )}
        aria-hidden
      />
      {connection === 'live'
        ? t.nav.connected
        : connection === 'polling'
          ? t.nav.connecting
          : t.nav.disconnected}
    </span>
  );
}
