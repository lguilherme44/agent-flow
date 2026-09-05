import { useEffect, useRef, useState } from 'react';
import type { ApprovalGateView } from '@contracts/index.js';
import { ApiError, api, type RunAddress } from '../../lib/api';
import { invalidate } from '../../lib/store';
import { words } from '../../lib/tone';
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
          Approval gate · {address.runId}
        </h2>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} aria-label="Close">
          Esc
        </button>
      </div>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" className="tab" aria-selected={tab === 'decide'} onClick={() => setTab('decide')}>
          Decide
        </button>
        <button type="button" role="tab" className="tab" aria-selected={tab === 'revise'} onClick={() => setTab('revise')}>
          Ask for a revision
        </button>
      </div>

      <div className="dialog__body">
        {gate === undefined ? (
          <p className="muted">The gate could not be read for this run.</p>
        ) : tab === 'decide' ? (
          <>
            <div className="facts-grid" style={{ marginTop: 0 }}>
              <div className="fact">
                <span className="fact__k">plan hash</span>
                <span className="fact__v">{gate.planHash}</span>
              </div>
              <div className="fact">
                <span className="fact__k">tasks</span>
                <span className="fact__v">{gate.taskCount}</span>
              </div>
              <div className="fact">
                <span className="fact__k">sdd digest</span>
                <span className="fact__v">{gate.sddDigest ?? '—'}</span>
              </div>
              <div className="fact">
                <span className="fact__k">gate</span>
                <span className="fact__v" data-tone={gate.approved ? 'ok' : gate.canApprove ? 'warn' : 'bad'}>
                  {gate.approved ? 'approved' : gate.canApprove ? 'open' : `refused · ${words(gate.refusal?.kind)}`}
                </span>
              </div>
            </div>

            {review === undefined ? (
              <Notice tone="ghost" k="review">
                No plan review exists for this plan.
              </Notice>
            ) : (
              <div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                  <Chip tone={review.verdict === 'approved' || review.verdict === 'approve' ? 'ok' : 'bad'}>{words(review.verdict)}</Chip>
                  <Chip tone="idle" plain>
                    {words(review.independence)}
                  </Chip>
                  <Chip tone={review.coversThisPlan ? 'ok' : 'warn'} plain>
                    {review.coversThisPlan ? 'covers this plan' : 'about an older plan'}
                  </Chip>
                  <Chip tone={review.freshness === 'current' ? 'ok' : review.freshness === 'stale' ? 'warn' : 'ghost'} plain>
                    {review.freshness}
                  </Chip>
                </div>
                {review.findings.length === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>
                    No findings.
                  </p>
                ) : (
                  <div>
                    {review.findings.map((finding, index) => {
                      const severity = String((finding as { severity?: string }).severity ?? 'note');
                      const text = String((finding as { description?: string; message?: string }).description ?? (finding as { message?: string }).message ?? '');
                      return (
                        <div key={index} className="finding" data-tone={severity === 'critical' || severity === 'high' ? 'bad' : severity === 'medium' ? 'warn' : 'idle'}>
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
                <span className="eyebrow">Before you decide</span>
                <ul className="warnlist" style={{ marginTop: 6 }}>
                  {gate.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {gate.degradations.length > 0 ? (
              <div>
                <span className="eyebrow">Degradations on this run</span>
                <ul className="warnlist" style={{ marginTop: 6 }}>
                  {gate.degradations.map((degradation, index) => (
                    <li key={index}>
                      <b>{words(degradation.kind)}</b> — {degradation.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <label style={{ display: 'grid', gap: 6 }}>
              <span className="eyebrow">Reason, if rejecting</span>
              <textarea className="textarea" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Optional. Recorded on the run." />
            </label>
          </>
        ) : (
          <label style={{ display: 'grid', gap: 6 }}>
            <span className="eyebrow">What should change</span>
            <textarea className="textarea" value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Free text for the planner. Invalidates any approval first, and spends one of the run's revision cycles." style={{ minHeight: 140 }} />
          </label>
        )}

        {outcome === undefined ? null : (
          <Notice tone={outcome.tone} k={outcome.tone === 'ok' ? 'done' : 'refused'}>
            {outcome.text}
          </Notice>
        )}
      </div>

      <div className="dialog__foot">
        {tab === 'decide' ? (
          <>
            <button type="button" className="btn btn--danger" disabled={busy !== undefined || gate === undefined || gate.approved} onClick={() => void act('reject', () => api.reject(address, reason), 'Rejected. The run is closed; its artifacts stay.')}>
              {busy === 'reject' ? 'Rejecting…' : 'Reject'}
            </button>
            {canForce ? (
              confirmForce ? (
                <button type="button" className="btn btn--danger" disabled={busy !== undefined} onClick={() => void act('force', () => api.approve(address, true), 'Approved over the refusal. Recorded as a forced approval.')}>
                  {busy === 'force' ? 'Forcing…' : 'Yes, force it — recorded as a degradation'}
                </button>
              ) : (
                <button type="button" className="btn" disabled={busy !== undefined} onClick={() => setConfirmForce(true)}>
                  Approve anyway…
                </button>
              )
            ) : null}
            <button type="button" className="btn btn--primary" disabled={busy !== undefined || gate === undefined || !gate.canApprove || gate.approved} onClick={() => void act('approve', () => api.approve(address, false), 'Approved. The gate is open for this plan.')}>
              {busy === 'approve' ? 'Approving…' : 'Approve plan'}
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--primary" disabled={busy !== undefined || instruction.trim().length === 0} onClick={() => void act('revise', () => api.revise(address, instruction.trim()), 'Asked. Re-planning runs as a job; progress arrives on the recorder.')}>
            {busy === 'revise' ? 'Asking…' : 'Send for revision'}
          </button>
        )}
      </div>
    </dialog>
  );
}
