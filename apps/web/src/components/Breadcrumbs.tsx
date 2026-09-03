import { Link, useLocation, useMatch } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useProjectSelection } from '../app/project-context';
import { useI18n } from '../lib/i18n/i18n-context';
import { useProjects, useRuns, useTasks } from '../lib/queries';
import { pickRun } from '../pages/DashboardPage';
import { cx } from './ui';

export interface BreadcrumbItem {
  readonly id: string;
  readonly label: string;
  readonly to?: string | undefined;
  readonly current?: boolean | undefined;
  readonly secondary?: string | undefined;
  /** If true, hidden on narrow viewports to avoid horizontal overflow */
  readonly collapseOnNarrow?: boolean | undefined;
}

export function Breadcrumbs(props: { selectedTaskId?: string | undefined }): JSX.Element {
  const { t } = useI18n();
  const { projectId } = useProjectSelection();
  const { pathname } = useLocation();
  const runMatch = useMatch('/runs/:runId');
  const promptMatch = useMatch('/prompts/:prompt');
  const matchedRunId = runMatch?.params.runId;
  const matchedPrompt = promptMatch?.params.prompt;

  const projects = useProjects();
  const runs = useRuns(projectId);

  const onRunRoute = matchedRunId !== undefined;
  // `/` is the control plane and `/dashboard` is one run. They stopped being the same page
  // in M8, and folding them together here put `workspace › beahub-api › Runs › AF-2026-104`
  // above a list of four projects — a trail describing somewhere the reader is not.
  const onDashboard = pathname === '/dashboard';
  const shownRunId = onRunRoute ? matchedRunId : onDashboard ? pickRun(runs.data ?? []) : undefined;

  const runProject = runs.data?.find((entry) => entry.runId === shownRunId)?.projectId;
  const effectiveProjectId = projectId ?? runProject;
  const projectObj = projects.data?.find((p) => p.id === effectiveProjectId);
  const projectName = projectObj?.name ?? (effectiveProjectId === undefined ? 'all projects' : effectiveProjectId);

  const tasks = useTasks(
    props.selectedTaskId ? effectiveProjectId : undefined,
    props.selectedTaskId ? shownRunId : undefined,
  );
  const selectedTask = props.selectedTaskId
    ? tasks.data?.find((tk) => tk.id === props.selectedTaskId)
    : undefined;

  const items: BreadcrumbItem[] = [];

  // Level 1: Workspace
  items.push({
    id: 'workspace',
    label: 'workspace',
    to: '/dashboard',
    collapseOnNarrow: false,
  });

  if (pathname === '/projects') {
    items.push({
      id: 'projects',
      label: t.nav.projects,
      current: true,
    });
  } else if (pathname === '/agents') {
    items.push({
      id: 'project',
      label: projectName,
      to: '/projects',
      collapseOnNarrow: true,
    });
    items.push({
      id: 'agents',
      label: 'Agents & Models',
      current: true,
    });
  } else if (pathname === '/analytics') {
    items.push({
      id: 'project',
      label: projectName,
      to: '/projects',
      collapseOnNarrow: true,
    });
    items.push({
      id: 'analytics',
      label: 'Metrics',
      current: true,
    });
  } else if (pathname === '/settings') {
    items.push({
      id: 'project',
      label: projectName,
      to: '/projects',
      collapseOnNarrow: true,
    });
    items.push({
      id: 'settings',
      label: t.nav.settings,
      current: true,
    });
  } else if (pathname.startsWith('/prompts')) {
    items.push({
      id: 'prompts',
      label: t.nav.prompts,
      to: matchedPrompt ? '/prompts' : undefined,
      current: matchedPrompt === undefined,
      collapseOnNarrow: matchedPrompt !== undefined,
    });
    if (matchedPrompt !== undefined) {
      items.push({
        id: `prompt-${matchedPrompt}`,
        label: matchedPrompt,
        current: true,
      });
    }
  } else {
    // Runs & Dashboard Hierarchy:
    // Workspace > Project > Runs > [Run] > [Task]
    items.push({
      id: 'project',
      label: projectName,
      to: '/projects',
      collapseOnNarrow: true,
    });

    if (pathname === '/runs') {
      items.push({
        id: 'runs',
        label: t.nav.runs,
        current: true,
      });
    } else {
      items.push({
        id: 'runs',
        label: t.nav.runs,
        to: '/runs',
        collapseOnNarrow: true,
      });

      if (shownRunId !== undefined) {
        const runHasSelectedTask = selectedTask !== undefined;
        items.push({
          id: `run-${shownRunId}`,
          label: shownRunId,
          to: runHasSelectedTask ? `/runs/${shownRunId}` : undefined,
          current: !runHasSelectedTask,
          secondary: currentRunTitle(runs.data, shownRunId),
        });

        if (selectedTask !== undefined) {
          items.push({
            id: `task-${selectedTask.id}`,
            label: `${selectedTask.id}: ${selectedTask.title}`,
            current: true,
          });
        }
      } else {
        items[items.length - 1] = {
          ...items[items.length - 1]!,
          current: true,
          to: undefined,
        };
      }
    }
  }

  // Ensure last item is marked current
  if (items.length > 0 && !items.some((it) => it.current)) {
    const last = items[items.length - 1]!;
    items[items.length - 1] = { ...last, current: true, to: undefined };
  }

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center text-body-lg">
      <ol className="m-0 flex min-w-0 list-none items-center gap-1.5 p-0">
        {items.map((item, index) => {
          return (
            <li
              key={item.id}
              className={cx(
                'flex items-center gap-1.5',
                // **The place you are does not shrink.** Every item carried
                // `min-w-0` and `truncate`, so flexbox took the shortfall out of
                // all of them equally and a narrow window produced
                // "worksp… › agent-fl… › Ru… › AF-2026-…" — four truncations that
                // between them say nothing, in a component whose only job is to
                // tell you where you are.
                //
                // The ancestors are the ones that can afford it: they are still
                // recognisable clipped, and each keeps its full name in `title`.
                item.current ? 'shrink-0' : 'min-w-0',
                item.collapseOnNarrow && 'hidden sm:flex',
              )}
            >
              {index > 0 ? <Separator /> : null}
              {item.current || !item.to ? (
                <span
                  aria-current={item.current ? 'page' : undefined}
                  className={cx(
                    'truncate',
                    item.current ? 'font-medium text-text' : 'text-faint',
                  )}
                  title={item.secondary ? `${item.label} (${item.secondary})` : item.label}
                >
                  {item.label}
                </span>
              ) : (
                <Link
                  to={item.to}
                  className="truncate text-faint transition-colors hover:text-text"
                  title={item.secondary ? `${item.label} (${item.secondary})` : item.label}
                >
                  {item.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function currentRunTitle(
  runs: readonly { readonly runId: string; readonly feature?: string }[] | undefined,
  runId: string,
): string | undefined {
  const run = runs?.find((entry) => entry.runId === runId);
  return run?.feature;
}

function Separator(): JSX.Element {
  return <ChevronRight className="h-3 w-3 shrink-0 text-faint/60" aria-hidden />;
}
