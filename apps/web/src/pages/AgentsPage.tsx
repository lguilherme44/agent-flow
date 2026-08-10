import { AlertTriangle, ArrowRight, Check, TriangleAlert, X } from 'lucide-react';
import type {
  RoleRouteView,
  RoutedAgentView,
  RunnerHealthView,
  RunnerView,
} from '@contracts/index.js';
import { useProjectSelection } from '../app/project-context';
import { useAgents, useRunnerHealth, useRunners } from '../lib/queries';
import {
  Button,
  Empty,
  Panel,
  SectionHeader,
  Tooltip,
  cx,
} from '../components/ui';
import { humanise } from '../lib/format';

/**
 * Agents & Models (UI-23, §82) — what each logical role would actually run.
 *
 * The page the product turns on, and the one where a routing mistake is either
 * obvious or invisible. So it shows three layers rather than one, and never
 * collapses them:
 *
 *   **role** — `executor.complex`. What the workflow asks for. Provider-free by
 *   construction: the core has never heard of Claude or Codex, and neither has
 *   this column.
 *   **configured route** — the runner id, model and effort a human wrote in YAML.
 *   **resolved route** — what would run. Usually identical; the interesting cases
 *   are an effort clamped down to what the runner supports, and a route that
 *   cannot be resolved at all.
 *
 * The provider — the adapter type behind a runner id — is a separate column, and
 * it is the only place a provider name appears. It arrives as a string the server
 * read from its own registry; nothing in this app branches on its value.
 *
 * Health is the shallow check, the same one `doctor` runs for free. Nothing here
 * probes: `doctor --deep` spends quota and stays an explicit, one-off act, and a
 * page that probed nine roles on every visit would spend it on nobody's behalf.
 */
