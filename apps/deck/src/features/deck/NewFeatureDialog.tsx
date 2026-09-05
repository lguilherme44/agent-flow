import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectView, WorkspaceProjectView } from '@contracts/index.js';
import { ApiError, api } from '../../lib/api';
import { invalidate } from '../../lib/store';
import { words } from '../../lib/tone';
import { Notice } from '../../components/ui';
import { href, navigate } from '../../app/router';

/**
 * `agent-flow feature "<description>"`, from the page.
 *
 * One sentence of intent becomes a run. The server creates it before answering — same
 * preflight, same Git identity as the CLI — and planning proceeds as a job, so the page
 * can open the new run and watch discovery, impact, SDD, plan and review arrive on the
 * recorder. Nothing is implemented before a person approves; the dialog says so, because
 * the first time somebody sees a planner spend five model calls they should know why.
 *
 * The one thing it warns about is a project that already has a run in flight: a new
 * feature becomes the project's current run, and the CLI's `approve`, `run` and `status`
 * follow the current run. The old one stays on disk and in History. Said before the click
 * rather than discovered after it.
 */
const WORKFLOWS = ['trivial', 'simple', 'standard', 'high-risk'] as const;
const STILL = new Set(['complete', 'failed', 'cancelled']);

export function NewFeatureDialog({
  open,
  onClose,
  projects,
  rows,
  initialProjectId,
}: {
  open: boolean;
  onClose: () => void;
  projects: readonly ProjectView[];
  rows: readonly WorkspaceProjectView[];
  initialProjectId?: string | undefined;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? projects[0]?.id ?? '');
  const [description, setDescription] = useState('');
  const [workflow, setWorkflow] = useState<string>('');
  const [skipReview, setSkipReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ApiError | undefined>(undefined);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (open) {
      setProjectId(initialProjectId ?? projects[0]?.id ?? '');
      setRefusal(undefined);
    }
  }, [open, initialProjectId, projects]);

  const row = useMemo(() => rows.find((entry) => entry.projectId === projectId), [rows, projectId]);
  const project = useMemo(() => projects.find((entry) => entry.id === projectId), [projects, projectId]);
  const inFlight = row?.runId !== undefined && row.runtime !== undefined && !STILL.has(row.runtime);
  const ready = projectId !== '' && description.trim().length > 0 && !busy;

  const submit = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    setRefusal(undefined);
    try {
      const job = await api.plan(projectId, {
        description: description.trim(),
        ...(workflow === '' ? {} : { workflow }),
        ...(skipReview ? { skipReview: true } : {}),
      });
      invalidate((key) => key.includes('/workspace') || key.includes('/projects') || /\/runs(\?|$)/.test(key));
      setDescription('');
      onClose();
      navigate(href({ name: 'run', projectId, runId: job.runId }));
    } catch (error) {
      setRefusal(error instanceof ApiError ? error : new ApiError(0, String(error)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="new-feature-title">
      <div className="dialog__head">
        <h2 id="new-feature-title" className="dialog__title">
          New feature
        </h2>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} aria-label="Close">
          Esc
        </button>
      </div>

      <form
        className="dialog__body"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {projects.length > 1 ? (
          <label className="field">
            <span className="eyebrow">Project</span>
            <select className="input select" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {projects.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                  {entry.stack === undefined ? '' : ` · ${entry.stack}`}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="field">
            <span className="eyebrow">Project</span>
            <span className="mono">{project?.name ?? projectId}</span>
          </div>
        )}

        {inFlight && row !== undefined ? (
          <Notice tone="warn" k="in flight">
            <b>{row.runId}</b> is this project&apos;s current run ({words(row.runtime)}). A new feature becomes the
            current run, which is what <code>approve</code>, <code>run</code> and <code>status</code> follow. The old run
            stays on disk and in History.
          </Notice>
        ) : null}

        <label className="field">
          <span className="eyebrow">What should it do</span>
          <textarea
            className="textarea"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="A sentence is enough; a paragraph is better. Name the behaviour, the files if you know them, and what must not change."
            style={{ minHeight: 160 }}
            maxLength={8000}
            autoFocus
          />
          <span className="faint" style={{ fontSize: 11, textAlign: 'right' }}>
            {description.trim().length}/8000
          </span>
        </label>

        <div className="field-row">
          <label className="field">
            <span className="eyebrow">Workflow</span>
            <select className="input select" value={workflow} onChange={(event) => setWorkflow(event.target.value)}>
              <option value="">let the classifier decide</option>
              {WORKFLOWS.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 8 }}>
            <input type="checkbox" checked={skipReview} onChange={(event) => setSkipReview(event.target.checked)} />
            <span className="muted" style={{ fontSize: 12 }}>
              stop before the plan review
            </span>
          </label>
        </div>

        <p className="faint" style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}>
          Planning spends model calls — discovery, impact, SDD, plan, review — and stops at a plan.
          Nothing is implemented before you approve it. The same use case <code>agent-flow feature</code> runs.
        </p>

        {refusal === undefined ? null : (
          <Notice tone="bad" k={refusal.code ?? 'refused'}>
            {refusal.message}
            {refusal.action === undefined ? '' : ` ${refusal.action}`}
          </Notice>
        )}

        <div className="dialog__foot" style={{ padding: 0, borderTop: 'none' }}>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={!ready}>
            {busy ? 'Creating the run…' : 'Plan it'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
