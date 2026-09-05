import type { RoleRouteView, RunnerHealthView } from '@contracts/index.js';
import { api, keys } from '../../lib/api';
import { useResource } from '../../lib/store';
import { words } from '../../lib/tone';
import { Chip, Empty, Skeleton } from '../../components/ui';

/**
 * The crew: what each logical role would run, and whether the runners can.
 *
 * Read-only. Three layers per role, kept apart on purpose — what the workflow asks for,
 * what a person configured, and what would actually resolve. They agree most of the time,
 * and the rows where they do not are the whole reason to open this page.
 */
export function CrewPage({ projectId }: { projectId?: string }) {
  const projects = useResource(keys.projects(), api.projects);
  const scope = projectId ?? projects.data?.[0]?.id;
  const roles = useResource<RoleRouteView[]>(scope === undefined ? null : keys.agents(scope), () => api.agents(scope), { refreshMs: 60_000 });
  const health = useResource<RunnerHealthView[]>(scope === undefined ? null : keys.runnersHealth(scope), () => api.runnersHealth(scope), { refreshMs: 60_000 });

  const unresolved = (roles.data ?? []).filter((role) => role.error !== undefined).length;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Crew</span>
          <h1 className="page-head__title">
            {roles.data?.length ?? 9} roles · {health.data?.length ?? '—'} runners
          </h1>
          <p className="page-head__sub">
            {scope === undefined ? 'Resolving against the first project…' : `Resolved against ${projects.data?.find((project) => project.id === scope)?.name ?? scope}.`}
            {unresolved > 0 ? ` ${String(unresolved)} role${unresolved === 1 ? '' : 's'} cannot be resolved.` : ''}
          </p>
        </div>
      </div>

      <section className="section" aria-labelledby="runners">
        <div className="section__head">
          <h2 id="runners" className="eyebrow" style={{ margin: 0 }}>
            Runners
          </h2>
        </div>
        {health.error !== undefined ? (
          <Empty error>Runner health could not be read.</Empty>
        ) : health.loading ? (
          <Skeleton rows={2} />
        ) : (
          <div className="roster">
            {(health.data ?? []).map((runner) => {
              const tone = !runner.installed ? 'bad' : !runner.executable ? 'bad' : runner.auth === 'ok' || runner.auth === 'verified' ? 'ok' : 'warn';
              return (
                <div key={runner.id} className="panel runner-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span className="runner-card__id">{runner.id}</span>
                    <Chip tone={tone}>{!runner.installed ? 'missing' : !runner.executable ? 'not executable' : words(runner.auth)}</Chip>
                  </div>
                  <dl className="runner-card__facts">
                    <dt>version</dt>
                    <dd className="mono">{runner.version ?? '—'}</dd>
                    <dt>auth</dt>
                    <dd>{words(runner.auth)}</dd>
                    {runner.detail === undefined ? null : (
                      <>
                        <dt>note</dt>
                        <dd>{runner.detail}</dd>
                      </>
                    )}
                  </dl>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="roles">
        <div className="section__head">
          <h2 id="roles" className="eyebrow" style={{ margin: 0 }}>
            Routing by role
          </h2>
          <span className="section__count">configured → resolved</span>
        </div>
        {roles.error !== undefined ? (
          <Empty error>Routing could not be read.</Empty>
        ) : roles.loading ? (
          <Skeleton rows={5} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>role</th>
                  <th>prompts</th>
                  <th>needs</th>
                  <th>configured</th>
                  <th>resolves to</th>
                  <th>fallback</th>
                </tr>
              </thead>
              <tbody>
                {(roles.data ?? []).map((role) => (
                  <tr key={role.role}>
                    <td className="mono" style={{ fontWeight: 600 }}>
                      {role.role}
                    </td>
                    <td className="mono">{role.prompts.join(', ') || '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {role.requiresReadOnly ? (
                          <Chip tone="idle" plain>
                            read-only
                          </Chip>
                        ) : null}
                        {role.requiresNativeStructuredOutput ? (
                          <Chip tone="idle" plain>
                            structured
                          </Chip>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <div className="route">
                        <span className="route__main">
                          {role.configured.runner}
                          {role.configured.model === undefined ? '' : ` · ${role.configured.model}`}
                        </span>
                        <span className="route__sub">
                          {words(role.configured.reasoning)} · {role.configured.timeoutSeconds}s
                        </span>
                      </div>
                    </td>
                    <td>
                      {role.error !== undefined ? (
                        <div className="route">
                          <Chip tone="bad">{words(role.error.kind)}</Chip>
                          <span className="route__sub">{role.error.message}</span>
                        </div>
                      ) : role.resolved === undefined ? (
                        <span className="faint">—</span>
                      ) : (
                        <div className="route">
                          <span className="route__main">
                            {role.resolved.runner}
                            {role.resolved.model === undefined ? '' : ` · ${role.resolved.model}`}
                          </span>
                          <span className="route__sub">
                            {words(role.resolved.reasoning)}
                            {role.resolved.reasoningClamped ? <span style={{ color: 'var(--warn)' }}> · clamped</span> : ''}
                            {` · ${role.resolved.structuredOutput}`}
                          </span>
                        </div>
                      )}
                    </td>
                    <td>
                      {role.fallback !== undefined ? (
                        <div className="route">
                          <span className="route__main">
                            {role.fallback.runner}
                            {role.fallback.model === undefined ? '' : ` · ${role.fallback.model}`}
                          </span>
                          <span className="route__sub">{words(role.fallback.reasoning)}</span>
                        </div>
                      ) : (
                        <span className="faint">{role.fallbackAbsent === undefined ? '—' : words(role.fallbackAbsent)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
