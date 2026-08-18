import { NavLink, Outlet } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  BookOpen,
  BarChart3,
  Cpu,
  FileText,
  FolderGit2,
  LayoutDashboard,
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
          <div className="flex h-full min-h-0 bg-bg">
            <Sidebar />
            <div className="flex min-w-0 flex-1 flex-col">
              <Topbar />
              <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-page">
                <UnknownProject />
                <div className="min-h-0 flex-1">
                  <Outlet />
                </div>
              </main>
            </div>
          </div>
        </TaskSelectionProvider>
      </ProjectProvider>
    </I18nProvider>
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

function Sidebar(): JSX.Element {
  const { t } = useI18n();
  const navEntries = useNavEntries();
  const projects = useProjects();
  const { projectId, select } = useProjectSelection();

  return (
    <aside className="glass flex w-sidebar shrink-0 flex-col border-r border-glass-border shadow-lg">
      <div className="flex h-topbar shrink-0 items-center gap-2.5 px-4">
        <span
          className="relative flex h-7 w-7 items-center justify-center rounded-lg bg-primary shadow-glow-primary"
          aria-hidden
        >
          <span className="h-2 w-2 rounded-full bg-white" />
          <span className="absolute inset-0 rounded-lg bg-primary-bright opacity-20 glow-pulse" />
        </span>
        <span className="text-body-lg font-bold tracking-caps text-text">
          Agent<span className="text-primary-bright">Flow</span>
        </span>
      </div>

      <nav className="flex flex-col gap-px px-2 py-1" aria-label="Primary">
        {navEntries.slice(0, 3).map((entry) => (
          <SidebarLink key={entry.to} entry={entry} />
        ))}
      </nav>

      <div className="mx-3 my-1 border-t border-glass-border" />

      <nav className="flex flex-col gap-px px-2 py-1" aria-label="Secondary">
        {navEntries.slice(3).map((entry) => (
          <SidebarLink key={entry.to} entry={entry} />
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <h2 className="px-2 pb-1 pt-3 text-micro uppercase tracking-caps text-faint">
          {t.nav.projects}
        </h2>

        {projects.data === undefined || projects.data.length === 0 ? (
          <p className="px-2 text-micro text-faint">
            {projects.isLoading
              ? 'Loading…'
              : projects.isError
                ? 'The registry could not be read.'
                : 'No Agent Flow project found.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-px">
            {projects.data.map((project) => {
              const active = project.id === projectId;
              // Not a decoration: the dot is the only place the sidebar says
              // whether a project is doing anything right now.
              const tone = project.status === null ? 'muted' : runTone(project.status);

              return (
                <li key={project.id}>
                  <button
                    type="button"
                    onClick={() => {
                      select(active ? undefined : project.id);
                    }}
                    aria-current={active ? 'true' : undefined}
                    className={cx(
                      'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                      active
                        ? 'bg-primary-soft text-text'
                        : 'text-muted hover:bg-surface-2/50 hover:text-text',
                    )}
                  >
                    <span
                      className={cx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[tone])}
                      aria-hidden
                    />
                    {/* Two lines, as §65 draws it: the project, and what it is
                        doing. A workspace of six repositories where every row is
                        a name and a coloured dot answers "which of these needs
                        me" only by hovering each one in turn. */}
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-body-lg">{project.name}</span>
                      <span className="truncate text-micro text-faint">
                        {project.currentRunId === null || project.status === null
                          ? 'idle'
                          : `${project.currentRunId} ${runLabel(project.status).toLowerCase()}`}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Present because §68 lists it, disabled because adding a project means
            writing to the registry and this milestone writes nothing. */}
        <button
          type="button"
          disabled
          title="Adding a project is not available in the read-only dashboard"
          className="mt-1 flex w-full cursor-not-allowed items-center gap-2 rounded-sm px-2 py-1.5 text-label text-faint opacity-60"
        >
          <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Add Project
        </button>
      </div>

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
        className="flex cursor-not-allowed items-center gap-2 rounded-sm px-2 py-1.5 text-body-lg text-faint opacity-55"
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
        cx(
          'relative flex items-center gap-2 rounded-md px-2.5 py-1.5 text-body-lg transition-colors',
          isActive
            ? 'bg-primary-soft font-medium text-text'
            : 'text-muted hover:bg-surface-2/50 hover:text-text',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive ? (
            <span
              className="absolute inset-y-1 left-0 w-0.5 rounded-r bg-primary-bright"
              aria-hidden
            />
          ) : null}
          <Icon className="h-4 w-4 shrink-0" aria-hidden />
          {entry.label}
        </>
      )}
    </NavLink>
  );
}

/**
 * Version, mode, and runner health.
 *
 * Runner health is the shallow check — the same one `doctor` runs for free. A
 * dashboard that probed for real on every poll would spend quota nobody asked it
 * to, which is exactly why `doctor --deep` is a separate, explicit act.
 */
function SidebarFooter(): JSX.Element {
  const { projectId } = useProjectSelection();
  const health = useRunnerHealth(projectId);

  const runners = health.data ?? [];
  const down = runners.filter(
    (runner) => !runner.installed || !runner.executable || runner.auth === 'not_configured',
  );

  /**
   * What is wrong, in words, and never what it would do about it.
   *
   * §94's example reads "Codex unavailable. Workflow can continue using Claude
   * fallback." — and that second sentence is a claim this indicator cannot make.
   * Whether a fallback exists depends on the *role*: it is configured per role,
   * it must satisfy that role's requirements, and it may be disabled outright.
   * Agents & Models resolves all of that and reports three distinct reasons a
   * role can have no fallback. Saying "Claude will take over" from here would be
   * a guess, and the times it was wrong would be exactly the times somebody was
   * relying on it.
   */
  const summary =
    runners.length === 0
      ? 'Runner health unknown'
      : down.length === 0
        ? 'All runners ready'
        : `${String(down.length)} runner${down.length === 1 ? '' : 's'} unavailable`;

  return (
    <div className="shrink-0 p-2">
      <div className="flex flex-col gap-1.5 rounded-lg border border-glass-border bg-surface-2/40 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-micro text-muted">Agent Flow v0.1.0</span>
            <span className="flex items-center gap-1.5 text-micro text-faint">
              Local mode
              <span
                className={cx(
                  'h-1.5 w-1.5 rounded-full',
                  runners.length === 0
                    ? 'bg-faint'
                    : down.length === 0
                      ? 'bg-success'
                      : 'bg-warning',
                )}
                aria-hidden
              />
            </span>
          </div>
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-border text-faint"
            title={
              runners.length === 0
                ? summary
                : runners.map((runner) => `${runner.id}: ${runner.auth}`).join('\n')
            }
          >
            <Terminal className="h-3 w-3" aria-hidden />
          </span>
        </div>

        {/* Visible, not only in a tooltip. A coloured dot is not a status (§97),
            and a person who has to hover to learn that a runner is down will
            learn it from a failed run instead. */}
        {down.length === 0 ? (
          <span className="sr-only">{summary}</span>
        ) : (
          <NavLink
            to="/agents"
            className="flex items-center gap-1.5 rounded-sm text-micro text-warning hover:underline"
          >
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">{summary}</span>
          </NavLink>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-glass-border px-3 py-2">
        <span className="text-micro text-faint">Language</span>
        <LanguageSelector />
      </div>
    </div>
  );
}

/**
 * A context bar, not a page title (§69).
 */
function Topbar(): JSX.Element {
  const { projectId } = useProjectSelection();
  const { selectedTaskId } = useGlobalTaskSelection();
  const connection = useLiveEvents(projectId);

  return (
    <header className="glass flex h-topbar shrink-0 items-center justify-between gap-4 border-b border-glass-border px-page">
      <Breadcrumbs selectedTaskId={selectedTaskId} />

      <div className="flex shrink-0 items-center gap-2">
        <LiveIndicator connection={connection} />

        <a
          href="https://github.com/lguilherme44/agent-flow#readme"
          target="_blank"
          rel="noreferrer"
          className="flex h-7 items-center gap-1.5 rounded-md border border-glass-border bg-surface-2/60 px-2.5 text-label text-muted transition-colors hover:border-border hover:text-text"
        >
          <BookOpen className="h-3.5 w-3.5" aria-hidden />
          Docs
        </a>

        <span
          className="flex h-7 w-7 items-center justify-center rounded-full border border-primary-border bg-primary-soft text-micro font-semibold text-text"
          title="Local mode — this server has no authentication"
        >
          L
        </span>
      </div>
    </header>
  );
}

/**
 * Whether the stream is up.
 *
 * A stream that silently died and a run that is simply idle look identical on
 * screen, and only one of those is worth telling somebody about.
 */
function LiveIndicator(props: { connection: ConnectionState }): JSX.Element {
  const { t } = useI18n();
  const { connection } = props;

  return (
    <span
      className={cx(
        'flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-label transition-colors',
        connection === 'live'
          ? 'border-success/20 bg-success-soft text-success'
          : connection === 'polling'
            ? 'border-warning/20 bg-warning-soft text-warning'
            : 'border-glass-border bg-surface-2/60 text-faint',
      )}
    >
      <span
        className={cx(
          'h-1.5 w-1.5 rounded-full',
          connection === 'live'
            ? 'bg-success glow-pulse'
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
