import type {
  DoctorCapabilityView,
  DoctorInstallProbeView,
  DoctorRunnerView,
  DoctorStageRoutingView,
  DoctorToolView,
  DoctorView,
} from '@contracts/index.js';
import { Chip } from '../../components/ui';
import type { Tone } from '../../lib/tone';
import { authState, level, useT, word } from '../../lib/i18n';

/**
 * "Can this machine work?", on the surface that is supposed to replace the terminal.
 *
 * The report is the same one `agent-flow doctor` prints, because it is the same function:
 * `app/diagnostics.ts` decides, and both surfaces render. Nothing here recomputes a
 * verdict, re-derives a finding, or decides that a stage is over-served — every judgement
 * arrives already made, which is the only reason the two can be trusted to agree.
 *
 * Two things this panel refuses to do. It never invokes a runner, so opening it costs
 * nothing and a refresh costs nothing. And it never repeats an auth answer as advice when
 * the server could not have known it: `readsEnvironment` is false over HTTP (§93), so a
 * runner keyed by an environment variable is qualified rather than reported broken.
 */
export function DoctorPanel({
  report,
  onRunInstallProbe,
  installProbeRunning = false,
}: {
  report: DoctorView;
  /** Absent once it has been asked for, or when there is nothing to ask. */
  onRunInstallProbe?: (() => void) | undefined;
  installProbeRunning?: boolean;
}) {
  const t = useT();
  return (
    <div className="doctor">
      <Verdict report={report} />

      <Section title={t.doctor.thisMachine}>
        <ul className="doctor-list">
          {report.tools.map((tool) => (
            <ToolRow key={tool.name} tool={tool} />
          ))}
        </ul>
      </Section>

      <InstallSection
        probe={report.install}
        onRun={onRunInstallProbe}
        running={installProbeRunning}
      />

      <Section
        title={t.crew.runners}
        note={report.readsEnvironment ? undefined : t.doctor.envNotChecked}
      >
        <ul className="doctor-list">
          {report.runners.map((runner) => (
            <RunnerRow key={runner.id} runner={runner} />
          ))}
        </ul>
        {report.unusedRunners.length === 0 ? null : (
          <p className="doctor-note">
            {t.doctor.routedNowhere(report.unusedRunners.map((runner) => runner.id).join(', '))}
          </p>
        )}
      </Section>

      <Section title={t.doctor.capabilities} note={t.doctor.declaredByAdapters}>
        <ul className="doctor-list">
          {report.capabilities.map((entry) => (
            <CapabilityRow key={entry.role} entry={entry} />
          ))}
        </ul>
      </Section>

      <Section title={t.doctor.stageRouting} note={t.doctor.stageRoutingNote}>
        <ul className="doctor-list">
          {report.stageRouting.map((row) => (
            <StageRow key={row.stage} row={row} />
          ))}
        </ul>
      </Section>

      <Problems report={report} />
    </div>
  );
}

const VERDICT_TONE: Record<DoctorView['status'], Tone> = {
  OK: 'ok',
  DEGRADED: 'warn',
  FAIL: 'bad',
};

/**
 * The line most readers keep, and it may not overstate itself.
 *
 * A bare `OK` on a shallow check means "nothing here blocks a run", not "everything was
 * verified" — authentication is never probed, so a run started from an `OK` can still die
 * on its first model call. The note the server sends says so; this shows it beside the
 * word rather than below the fold.
 */
function Verdict({ report }: { report: DoctorView }) {
  const t = useT();
  return (
    <div className="doctor-verdict" data-tone={VERDICT_TONE[report.status]}>
      <strong className="doctor-verdict__word">{report.status}</strong>
      <div className="doctor-verdict__why">
        {report.status === 'FAIL' ? (
          <p>
            {report.unresolvableRoles.length > 0
              ? t.doctor.rolesCannotRun(report.unresolvableRoles.length, report.unresolvableRoles.join(', '))
              : t.doctor.aRoleHasNowhere}
          </p>
        ) : null}
        {report.status === 'DEGRADED' ? <p>{t.doctor.degradedStill}</p> : null}
        {report.notes.map((note) => (
          <p key={note} className="doctor-note">
            {note}
          </p>
        ))}
      </div>
    </div>
  );
}

