import { useEffect, useState } from 'react';
import type { DoctorView, ProjectView } from '@contracts/index.js';
import { api, keys } from '../../lib/api';
import { useResource } from '../../lib/store';
import { Empty, NoProjectsYet, Skeleton } from '../../components/ui';
import { useT } from '../../lib/i18n';
import { DoctorPanel } from './DoctorPanel';

/**
 * 7.5 — the first question of every working day, on the surface `ui` opens.
 *
 * Until this page there was exactly one way to ask it: a terminal. That is a strange gap
 * on a product whose intended surface is the Deck, and an expensive one — "is anything
 * broken before I start" is the question whose *late* answer costs a planning stage.
 *
 * The report is per project, because half of it is: the install probe runs the project's
 * own command, and configuration merges the project's file over the global one. The other
 * half — Node, Git, which runners are installed — is a property of the machine and says
 * the same thing whichever project is selected.
 */
export function DoctorPage({ projectId }: { projectId?: string }) {
  const t = useT();
  const projects = useResource<ProjectView[]>(keys.projects(), api.projects);
  const [selected, setSelected] = useState(projectId);
  const project = projects.data?.find(({ id }) => id === (selected ?? projectId)) ?? projects.data?.[0];
  const scope = project?.id;

  useEffect(() => {
    if (selected === undefined && projects.data?.[0] !== undefined) setSelected(projects.data[0].id);
  }, [projects.data, selected]);

  /**
   * The install probe is asked for, never waited on by default.
   *
   * Found by opening this page against a large repository: the route ran the §8.4 probe —
   * a throwaway checkout plus `npm ci` — before answering, the browser's read deadline
   * fired first, and the screen said the machine could not be diagnosed. Everything else
   * `doctor` knows is read from declarations and answers in under a second; one check was
   * holding all of it hostage.
   *
   * Keyed on the choice, so asking for the probe is a different resource rather than a
   * mutation of this one — the fast report stays on screen while the slow one is fetched.
   */
  const [withInstall, setWithInstall] = useState(false);
  const report = useResource<DoctorView>(
    scope === undefined ? null : keys.doctor(scope, withInstall),
    () => api.doctor(scope, withInstall),
  );

  if (projects.error !== undefined) {
    return (
      <main className="page">
        <Empty error>{t.common.couldNotReadProjects}</Empty>
      </main>
    );
  }
  if (projects.loading) {
    return (
      <main className="page">
        <Skeleton rows={6} />
      </main>
    );
  }
  // Loading and having none are different answers, and one spinner used to serve both.
  if (project === undefined) {
    return (
      <main className="page">
        <NoProjectsYet what={t.doctor.diagnoseVerb} />
      </main>
    );
  }

  return (
    <main className="page">
      <div className="page-head crew-head">
        <div>
          <span className="eyebrow">{t.nav.doctor}</span>
          <h1 className="page-head__title">{t.doctor.title}</h1>
          <p className="page-head__sub">
            {t.doctor.subtitleBefore}<code>agent-flow doctor --deep</code>{t.doctor.subtitleAfter}
          </p>
        </div>
        <label className="crew-control">
          {t.common.project}
          <select
            className="input"
            value={project.id}
            onChange={(event) => setSelected(event.target.value)}
          >
            {projects.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {report.error !== undefined ? (
        <Empty error>{t.doctor.couldNotDiagnose(report.error.message)}</Empty>
      ) : report.data === undefined ? (
        <Skeleton rows={8} />
      ) : (
        <DoctorPanel
          report={report.data}
          onRunInstallProbe={withInstall ? undefined : () => setWithInstall(true)}
          installProbeRunning={withInstall && report.refreshing}
        />
      )}
    </main>
  );
}
