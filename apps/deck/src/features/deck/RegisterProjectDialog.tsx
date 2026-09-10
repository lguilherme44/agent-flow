import { useEffect, useRef, useState } from 'react';
import type { ProjectCandidateView, ProjectRegisteredView } from '@contracts/index.js';
import { ApiError, api, keys } from '../../lib/api';
import { invalidate, useResource } from '../../lib/store';
import { Notice } from '../../components/ui';
import { useT, word } from '../../lib/i18n';

/**
 * `agent-flow init`, from the page (7.6).
 *
 * The button for this existed, disabled, since §68, and the note beside it said adding a
 * project "means writing to the registry, and no route does". That was the wrong diagnosis
 * of the right obstacle: the registry is a walk, not a file, and what was missing was an
 * *id* — every endpoint names a project by an id the server issued (§93), and a directory
 * with no `.agent-flow/` had none. So this dialog offers only what the server's own walk
 * found, by id, and cannot name a directory even if somebody edits the request by hand.
 *
 * It writes into a repository the operator cares about, so it says what it will write
 * before it writes it, never overwrites without being told to (§7.7), and reports the two
 * findings that decide whether the first feature will work at all.
 */
export function RegisterProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const t = useT();
  const candidates = useResource<ProjectCandidateView[]>(
    open ? keys.projectCandidates() : null,
    api.projectCandidates,
  );
  const [candidateId, setCandidateId] = useState('');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ApiError | undefined>(undefined);
  const [done, setDone] = useState<ProjectRegisteredView | undefined>(undefined);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (open) {
      setRefusal(undefined);
      setDone(undefined);
      setForce(false);
    }
  }, [open]);

  const list = candidates.data ?? [];
  const selected = candidateId === '' ? list[0]?.id : candidateId;
  const ready = selected !== undefined && !busy;

  const submit = async (): Promise<void> => {
    if (selected === undefined || busy) return;
    setBusy(true);
    setRefusal(undefined);
    try {
      const registered = await api.registerProject(selected, force);
      // Everything that lists projects is now wrong, including the candidate list this
      // dialog is reading: the one just registered is a project and no longer a candidate.
      invalidate(
        (key) =>
          key.includes('/projects') || key.includes('/workspace') || key.includes('/doctor'),
      );
      setDone(registered);
    } catch (error) {
      setRefusal(error instanceof ApiError ? error : new ApiError(0, String(error)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="register-project-title">
      <div className="dialog__head">
        <h2 id="register-project-title" className="dialog__title">
          {t.register.title}
        </h2>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} aria-label={t.common.close}>
          Esc
        </button>
      </div>

      {done !== undefined ? (
        <div className="dialog__body">
          <Notice tone="ok" k={t.register.registeredKey}>
            <b>{done.project.name}</b> {t.register.isAProjectNow(done.stack.type)}
          </Notice>

          <ul className="doctor-paths">
            {done.created.map((path) => (
              <li key={path}>
                {t.register.created} <code>{path}</code>
              </li>
            ))}
            {done.updated.map((path) => (
              <li key={path}>
                {t.register.updated} <code>{path}</code>
              </li>
            ))}
            {done.skipped.map((path) => (
              <li key={path}>
                {t.register.kept} <code>{path}</code> {t.register.alreadyExisted}
              </li>
            ))}
          </ul>

          {done.warnings.map((warning) => (
            <Notice key={warning.kind} tone="warn" k={word(t, warning.kind)}>
              {warning.kind === 'install_dirties_tree' ? (
                <>
                  <code>{warning.command}</code> {t.register.installDirties}
                </>
              ) : null}
              {warning.kind === 'no_validation_commands' ? (
                <>
                  {t.register.noValidationBefore}<code>.agent-flow/config.yaml</code>
                  {t.register.noValidationAfter}
                </>
              ) : null}
              {warning.kind === 'active_run' ? (
                <>
                  {t.register.activeRunBefore}<b>{warning.runId}</b>
                  {t.register.activeRunAfter(word(t, warning.status))}
                </>
              ) : null}
            </Notice>
          ))}

          <p className="faint" style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}>
            {t.register.commitFirst}
          </p>

          <div className="dialog__foot" style={{ padding: 0, borderTop: 'none' }}>
            <button type="button" className="btn btn--primary" onClick={onClose}>
              {t.register.done}
            </button>
          </div>
        </div>
      ) : (
        <form
          className="dialog__body"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {candidates.loading ? (
            <p className="faint">{t.deck.readingWorkspace}</p>
          ) : list.length === 0 ? (
            <Notice tone="idle" k={t.register.nothingToAddKey}>
              {t.register.nothingToAdd}
            </Notice>
          ) : (
            <label className="field">
              <span className="eyebrow">{t.register.repository}</span>
              <select
                className="input select"
                value={selected ?? ''}
                onChange={(event) => setCandidateId(event.target.value)}
              >
                {list.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <p className="faint" style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}>
            {t.register.whatItWritesBefore}
            <code>.agent-flow/config.yaml</code>, <code>AGENTS.md</code>, <code>.gitignore</code>
            {t.register.whatItWritesAfter}
          </p>

          {refusal === undefined ? null : (
            <Notice tone="bad" k={refusal.code ?? 'refused'}>
              {refusal.message}
              {refusal.action === undefined ? '' : ` ${refusal.action}`}
            </Notice>
          )}

          {refusal?.forcible === true ? (
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
              <span className="muted" style={{ fontSize: 12 }}>
                {t.register.proceedAnyway}
              </span>
            </label>
          ) : null}

          <div className="dialog__foot" style={{ padding: 0, borderTop: 'none' }}>
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
              {t.common.cancel}
            </button>
            <button type="submit" className="btn btn--primary" disabled={!ready}>
              {busy ? t.register.writing : t.register.registerIt}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
