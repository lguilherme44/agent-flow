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
 * The frame (§66, §68, §69; M8.5 §7, §8).
 *
 * Sidebar 216px, command bar 44px, gutter 18px — all tokens, so the layout and the
 * design system cannot drift apart.
 *
 * **What M8.5 removed, and why each removal is information nobody lost.** The sidebar
 * carried `OPERATIONAL` and `SYSTEM` over seven destinations: two headings naming
 * categories nobody navigates by, costing two rows and two rules the eye has to skip
 * on a list short enough to read whole. A hairline separates the three operational
 * destinations from the four reference ones and says the same thing without a word.
 * The footer carried a terminal avatar, `Agent Flow v0.1.0` and `Local mode` beside a
 * live dot — and the command bar carried a second `L` avatar whose tooltip also read
 * "Local mode". Two badges for one fact, on one screen. The version moved into the
 * wordmark's `title`, and what is left in the footer is the one thing that changes:
 * whether a runner is down.
 *
 * The sidebar carries the whole product's navigation, and `pending` stays on
 * `NavEntry` because the honesty it buys is worth keeping: a destination with no page
 * belongs in this list, visibly disabled, rather than absent — a person cannot tell
 * whether something missing is missing or merely elsewhere.
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
 * Its own component because the state has to sit above both the sidebar and the command
 * bar, and `Shell` is where the providers are — a `useState` there would re-render every
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

  // The run workspace draws its own header, tab strip and gutters, and every one of them
  // is full-bleed: a gutter here would stop each hairline 18px short of both edges, which
  // reads as a misaligned box rather than as a division of the page.
  const flush = /^\/(?:runs\/[^/]|dashboard)/.test(pathname);

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
        <div className={cx('page-body', flush && 'page-body--flush')}>
          <UnknownProject />
          <Outlet />
        </div>
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
      className="m-3 shrink-0"
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

/**
 * Three operational destinations, then four reference ones.
 *
 * The split survives; the two headings that used to announce it do not. A hairline
 * between the groups carries the same division at no vertical cost, on a list of seven
 * that a person reads whole rather than scans by category.
 */
const OPERATIONAL_COUNT = 3;

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
        <div className="brand" title="Agent Flow v0.1.0 — local mode, no authentication">
          <div className="brand-logo">AF</div>
          <span className="brand-name">
            Agent<span className="text-primary-bright">Flow</span>
          </span>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="Primary">
        {navEntries.slice(0, OPERATIONAL_COUNT).map((entry) => (
          <SidebarLink key={entry.to} entry={entry} />
        ))}

        <hr className="my-2 border-t border-border" />

        {navEntries.slice(OPERATIONAL_COUNT).map((entry) => (
          <SidebarLink key={entry.to} entry={entry} />
        ))}

        <span className="nav-label">{t.nav.projects}</span>
        {projects.data === undefined || projects.data.length === 0 ? (
          <p className="px-2 text-micro text-muted">
            {projects.isLoading
              ? 'Loading…'
              : projects.isError
                ? 'The registry could not be read.'
                : 'No Agent Flow project found.'}
          </p>
        ) : (
          projects.data.map((project) => {
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
                  <span className="truncate text-micro text-faint">{runText}</span>
                </span>
              </button>
            );
          })
        )}

        <button type="button" disabled className="nav-item mt-1 cursor-not-allowed opacity-50">
          <Plus className="h-4 w-4" aria-hidden />
          Add project
        </button>
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
        className="nav-item cursor-not-allowed opacity-55"
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        {entry.label}
      </span>
    );
  }

  return (
    <NavLink to={entry.to} end className={({ isActive }) => cx('nav-item', isActive && 'active')}>
      {({ isActive }) => (
        <>
          <Icon aria-hidden />
          {entry.label}
          {isActive ? (
            <span className="absolute inset-y-1 left-0 w-0.5 rounded-r bg-primary-bright" aria-hidden />
          ) : null}
        </>
      )}
    </NavLink>
  );
}

/**
 * The one fact down here that changes, and the language switch.
 *
 * The version block that used to sit above this said `Agent Flow v0.1.0` and
 * `Local mode` — neither of which ever changes, both of which the command bar was
 * also reporting. A footer of constants is a footer people stop looking at, and then
 * the runner warning underneath it goes with them.
 */
function SidebarFooter(): JSX.Element {
  const { projectId } = useProjectSelection();
  const health = useRunnerHealth(projectId);

  const runners = health.data ?? [];
  const down = runners.filter(
    (runner) => !runner.installed || !runner.executable || runner.auth === 'not_configured',
  );

  return (
    <div className="sidebar-footer">
      {down.length > 0 ? (
        <NavLink
          to="/agents"
          className="flex min-w-0 items-center gap-1.5 rounded-sm text-micro text-warning hover:underline"
        >
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{`${down.length} runner${down.length === 1 ? '' : 's'} unavailable`}</span>
        </NavLink>
      ) : (
        <span className="text-micro text-faint">Local</span>
      )}
      <LanguageSelector />
    </div>
  );
}

/**
 * A context bar, not a page title (§69).
 *
 * Where you are, whether the stream is up, and the docs. The `L` avatar that used to
 * end this row said "Local mode" in a tooltip, which the sidebar footer already says in
 * words — and an avatar in a single-user local tool is a seat for an identity that does
 * not exist.
 */
function Topbar(props: { drawerOpen: boolean; onToggleDrawer: () => void }): JSX.Element {
  const { selectedTaskId } = useGlobalTaskSelection();
  const { projectId } = useProjectSelection();
  const connection = useLiveEvents(projectId);

  return (
    <header className="command-bar">
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
          className="btn btn-outline btn-sm"
        >
          <BookOpen className="h-3.5 w-3.5" aria-hidden />
          Docs
        </a>
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
            ? 'bg-success'
            : connection === 'polling'
              ? 'bg-warning'
              : 'bg-faint',
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
