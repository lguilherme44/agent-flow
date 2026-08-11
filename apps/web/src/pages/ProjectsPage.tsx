import { Link } from 'react-router-dom';
import { Check, FolderGit2, Plus, TriangleAlert, X } from 'lucide-react';
import type { ProjectView, RunnerHealthView } from '@contracts/index.js';
import { runHref, useProjectSelection } from '../app/project-context';
import { useProjects, useRunnerHealth } from '../lib/queries';
import {
  Button,
  Empty,
  Panel,
  SectionHeader,
  StatusDot,
  Tooltip,
  cx,
} from '../components/ui';
import { formatWhen, formatWhenCompact, humanise } from '../lib/format';
import { runLabel, runTone } from '../lib/status';

/**
 * Projects (UI-22, §81) — what this server found, and what each one is doing.
 *
 * A table rather than the cards §81 names, and that is a deliberate departure.
 * Cards were what the dashboard redesign removed: the fields here are the same
 * five for every project, repeated, and repeated fields in equal-weight boxes are
 * the pattern that makes a screen unscannable. A row per project reads as a
 * registry, which is what this is.
 *
 * The browser still knows a project only by its id. The path is shown because
 * §81 asks for it and because a person with two checkouts of the same repository
 * needs to know which one this is — but it travels in one direction only. No
 * endpoint on this server accepts a path, so there is nothing here for a crafted
 * one to reach (§93).
 */
export function ProjectsPage(): JSX.Element {
  const projects = useProjects();
  const { projectId, select } = useProjectSelection();

  // Health for the project in scope, and only that one. The shallow check spawns
  // a CLI per runner; doing it per row would make opening this page cost one
  // process per project per runner, which is the N+1 §96 forbids — and it would
  // be a fiction anyway, since a project can override which runners it uses.
  //
  // Not asked at all until something is in scope, because with nothing selected
  // there is no project this would be the health *of*.
  const health = useRunnerHealth(projectId, { enabled: projectId !== undefined });

  return (
    <Panel
      className="h-full"
      divided
      header={
        <SectionHeader title="Projects">
          <div className="flex items-center gap-3">
            {projectId === undefined ? (
              <span className="text-micro text-faint">
                Select a project to see its runner health
              </span>
            ) : (
              <RunnerHealthStrip runners={health.data} />
            )}

            {/* Present because §68 and §94 both name it, disabled because adding
                a project means writing to the registry, and the write API of
                UI-27 covers run actions only. A button that appeared to work and
                did not would be worse than one that says why. */}
            <Tooltip
              content={
                <span>
                  Adding a project writes to the registry, which this build has no
                  endpoint for. Run <code className="font-mono">agent-flow init</code> in the
                  repository and restart the UI.
                </span>
              }
            >
              <Button disabled>
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Add Project
              </Button>
            </Tooltip>
          </div>
        </SectionHeader>
      }
    >
      <ProjectsBody
        projects={projects.data}
        selectedId={projectId}
        onSelect={select}
        isLoading={projects.isLoading}
        error={projects.isError ? projects.error : undefined}
      />
    </Panel>
  );
}

