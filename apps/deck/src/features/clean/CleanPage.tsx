import { useEffect, useState } from 'react';
import type { CleanRunView, CleanView, ProjectView } from '@contracts/index.js';
import { ApiError, api, keys, type CleanOptions } from '../../lib/api';
import { invalidate, useResource } from '../../lib/store';
import { Chip, Empty, Notice, NoProjectsYet, Skeleton } from '../../components/ui';
import { useT, type Dictionary } from '../../lib/i18n';
import type { Tone } from '../../lib/tone';

/**
 * 7.7 — reclaiming disk, with the answer shown before the act.
 *
 * Reclaiming a worktree or a ref is the operation that frightens people most, and until
 * now the only way to ask what it would do was `--dry-run` in a terminal. That is a
 * strange gap on a surface meant to replace the terminal: the frightening operation is
 * exactly the one whose preview has to be one click away.
 *
 * **The preview is the same function.** `POST /clean` with `dryRun` runs
 * `app/workspace-cleanup.ts` down the same path and writes nothing, so what this page
 * shows is what the next call will do — not a second implementation that agrees until
 * somebody edits one of them.
 *
 * Nothing is removed without a preview first: the button that writes only appears once a
 * dry run has produced a plan, and it acts on the options that plan was computed with.
 */
export function CleanPage({ projectId }: { projectId?: string }) {
  const t = useT();
  const projects = useResource<ProjectView[]>(keys.projects(), api.projects);
  const [selected, setSelected] = useState(projectId);
  const project = projects.data?.find(({ id }) => id === (selected ?? projectId)) ?? projects.data?.[0];

  const [options, setOptions] = useState<CleanOptions>({ keep: 5 });
  const [plan, setPlan] = useState<CleanView | undefined>(undefined);
  const [done, setDone] = useState<CleanView | undefined>(undefined);
  const [busy, setBusy] = useState<'preview' | 'apply' | undefined>(undefined);
  const [refusal, setRefusal] = useState<ApiError | undefined>(undefined);

  useEffect(() => {
    if (selected === undefined && projects.data?.[0] !== undefined) setSelected(projects.data[0].id);
  }, [projects.data, selected]);

  // Any change to what would be removed invalidates the plan on screen. A preview that
  // survived its own options would be the most dangerous thing this page could show.
  const change = (patch: Partial<CleanOptions>): void => {
    setOptions((current) => ({ ...current, ...patch }));
    setPlan(undefined);
    setDone(undefined);
    setRefusal(undefined);
  };

  const run = async (dryRun: boolean): Promise<void> => {
    if (project === undefined) return;
    setBusy(dryRun ? 'preview' : 'apply');
    setRefusal(undefined);
    try {
      const result = await api.clean(project.id, { ...options, dryRun });
      if (dryRun) {
        setPlan(result);
        setDone(undefined);
      } else {
        setDone(result);
        setPlan(undefined);
        invalidate((key) => key.includes('/runs') || key.includes('/workspace') || key.includes('/projects'));
      }
    } catch (error) {
      setRefusal(error instanceof ApiError ? error : new ApiError(0, String(error)));
    } finally {
      setBusy(undefined);
    }
  };

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
        <NoProjectsYet what={t.clean.reclaimVerb} />
      </main>
    );
  }

  const shown = done ?? plan;

  return (
    <main className="page">
      <div className="page-head crew-head">
        <div>
          <span className="eyebrow">{t.nav.clean}</span>
          <h1 className="page-head__title">{t.clean.title}</h1>
          <p className="page-head__sub">{t.clean.subtitle}</p>
        </div>
        <label className="crew-control">
          {t.common.project}
          <select className="input" value={project.id} onChange={(event) => setSelected(event.target.value)}>
            {projects.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section className="doctor-section" aria-label={t.clean.whatToReclaim}>
        <div className="clean-options">
          <label className="field">
            <span className="eyebrow">{t.clean.keepNewest}</span>
            <input
              className="input"
              type="number"
              min={0}
              max={1000}
              value={options.keep ?? 5}
              onChange={(event) => change({ keep: Number(event.target.value) })}
            />
          </label>

          <Toggle
            label={t.clean.activeRunToo}
            note={t.clean.activeRunNote}
            checked={options.force === true}
            onChange={(force) => change({ force })}
          />
          <Toggle
            label={t.clean.cachedMap}
            note={t.clean.cachedMapNote}
            checked={options.cache === true}
            onChange={(cache) => change({ cache })}
          />
          <Toggle
            label={t.clean.retainedWorktrees}
            note={t.clean.retainedWorktreesNote}
            checked={options.worktrees === true}
            onChange={(worktrees) => change({ worktrees })}
          />
          <Toggle
            label={t.clean.unmergedBranches}
            note={t.clean.unmergedBranchesNote}
            danger
            checked={options.branches === true}
            onChange={(branches) => change({ branches })}
          />
        </div>

        <div className="clean-actions">
          <button type="button" className="btn btn--primary" onClick={() => void run(true)} disabled={busy !== undefined}>
            {busy === 'preview' ? t.clean.looking : t.clean.showWhatWouldGo}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void run(false)}
            disabled={plan === undefined || busy !== undefined}
            title={plan === undefined ? t.clean.previewFirst : undefined}
          >
            {busy === 'apply' ? t.clean.reclaiming : t.clean.reclaimIt}
          </button>
        </div>
      </section>

      {refusal === undefined ? null : (
        <Notice tone="bad" k={refusal.code ?? t.common.refused}>
          {refusal.message}
          {refusal.action === undefined ? '' : ` ${refusal.action}`}
        </Notice>
      )}

      {shown === undefined ? null : <Plan report={shown} />}
    </main>
  );
}