export function AgentsPage(): JSX.Element {
  const { projectId } = useProjectSelection();
  const agents = useAgents(projectId);
  const runners = useRunners(projectId);
  const health = useRunnerHealth(projectId);

  const providerOf = new Map((runners.data ?? []).map((runner) => [runner.id, runner]));
  const healthOf = new Map((health.data ?? []).map((runner) => [runner.id, runner]));

  const broken = (agents.data ?? []).filter((route) => route.error !== undefined);

  return (
    <Panel
      className="h-full"
      divided
      header={
        <SectionHeader title="Agents & Models">
          <div className="flex items-center gap-3">
            {broken.length === 0 ? null : (
              <span className="flex items-center gap-1 rounded-sm bg-danger-soft px-1.5 py-px text-micro font-medium text-danger">
                <AlertTriangle className="h-3 w-3" aria-hidden />
                {broken.length} role{broken.length === 1 ? '' : 's'} cannot be resolved
              </span>
            )}

            {/* Read-only, and saying so. Editing a route means writing YAML, and
                the write API of UI-27 covers run actions — approve, revise,
                retry, start — not configuration. A control that looked editable
                and silently discarded the change would be worse than this. */}
            <Tooltip
              content={
                <span>
                  Routing is read-only in this build. Edit{' '}
                  <code className="font-mono">~/.agent-flow/config.yaml</code>, or the project’s
                  own <code className="font-mono">.agent-flow/config.yaml</code>, and reload.
                </span>
              }
            >
              <Button disabled>Edit routing</Button>
            </Tooltip>
          </div>
        </SectionHeader>
      }
    >
      {agents.isError ? (
        <Empty
          title="The routing table could not be read."
          hint={agents.error instanceof Error ? agents.error.message : undefined}
        />
      ) : agents.data === undefined ? (
        <Empty title={agents.isLoading ? 'Resolving roles…' : 'Nothing to show.'} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full table-fixed border-collapse text-body">
            <thead className="sticky top-0 z-10 bg-surface">
              <tr className="border-b border-border text-micro uppercase tracking-wide text-faint">
                {/* Role is the flexible column, and every other one is fixed.
                    The long value in this table is not a model name — those are
                    bounded — it is the list of prompts a role runs, which is
                    what the sub-line under the role carries. Letting Model
                    absorb the slack left three hundred pixels of empty cell
                    beside a truncated "discovery, architecture-impa…". */}
                <th scope="col" className="px-2 py-1.5 pl-4 text-left font-medium">
                  Role
                </th>
                <th scope="col" className="w-[120px] px-2 py-1.5 text-left font-medium">
                  Runner
                </th>
                <th scope="col" className="hidden w-[116px] px-2 py-1.5 text-left font-medium xl:table-cell">
                  Provider
                </th>
                <th scope="col" className="w-[200px] px-2 py-1.5 text-left font-medium">
                  Model
                </th>
                <th scope="col" className="w-[96px] px-2 py-1.5 text-left font-medium">
                  Reasoning
                </th>
                {/* Fallback drops below 1280. Six columns plus a role identifier
                    do not fit 772px of content area, and at 1024 the role name
                    itself was clipping to "execut…" — the one cell in the row that
                    is its identity. The fallback is on the wide layout and in the
                    config; a truncated role name is nowhere. */}
                <th scope="col" className="hidden w-[188px] px-2 py-1.5 text-left font-medium xl:table-cell">
                  Fallback
                </th>
                <th scope="col" className="w-[112px] px-2 py-1.5 pr-4 text-left font-medium">
                  Health
                </th>
              </tr>
            </thead>
            <tbody>
              {agents.data.map((route) => (
                <RoleRow
                  key={route.role}
                  route={route}
                  provider={providerOf.get(route.configured.runner)}
                  health={healthOf.get(route.configured.runner)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function RoleRow(props: {
  route: RoleRouteView;
  provider: RunnerView | undefined;
  health: RunnerHealthView | undefined;
}): JSX.Element {
  const { route } = props;
  const resolved = route.resolved;

  return (
    <tr className="border-b border-border/70 align-top hover:bg-surface-2">
      <td className="px-2 py-2 pl-4">
        <span className="flex min-w-0 flex-col">
          {/* The logical name, exactly as the config and the core spell it. Not
              prettified: `executor.complex` is the identifier a person greps for. */}
          <span className="truncate font-mono text-label text-text">{route.role}</span>
          <span
            className="truncate text-micro text-faint"
            title={`runs ${route.prompts.join(', ')}`}
          >
            {route.prompts.join(', ')}
            {route.requiresReadOnly ? ' · read-only' : ''}
            {route.requiresNativeStructuredOutput ? ' · native json' : ''}
          </span>
        </span>
      </td>

      <td className="px-2 py-2">
        {/* Configured above, resolved below, and only when they differ. Printing
            both unconditionally would make the row that matters look like all
            the others. */}
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-label text-text">{route.configured.runner}</span>
          {resolved === undefined || resolved.runner === route.configured.runner ? null : (
            <span className="flex items-center gap-1 truncate text-micro text-warning">
              <ArrowRight className="h-3 w-3 shrink-0" aria-hidden />
              {resolved.runner}
            </span>
          )}
        </span>
      </td>

      <td className="hidden px-2 py-2 xl:table-cell">
        <span className="truncate text-micro text-muted">
          {props.provider?.provider ?? 'unknown'}
        </span>
      </td>

      <td className="px-2 py-2">
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-label text-text" title={route.configured.model}>
            {route.configured.model ?? 'runner default'}
          </span>
          {route.error === undefined ? (
            <span className="truncate text-micro text-faint">
              {resolved?.structuredOutput === 'native' ? 'native json' : 'prompted json'} ·{' '}
              {route.configured.timeoutSeconds}s timeout
            </span>
          ) : (
            // The whole reason this page exists. A role that cannot resolve is
            // shown as broken here rather than discovered three stages into a run.
            <span className="truncate text-micro text-danger" title={route.error.message}>
              {humanise(route.error.kind)}
            </span>
          )}
        </span>
      </td>

      <td className="px-2 py-2">
        <Effort configured={route.configured.reasoning} resolved={resolved} />
      </td>

      <td className="hidden px-2 py-2 xl:table-cell">
        <Fallback route={route} />
      </td>

      <td className="px-2 py-2 pr-4">
        <HealthChip health={props.health} />
      </td>
    </tr>
  );
}

/**
 * The configured effort, and what it was clamped to.
 *
 * Clamping is a real degradation (R-15): the run happened, at less effort than
 * somebody asked for, and it is recorded on the run for exactly that reason. It
 * belongs here too, where the choice is still editable.
 */
function Effort(props: {
  configured: string;
  resolved: RoutedAgentView | undefined;
}): JSX.Element {
  const clamped = props.resolved?.reasoningClamped === true;

  if (!clamped) {
    return <span className="truncate text-label capitalize text-text">{props.configured}</span>;
  }

  return (
    <Tooltip
      content={
        <span>
          This runner cannot do {humanise(props.configured)}, so it would run at{' '}
          {humanise(props.resolved?.reasoning ?? '')} instead.
        </span>
      }
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-label capitalize text-warning">
          {props.resolved?.reasoning}
        </span>
        <span className="truncate text-micro text-faint line-through">{props.configured}</span>
      </span>
    </Tooltip>
  );
}

/** Why a role has no fallback. Absent by choice is not the same as unusable. */
const ABSENCE_TEXT: Record<string, string> = {
  disabled: 'fallback is off',
  not_configured: 'none configured',
  unusable: 'configured, unusable',
};

function Fallback(props: { route: RoleRouteView }): JSX.Element {
  const { fallback, fallbackAbsent } = props.route;

  if (fallback === undefined) {
    return (
      <Tooltip
        content={
          fallbackAbsent === 'unusable' ? (
            <span>
              A fallback is configured for this role and cannot serve it — the runner is
              missing, disabled, or unable to do what the role’s prompt requires. A
              configuration mistake, not a deliberate choice.
            </span>
          ) : (
            <span>
              Nothing to fall back to. Fallback covers infrastructure failures only (§55);
              a capability gap is never routed around.
            </span>
          )
        }
      >
        <span
          className={cx(
            'truncate text-micro',
            fallbackAbsent === 'unusable' ? 'text-warning' : 'text-faint',
          )}
        >
          {ABSENCE_TEXT[fallbackAbsent ?? ''] ?? 'none'}
        </span>
      </Tooltip>
    );
  }

  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-label text-muted">
        {fallback.runner} · {fallback.model ?? 'runner default'}
      </span>
      <span className="truncate text-micro capitalize text-faint">
        {fallback.reasoning}
        {fallback.reasoningClamped ? ' (clamped)' : ''}
      </span>
    </span>
  );
}

/**
 * The shallow health of the runner this role points at.
 *
 * Three states, not two. A runner that is installed but unauthenticated is not
 * the same as one that is absent, and collapsing them into "not ok" is how
 * DEGRADED becomes the normal state nobody notices (R-16).
 */
function HealthChip(props: { health: RunnerHealthView | undefined }): JSX.Element {
  const { health } = props;

  if (health === undefined) {
    return <span className="text-micro text-faint">unknown</span>;
  }

  const ready = health.installed && health.executable && health.auth !== 'not_configured';
  const Icon = ready ? Check : health.installed ? TriangleAlert : X;
  const label = ready ? 'ready' : health.installed ? humanise(health.auth) : 'not installed';

  return (
    <Tooltip
      content={
        <span>
          {health.installed ? 'installed' : 'not installed'} ·{' '}
          {health.executable ? 'executable' : 'not executable'} · auth {humanise(health.auth)}
          {health.version === undefined ? '' : ` · ${health.version}`}
          {health.detail === undefined ? '' : ` — ${health.detail}`}
        </span>
      }
    >
      <span
        className={cx(
          'inline-flex max-w-full items-center gap-1 rounded-sm px-1.5 py-px text-micro font-medium',
          ready
            ? 'bg-success-soft text-success'
            : health.installed
              ? 'bg-warning-soft text-warning'
              : 'bg-danger-soft text-danger',
        )}
      >
        <Icon className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </span>
    </Tooltip>
  );
}
