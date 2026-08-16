import { AlertTriangle, ArrowRight, Check, TriangleAlert, X } from 'lucide-react';
import type {
  RoleRouteView,
  RoutedAgentView,
  RunnerHealthView,
  RunnerView,
} from '@contracts/index.js';
import { useProjectSelection } from '../app/project-context';
import { useAgents, useConfig, useRunnerHealth, useRunners } from '../lib/queries';
import {
  Button,
  Empty,
  Panel,
  SectionHeader,
  Tooltip,
  cx,
} from '../components/ui';
import { humanise } from '../lib/format';

export function AgentsPage(): JSX.Element {
  const { projectId } = useProjectSelection();
  const agents = useAgents(projectId);
  const runners = useRunners(projectId);
  const health = useRunnerHealth(projectId);

  const providerOf = new Map((runners.data ?? []).map((runner) => [runner.id, runner]));
  const healthOf = new Map((health.data ?? []).map((runner) => [runner.id, runner]));

  const broken = (agents.data ?? []).filter((route) => route.error !== undefined);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto">
      {/* SECTION 1: WORKFLOW AGENTS (Autonomous Execution Runners) */}
      <Panel
        className="shrink-0"
        divided
        header={
          <SectionHeader title="Workflow Agents">
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
                <tr className="border-b border-border text-micro uppercase tracking-caps text-faint">
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

      {/* SECTION 2: CONTEXT INTELLIGENCE & ADVISORY (Utility Model) */}
      <ContextIntelligenceSection projectId={projectId} />
    </div>
  );
}

function ContextIntelligenceSection(props: { projectId: string | undefined }): JSX.Element {
  const config = useConfig(props.projectId);
  const utility = config.data?.sections.find((s) => s.id === 'utility');
  const providerSetting = utility?.settings.find((s) => s.key === 'provider')?.value;
  const modelSetting = utility?.settings.find((s) => s.key === 'model')?.value;
  const endpointSetting = utility?.settings.find((s) => s.key === 'endpoint')?.value;

  const sanitizeUrl = (raw: unknown): string => {
    if (typeof raw !== 'string' || !raw) return 'http://127.0.0.1:11434/v1';
    try {
      const parsed = new URL(raw);
      parsed.search = '';
      parsed.password = '';
      parsed.username = '';
      return parsed.toString().replace(/\/$/, '');
    } catch {
      return String(raw).replace(/api_key=[^&]+/, 'api_key=***');
    }
  };

  const effectiveProvider = typeof providerSetting === 'string' ? providerSetting : 'openai-compatible';
  const effectiveModel = typeof modelSetting === 'string' ? modelSetting : 'qwen2.5-coder:7b';
  const sanitizedEndpoint = sanitizeUrl(endpointSetting);

  return (
    <Panel
      divided
      className="shrink-0"
      header={
        <SectionHeader title="Context Intelligence & Advisory">
          <span className="flex items-center gap-1.5 rounded-sm bg-primary-soft px-2 py-0.5 text-micro font-medium text-text">
            Advisory Only · Zero Authority
          </span>
        </SectionHeader>
      }
    >
      <div className="flex flex-col gap-3 px-4 pb-3">
        <div className="rounded-md border border-border bg-surface-2 p-3 text-label text-muted">
          <p className="font-medium text-text mb-1">Strict Authority Boundary</p>
          <p className="text-micro text-faint">
            The Utility Model acts strictly as an advisory context condenser and filter. It holds{' '}
            <strong className="text-text">ZERO</strong> workflow authority, <strong className="text-text">ZERO</strong> verification authority, <strong className="text-text">ZERO</strong> review authority, and <strong className="text-text">ZERO</strong> shell or git execution authority.
          </p>
        </div>

        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2 xl:grid-cols-4 border-t border-border pt-3 text-body-lg">
          <div className="flex flex-col">
            <dt className="text-micro uppercase tracking-caps text-faint">Adapter Type</dt>
            <dd className="font-mono text-label text-text">{effectiveProvider}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-micro uppercase tracking-caps text-faint">Effective Model</dt>
            <dd className="font-mono text-label text-text">{effectiveModel}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-micro uppercase tracking-caps text-faint">Endpoint URL</dt>
            <dd className="font-mono text-label text-text truncate" title={sanitizedEndpoint}>
              {sanitizedEndpoint}
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-micro uppercase tracking-caps text-faint">Fallback Behavior</dt>
            <dd className="text-label text-success">Safe Bypass (Non-blocking)</dd>
          </div>
        </dl>
      </div>
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
  const isAgy = route.configured.runner === 'agy' || resolved?.runner === 'agy';
  const modelName = isAgy ? 'Unobservable' : (route.configured.model ?? 'runner default');

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
          <span
            className={cx('truncate text-label', isAgy ? 'text-faint italic' : 'text-text')}
            title={
              isAgy
                ? 'The backing model of AGY CLI is managed internally by the CLI binary and is unobservable'
                : (route.configured.model ?? 'runner default')
            }
          >
            {modelName}
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