function Toggle({
  label,
  note,
  checked,
  danger = false,
  onChange,
}: {
  label: string;
  note: string;
  checked: boolean;
  danger?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="clean-toggle" data-danger={danger ? 'true' : undefined}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <b>{label}</b>
        <small className="doctor-note">{note}</small>
      </span>
    </label>
  );
}

/** The plan, or the receipt. Same shape, and the heading is the only difference. */
function Plan({ report }: { report: CleanView }) {
  const t = useT();
  const nothing = report.runs.length === 0 && !report.cacheRemoved;

  return (
    <section className="doctor-section" aria-label={report.dryRun ? t.clean.whatWouldGo : t.clean.whatWent}>
      <div className="doctor-section__head">
        <h2>{report.dryRun ? t.clean.whatWouldGo : t.clean.whatWent}</h2>
        <p className="doctor-note">{t.clean.onDiskKeeping(report.totalRuns, report.keep)}</p>
      </div>

      {nothing ? (
        <Notice tone="idle" k={t.clean.nothingToRemoveKey}>
          {t.clean.nothingToRemove}
        </Notice>
      ) : null}

      <ul className="doctor-list">
        {report.runs.map((run) => (
          <RunRow key={run.runId} run={run} dryRun={report.dryRun} />
        ))}
      </ul>

      {report.cacheRemoved ? (
        <p className="doctor-finding" data-tone="idle">
          <Chip tone="idle">{t.clean.cacheKey}</Chip> {report.dryRun ? t.clean.cacheWouldGo : t.clean.cacheWent}
        </p>
      ) : null}

      {report.protectedRun === undefined ? null : (
        <Notice tone="warn" k={t.clean.keptKey}>
          <b>{report.protectedRun}</b> {t.clean.activeRunKept}
        </Notice>
      )}

      {report.refused ? (
        <Notice tone="bad" k={t.common.refused}>
          {t.clean.refusedNotice}
        </Notice>
      ) : null}
    </section>
  );
}

const OUTCOME: Record<CleanRunView['outcome'], { tone: Tone; label: (t: Dictionary) => string }> = {
  locked: { tone: 'warn', label: (t) => t.clean.beingExecuted },
  namespace_failed: { tone: 'bad', label: (t) => t.clean.kept },
  removed: { tone: 'ok', label: (t) => t.clean.removed },
};

function RunRow({ run, dryRun }: { run: CleanRunView; dryRun: boolean }) {
  const t = useT();
  const outcome = OUTCOME[run.outcome];
  const reclaim = run.reclaim;
  const branch = reclaim?.integrationBranch;

  const detail: string[] = [];
  if (run.outcome === 'locked') detail.push(t.clean.somebodyExecuting);
  if (reclaim !== undefined) {
    if (reclaim.worktrees.length > 0) {
      detail.push(t.clean.worktreeCount(reclaim.worktrees.length));
    }
    if (reclaim.attemptRefs.length > 0) {
      detail.push(t.clean.attemptRefCount(reclaim.attemptRefs.length));
    }
    if (reclaim.worktreesRetained.length > 0) {
      detail.push(t.clean.worktreesRetained(reclaim.worktreesRetained.length));
    }
    if (branch?.kind === 'redundant') detail.push(t.clean.branchRedundant(String(branch.ref), String(branch.mergedInto)));
    if (branch?.kind === 'forced') detail.push(t.clean.branchForced(String(branch.ref)));
    if (branch?.kind === 'kept') detail.push(t.clean.branchKept(String(branch.ref)));
    for (const failure of reclaim.failures) detail.push(failure);
  }

  return (
    <li className="doctor-row" data-run={run.runId} data-outcome={run.outcome}>
      <span className="doctor-row__name">{run.runId}</span>
      <span className="doctor-row__value">{detail.length === 0 ? t.clean.stateOnly : detail.join(' · ')}</span>
      <Chip tone={outcome.tone}>
        {run.outcome === 'removed' && dryRun ? t.clean.wouldGo : outcome.label(t)}
      </Chip>
    </li>
  );
}
