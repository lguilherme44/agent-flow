import { useEffect, useRef } from 'react';
import { useT } from '../../lib/i18n';

/**
 * The one action on this page that cannot be undone by doing the opposite.
 *
 * Pause is answered by resume and retry by another retry; cancel is terminal, and it sits
 * in a row of buttons where every other one is reversible. So it stops and asks — a native
 * `<dialog>`, which is what the gate uses: the browser traps focus and `Esc` closes,
 * neither of which is worth reimplementing.
 *
 * What it says is what survives, not "are you sure". A person hesitating over this button
 * is asking whether the work is lost, and the answer is no: the evidence, the integration
 * branch and the worktrees stay exactly where they are.
 */
export function ConfirmCancel({ runId, open, onDismiss, onConfirm }: {
  readonly runId: string;
  readonly open: boolean;
  readonly onDismiss: () => void;
  readonly onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const t = useT();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={ref} className="dialog" onClose={onDismiss} aria-labelledby="cancel-title">
      <h2 id="cancel-title" className="dialog__title">{t.cancelRun.title(runId)}</h2>
      <p>{t.cancelRun.what}</p>
      <p className="faint">{t.cancelRun.survives}</p>
      <div className="dialog__actions">
        <button type="button" className="btn" onClick={onDismiss}>{t.cancelRun.keep}</button>
        <button type="button" className="btn btn--danger" onClick={onConfirm}>{t.cancelRun.confirm}</button>
      </div>
    </dialog>
  );
}