function ToolRow({ tool }: { tool: DoctorToolView }) {
  const t = useT();
  const belowFloor = tool.belowFloor === true;
  return (
    <li className="doctor-row" data-tool={tool.name}>
      <span className="doctor-row__name">{tool.name === 'node' ? 'Node' : 'Git'}</span>
      <span className="doctor-row__value">{tool.version ?? t.doctor.notFound}</span>
      <Chip tone={tool.present ? (belowFloor ? 'warn' : 'ok') : 'bad'}>
        {tool.present ? (belowFloor ? t.doctor.below(tool.floor ?? '') : t.doctor.installed) : t.crew.missing}
      </Chip>
    </li>
  );
}

function RunnerRow({ runner }: { runner: DoctorRunnerView }) {
  const t = useT();
  const tone: Tone = !runner.installed || !runner.executable ? 'bad' : runner.auth === 'not_configured' ? 'warn' : runner.auth === 'unknown' ? 'ghost' : 'ok';
  return (
    <li className="doctor-row" data-runner={runner.id}>
      <span className="doctor-row__name">{runner.id}</span>
      <span className="doctor-row__value">
        {!runner.installed
          ? t.doctor.notInstalled
          : !runner.executable
            ? (runner.detail ?? t.doctor.willNotRun)
            : t.doctor.auth(authState(t, runner.auth))}
      </span>
      <Chip tone={tone}>{runner.installed && runner.executable ? authState(t, runner.auth) : t.doctor.unusable}</Chip>
    </li>
  );
}

/**
 * One role's pair, and the two things that can be wrong with it before anything runs.
 *
 * A clamp is a fact available at configuration time — asking for an effort the pair does
 * not offer — and it cost a task attempt to discover at runtime. A permission gap is a
 * warning and never a verdict: nothing is blocked by it, and the fix is a person granting
 * something in the runner's own configuration.
 */
function CapabilityRow({ entry }: { entry: DoctorCapabilityView }) {
  const t = useT();
  if (entry.kind === 'unresolvable') {
    return (
      <li className="doctor-row doctor-row--bad" data-role={entry.role}>
        {/* A role id is what somebody types in `config.yaml`. Never translated. */}
        <span className="doctor-row__name">{entry.role}</span>
        <span className="doctor-row__value">
          {entry.runner} — {entry.reason ?? t.doctor.cannotBeResolved}
        </span>
        <Chip tone="bad">{t.doctor.cannotRun}</Chip>
      </li>
    );
  }

  const clamped = entry.reasoningClamped === true;
  return (
    <li className="doctor-row" data-role={entry.role}>
      <span className="doctor-row__name">{entry.role}</span>
      <span className="doctor-row__value">
        {entry.runner} · {entry.model ?? t.crew.runnerDefault} ·{' '}
        {clamped
          ? t.doctor.effortNotOffered(level(t, entry.requestedReasoning), level(t, String(entry.effectiveReasoning)))
          : t.doctor.effort(level(t, String(entry.effectiveReasoning)))}
        {entry.permissionFinding === undefined ? null : (
          <em className="doctor-row__warn">
            {' '}
            · {entry.permissionFinding.action}
          </em>
        )}
      </span>
      <Chip tone={clamped || entry.permissionFinding !== undefined ? 'warn' : 'ok'}>
        {clamped ? t.inspector.clamped : entry.permissionFinding !== undefined ? t.doctor.grantMissing : t.doctor.ready}
      </Chip>
    </li>
  );
}

function StageRow({ row }: { row: DoctorStageRoutingView }) {
  const t = useT();
  return (
    <li className="doctor-row" data-stage={row.stage}>
      <span className="doctor-row__name">{word(t, row.stage)}</span>
      <span className="doctor-row__value">
        {row.runner} · {row.readsRepository ? t.doctor.readsRepository : t.doctor.textInTextOut}
        {row.overpowered ? (
          <em className="doctor-row__warn"> · {t.doctor.overpoweredNote}</em>
        ) : null}
      </span>
      <Chip tone={row.overpowered ? 'warn' : 'ok'}>{row.overpowered ? t.doctor.overServed : t.doctor.fits}</Chip>
    </li>
  );
}

