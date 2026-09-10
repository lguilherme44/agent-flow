import { useEffect, useRef, useState } from 'react';
import type { ApprovalGateView } from '@contracts/index.js';
import { ApiError, api, type RunAddress } from '../../lib/api';
import { invalidate } from '../../lib/store';
import { severityTone } from '../../lib/tone';
import { useT, word } from '../../lib/i18n';
import { Chip, Notice } from '../../components/ui';

/**
 * The approval gate.
 *
 * Shows what the server computed for this plan — the verdict, its findings, the
 * degradations, the hash of the plan on disk — and offers the three things a person can
 * do about it. The approve request carries no hash: the use case reads the plan and hashes
 * it itself, so there is no version of this call that approves a plan nobody read.
 *
 * Refusals are the server's. When the gate says no, Approve is disabled — unless the server
 * also says the refusal is forcible, and then a second, separate button says what forcing
 * means. Forcing is recorded on the run as a degradation.
 */
export function GateDialog({ address, gate, open, onClose, initialTab = 'decide' }: { address: RunAddress; gate: ApprovalGateView | undefined; open: boolean; onClose: () => void; initialTab?: 'decide' | 'revise' }) {
  const ref = useRef<HTMLDialogElement>(null);
  const t = useT();
  const [tab, setTab] = useState<'decide' | 'revise'>(initialTab);
  const [reason, setReason] = useState('');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [outcome, setOutcome] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | undefined>(undefined);
  const [confirmForce, setConfirmForce] = useState(false);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab, open]);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const done = (): void => {
    invalidate((key) => key.includes(`/runs/${address.runId}`) || key.includes('/workspace'));
  };

  const act = async (what: string, call: () => Promise<unknown>, success: string): Promise<void> => {
    setBusy(what);
    setOutcome(undefined);
    try {
      await call();
      setOutcome({ tone: 'ok', text: success });
      done();
    } catch (error) {
      if (error instanceof ApiError) {
        setOutcome({ tone: error.forcible ? 'warn' : 'bad', text: `${error.message}${error.action === undefined ? '' : ` ${error.action}`}` });
      } else {
        setOutcome({ tone: 'bad', text: String(error) });
      }
    } finally {
      setBusy(undefined);
    }
  };

  const review = gate?.review;
  const canForce = gate?.refusal?.forcible === true && gate.canApprove === false;

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="gate-title">
      <div className="dialog__head">
        <h2 id="gate-title" className="dialog__title">
          {t.gate.title(address.runId)}
        </h2>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} aria-label={t.common.close}>
          Esc
        </button>
      </div>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" className="tab" aria-selected={tab === 'decide'} onClick={() => setTab('decide')}>
          {t.gate.decide}
        </button>
        <button type="button" role="tab" className="tab" aria-selected={tab === 'revise'} onClick={() => setTab('revise')}>
          {t.gate.askRevision}
        </button>
      </div>

      <div className="dialog__body">
        {gate === undefined ? (
          <p className="muted">{t.gate.couldNotRead}</p>
        ) : tab === 'decide' ? (
          <>
            <div className="facts-grid" style={{ marginTop: 0 }}>
              <div className="fact">
                <span className="fact__k">{t.gate.planHash}</span>
                <span className="fact__v">{gate.planHash}</span>
              </div>
              <div className="fact">
                <span className="fact__k">{t.gate.tasks}</span>
                <span className="fact__v">{gate.taskCount}</span>
              </div>
              <div className="fact">
                <span className="fact__k">{t.gate.sddDigest}</span>
                <span className="fact__v">{gate.sddDigest ?? t.common.none}</span>
              </div>
              <div className="fact">
                <span className="fact__k">{t.gate.gate}</span>
                <span className="fact__v" data-tone={gate.approved ? 'ok' : gate.canApprove ? 'warn' : 'bad'}>
                  {gate.approved ? word(t, 'approved') : gate.canApprove ? t.gate.open : t.gate.refusedBecause(word(t, gate.refusal?.kind))}
                </span>
              </div>
            </div>

            {review === undefined ? (
              <Notice tone="ghost" k={t.gate.reviewKey}>
                {t.gate.noPlanReview}
              </Notice>
            ) : (
              <div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                  <Chip tone={review.verdict === 'approved' || review.verdict === 'approve' ? 'ok' : 'bad'}>{word(t, review.verdict)}</Chip>
                  <Chip tone="idle" plain>
                    {t.gate.independence(review.independence)}
                  </Chip>
                  <Chip tone={review.coversThisPlan ? 'ok' : 'warn'} plain>
                    {review.coversThisPlan ? t.gate.coversThisPlan : t.gate.olderPlan}
                  </Chip>
                  <Chip tone={review.freshness === 'current' ? 'ok' : review.freshness === 'stale' ? 'warn' : 'ghost'} plain>
                    {word(t, review.freshness)}
                  </Chip>
                </div>
                {review.findings.length === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>
                    {t.gate.noFindings}
                  </p>
                ) : (
                  <div>
                    {review.findings.map((finding, index) => {
                      const severity = String((finding as { severity?: string }).severity ?? 'note');
                      const text = String((finding as { description?: string; message?: string }).description ?? (finding as { message?: string }).message ?? '');
                      return (
                        <div key={index} className="finding" data-tone={severityTone(severity)}>
                          <span className="finding__sev">{severity}</span>
                          <span className="finding__text">{text}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {gate.warnings.length > 0 ? (
              <div>
                <span className="eyebrow">{t.gate.beforeYouDecide}</span>
                <ul className="warnlist" style={{ marginTop: 6 }}>
                  {gate.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {gate.degradations.length > 0 ? (
              <div>
                <span className="eyebrow">{t.gate.degradations}</span>
                <ul className="warnlist" style={{ marginTop: 6 }}>
                  {gate.degradations.map((degradation, index) => (
                    <li key={index}>
                      <b>{word(t, degradation.kind)}</b> — {degradation.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <label style={{ display: 'grid', gap: 6 }}>
              <span className="eyebrow">{t.gate.reasonIfRejecting}</span>
              <textarea className="textarea" value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t.gate.reasonPlaceholder} />
            </label>
          </>
        ) : (
          <label style={{ display: 'grid', gap: 6 }}>
            <span className="eyebrow">{t.gate.whatShouldChange}</span>
            <textarea className="textarea" value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={t.gate.instructionPlaceholder} style={{ minHeight: 140 }} />
          </label>
        )}

        {outcome === undefined ? null : (
          <Notice tone={outcome.tone} k={outcome.tone === 'ok' ? t.gate.done : t.common.refused}>
            {outcome.text}
          </Notice>
        )}
      </div>

      <div className="dialog__foot">
        {tab === 'decide' ? (
          <>
            <button type="button" className="btn btn--danger" disabled={busy !== undefined || gate === undefined || gate.approved} onClick={() => void act('reject', () => api.reject(address, reason), t.gate.rejected)}>
              {busy === 'reject' ? t.gate.rejecting : t.gate.reject}
            </button>
            {canForce ? (
              confirmForce ? (
                <button type="button" className="btn btn--danger" disabled={busy !== undefined} onClick={() => void act('force', () => api.approve(address, true), t.gate.forcedOk)}>
                  {busy === 'force' ? t.gate.forcing : t.gate.forceConfirm}
                </button>
              ) : (
                <button type="button" className="btn" disabled={busy !== undefined} onClick={() => setConfirmForce(true)}>
                  {t.gate.approveAnyway}
                </button>
              )
            ) : null}
            <button type="button" className="btn btn--primary" disabled={busy !== undefined || gate === undefined || !gate.canApprove || gate.approved} onClick={() => void act('approve', () => api.approve(address, false), t.gate.approvedOk)}>
              {busy === 'approve' ? t.gate.approving : t.gate.approvePlan}
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--primary" disabled={busy !== undefined || instruction.trim().length === 0} onClick={() => void act('revise', () => api.revise(address, instruction.trim()), t.gate.revisionAsked)}>
            {busy === 'revise' ? t.gate.asking : t.gate.sendForRevision}
          </button>
        )}
      </div>
    </dialog>
  );
}