function ProjectsBody(props: {
  projects: ProjectView[] | undefined;
  selectedId: string | undefined;
  onSelect: (projectId: string | undefined) => void;
  isLoading: boolean;
  error: unknown;
}): JSX.Element {
  if (props.error !== undefined) {
    return (
      <Empty
        title="The project registry could not be read."
        hint={props.error instanceof Error ? props.error.message : undefined}
      />
    );
  }

  if (props.projects === undefined) {
    return <Empty title={props.isLoading ? 'Looking for projects…' : 'Nothing to show.'} />;
  }

  if (props.projects.length === 0) {
    return (
      <Empty
        title="No Agent Flow project found."
        hint={
          <>
            Run <code className="font-mono">agent-flow init</code> in a repository, then restart
            the UI. The server only lists directories that have been initialised.
          </>
        }
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full table-fixed border-collapse text-body">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-border text-micro uppercase tracking-wide text-faint">
            <th scope="col" className="w-[220px] px-2 py-1.5 pl-4 text-left font-medium">
              Project
            </th>
            <th scope="col" className="px-2 py-1.5 text-left font-medium">
              Path
            </th>
            <th scope="col" className="hidden w-[110px] px-2 py-1.5 text-left font-medium xl:table-cell">
              Stack
            </th>
            <th scope="col" className="w-[190px] px-2 py-1.5 text-left font-medium">
              Current run
            </th>
            <th scope="col" className="w-[190px] px-2 py-1.5 text-left font-medium">
              Last run
            </th>
            <th scope="col" className="w-[84px] px-2 py-1.5 pr-4 text-right font-medium">
              <span className="sr-only">Select</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {props.projects.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              selected={project.id === props.selectedId}
              onSelect={props.onSelect}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProjectRow(props: {
  project: ProjectView;
  selected: boolean;
  onSelect: (projectId: string | undefined) => void;
}): JSX.Element {
  const { project } = props;

  return (
    <tr
      className={cx(
        'border-b border-border/70',
        props.selected ? 'bg-primary-soft' : 'hover:bg-surface-2',
      )}
    >
      <td className="px-2 py-2 pl-4">
        <span className="relative flex min-w-0 items-center gap-2">
          {props.selected ? (
            <span
              className="absolute -left-4 h-6 w-0.5 rounded-r bg-primary-bright"
              aria-hidden
            />
          ) : null}
          <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-label font-medium text-text">{project.name}</span>
            <span className="truncate text-micro text-faint">
              {project.runCount} run{project.runCount === 1 ? '' : 's'}
            </span>
          </span>
        </span>
      </td>

      <td className="px-2 py-2">
        <span className="block truncate font-mono text-micro text-faint" title={project.path}>
          {project.path}
        </span>
      </td>

      <td className="hidden px-2 py-2 xl:table-cell">
        {project.stack === undefined ? (
          <span className="text-micro text-faint">not detected</span>
        ) : (
          <span className="rounded-sm border border-border px-1.5 py-px text-micro text-muted">
            {project.stack}
          </span>
        )}
      </td>

      <td className="px-2 py-2">
        {project.currentRunId === null ? (
          <span className="text-label text-faint">idle</span>
        ) : (
          <span className="flex min-w-0 flex-col gap-0.5">
            {/* The project rides in the link, not in a click handler beside it.
                The run belongs to this project — without it the breadcrumb reads
                "all projects" while showing one project's run, and in a workspace
                the run would be looked up under whichever project happened to be
                selected. One navigation, carrying both facts. */}
            <Link
              to={runHref(project.currentRunId, project.id)}
              className="tabular truncate text-label font-medium text-text hover:text-primary-bright"
            >
              {project.currentRunId}
            </Link>
            {project.status === null ? (
              <span className="text-micro text-faint">unreadable state</span>
            ) : (
              <StatusDot
                tone={runTone(project.status)}
                label={runLabel(project.status)}
                spin={project.status === 'running'}
                className="text-micro"
              />
            )}
          </span>
        )}
      </td>

      <td className="px-2 py-2">
        {project.lastRun === undefined ? (
          <span className="text-label text-faint">none finished</span>
        ) : (
          <span className="flex min-w-0 flex-col gap-0.5">
            <Link
              to={runHref(project.lastRun.runId, project.id)}
              className="tabular truncate text-label text-muted hover:text-primary-bright"
              title={project.lastRun.feature}
            >
              {project.lastRun.runId}
            </Link>
            <span
              className="truncate text-micro text-faint"
              // Compact, and titled. "COMPLETED · Yesterday at 15:30:00" does not
              // fit the column and an ellipsis mid-timestamp reads as broken.
              title={`${runLabel(project.lastRun.status)} — ${formatWhen(project.lastRun.updatedAt)}`}
            >
              {runLabel(project.lastRun.status)} · {formatWhenCompact(project.lastRun.updatedAt)}
            </span>
          </span>
        )}
      </td>

      <td className="px-2 py-2 pr-4 text-right">
        <Button
          size="sm"
          variant={props.selected ? 'ghost' : 'surface'}
          onClick={() => {
            props.onSelect(props.selected ? undefined : project.id);
          }}
        >
          {props.selected ? 'Clear' : 'Select'}
        </Button>
      </td>
    </tr>
  );
}

/**
 * Runner health for the selected project, as one line (§94).
 *
 * The shallow check only — the same one `doctor` runs for free. `doctor --deep`
 * spends quota and stays an explicit act; a page that probed for real on every
 * visit would spend it on nobody's behalf.
 */
function RunnerHealthStrip(props: { runners: RunnerHealthView[] | undefined }): JSX.Element {
  if (props.runners === undefined || props.runners.length === 0) {
    return <span className="text-micro text-faint">Runner health unknown</span>;
  }

  return (
    <ul className="flex items-center gap-2" aria-label="Runner health">
      {props.runners.map((runner) => {
        const ready = runner.installed && runner.executable && runner.auth !== 'not_configured';
        const Icon = ready ? Check : runner.installed ? TriangleAlert : X;

        return (
          <li key={runner.id}>
            <Tooltip
              content={
                <span>
                  {runner.installed ? 'installed' : 'not installed'} ·{' '}
                  {runner.executable ? 'executable' : 'not executable'} · auth{' '}
                  {humanise(runner.auth)}
                  {runner.version === undefined ? '' : ` · ${runner.version}`}
                  {runner.detail === undefined ? '' : ` — ${runner.detail}`}
                </span>
              }
            >
              <span
                className={cx(
                  'inline-flex items-center gap-1 rounded-sm px-1.5 py-px text-micro font-medium',
                  ready
                    ? 'bg-success-soft text-success'
                    : runner.installed
                      ? 'bg-warning-soft text-warning'
                      : 'bg-danger-soft text-danger',
                )}
              >
                <Icon className="h-3 w-3" aria-hidden />
                {runner.id}
              </span>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