/**
 * The §8.4 probe, which is the one check that can refuse every task in a project.
 *
 * Silent when it was skipped: there is nothing to say about a project with no install
 * command, and a placeholder saying "not checked" would read as a finding.
 */
function InstallSection({
  probe,
  onRun,
  running,
}: {
  probe: DoctorInstallProbeView;
  onRun?: (() => void) | undefined;
  running: boolean;
}) {
  const t = useT();
  if (probe.outcome === 'skipped') {
    // Every other skip is a fact about the project — no install command, not a
    // repository — and has nothing to offer. `not_requested` is a decision waiting to be
    // made, and hiding it would hide the one check that can refuse every task.
    if (probe.reason !== 'not_requested') return null;

    return (
      <Section title={t.doctor.installProbe}>
        <p className="doctor-note">{t.doctor.probeNotRun}</p>
        <div className="clean-actions">
          <button type="button" className="btn" onClick={onRun} disabled={onRun === undefined || running}>
            {running ? t.doctor.probeRunning : t.doctor.runProbe}
          </button>
        </div>
      </Section>
    );
  }

  const message: Record<Exclude<DoctorInstallProbeView['outcome'], 'skipped'>, { tone: Tone; text: string }> = {
    clean: { tone: 'ok', text: t.doctor.probeClean(String(probe.command)) },
    dirty_before: { tone: 'bad', text: t.doctor.probeDirtyBefore },
    install_failed: { tone: 'bad', text: t.doctor.probeInstallFailed(String(probe.command)) },
    dirties_checkout: { tone: 'bad', text: t.doctor.probeDirties(String(probe.command)) },
  };
  const said = message[probe.outcome];

  return (
    <Section title={t.doctor.installProbe}>
      <p className="doctor-finding" data-tone={said.tone}>
        <Chip tone={said.tone}>{probe.outcome === 'clean' ? t.doctor.clean : t.doctor.blocking}</Chip> {said.text}
      </p>
      {probe.entries === undefined || probe.entries.length === 0 ? null : (
        <ul className="doctor-paths">
          {probe.entries.map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** What was lost, what has nowhere to run, and the one action for each. */
function Problems({ report }: { report: DoctorView }) {
  const t = useT();
  const nothing =
    report.orphanRoles.length === 0 &&
    report.degradations.length === 0 &&
    report.remediations.length === 0;

  if (nothing) return null;

  return (
    <Section title={t.doctor.whatToFix}>
      {report.orphanRoles.length === 0 ? null : (
        <ul className="doctor-list">
          {report.orphanRoles.map((orphan) => (
            <li key={orphan.role} className="doctor-row doctor-row--bad">
              <span className="doctor-row__name">{orphan.role}</span>
              <span className="doctor-row__value">
                {t.doctor.unusableNoFallback(orphan.primary)}
              </span>
              <Chip tone="bad">{t.doctor.nowhereToRun}</Chip>
            </li>
          ))}
        </ul>
      )}

      {report.degradations.map((degradation) => (
        // Never a bare "degraded": what a person loses is the point (R-16).
        <p key={degradation.reason} className="doctor-finding" data-tone="warn">
          <Chip tone="warn">{t.doctor.degraded}</Chip> {degradation.reason} — {degradation.impact}
        </p>
      ))}

      {report.remediations.map((remediation) => (
        <p key={remediation.problem} className="doctor-finding" data-tone="idle">
          {remediation.problem}. <code>{remediation.fix}</code>
        </p>
      ))}
    </Section>
  );
}

function Section({ title, note, children }: { title: string; note?: string | undefined; children: React.ReactNode }) {
  return (
    <section className="doctor-section" aria-label={title}>
      <div className="doctor-section__head">
        <h2>{title}</h2>
        {note === undefined ? null : <p className="doctor-note">{note}</p>}
      </div>
      {children}
    </section>
  );
}
