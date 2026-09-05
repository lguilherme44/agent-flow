import { useState, useMemo, useEffect } from 'react';
import {
  AlertTriangle,
  Check,
  Coins,
  Loader2,
  Play,
  Pencil,
  X,
} from 'lucide-react';
import type { ActionJobView, ApprovalGateView, RunDetailView } from '@contracts/index.js';
import {
  ActionRefusal,
  Badge,
  Button,
  Dialog,
  Tooltip,
  cx,
} from '../components/ui';
import {
  useActiveJob,
  useApprovalGate,
  useApprove,
  useReject,
  useRevise,
  useStart,
} from '../lib/mutations';
import { useArtifact } from '../lib/queries';
import { formatWhen, humanise } from '../lib/format';
import { formatPlanReviewVerdict } from '../lib/status';
import { reviewFreshnessBadge } from '../lib/review-freshness';
import { StructuredPlanView } from '../components/StructuredPlanView';
import { useI18n } from '../lib/i18n/i18n-context';

/**
 * The actions on a run (UI-27, §90, §91).
 *
 * Every one of them is a request to the server, and none of them is a state change
 * this component performs. The button says what it asked for; what the run *is*
 * comes back from re-reading it. That distinction is the reason nothing here keeps
 * a copy of `RunState`, and the reason a refused approval leaves the screen showing
 * exactly what it showed before — because nothing changed.
 *
 * Which actions exist depends on where the run is, and deliberately so: a Start
 * button on an unapproved plan is a button whose only outcome is a refusal, and
 * offering it teaches people to ignore the gate rather than to use it.
 */
export function RunActions(props: {
  projectId: string | undefined;
  run: RunDetailView;
}): JSX.Element {
  const { run } = props;
  const [dialog, setDialog] = useState<'approve' | 'revise' | 'reject' | undefined>(undefined);
  const [revisionInstruction, setRevisionInstruction] = useState<string>('');

  const job = useActiveJob(props.projectId, run.runId);
  const start = useStart(props.projectId, run.runId);

  const active = job.data ?? undefined;
  const busy = active !== undefined;

  const terminal = run.status === 'completed' || run.status === 'plan_rejected' || run.status === 'failed';
  // `resumable` (C-19) is the DAG's own answer to "is there executable work right
  // now", and it is stricter than `!terminal && progress < 100`: a run whose only
  // incomplete task sits in `review_required` is neither terminal nor at 100%, but
  // nothing in it is ready to run, and offering Resume there sends a person to a
  // task that needs a decision, not a restart. `approved` stays a separate check —
  // the gate is a human's, and the DAG does not know whether it has been cleared.
  const canStart = run.approved && run.runtime.resumable;
  const isWaitingApproval = run.status === 'waiting_for_approval';
  const isPlanning = run.status === 'running' && !run.approved;

  return (
    <div className="flex items-center gap-1.5">
      {busy ? (
        <JobIndicator job={active} />
      ) : (
        <>
          {terminal ? null : (
            <>
              <Button
                onClick={() => {
                  setRevisionInstruction('');
                  setDialog('revise');
                }}
                title="Ask for a different plan"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
                <span className="sr-only wide:not-sr-only">Revise</span>
              </Button>

              {run.approved ? null : (
                <Button
                  onClick={() => {
                    setDialog('reject');
                  }}
                  title="Close this run without implementing it"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                  <span className="sr-only wide:not-sr-only">Reject</span>
                </Button>
              )}
            </>
          )}

          {canStart ? (
            <Button
              variant="primary"
              disabled={start.isPending}
              onClick={() => {
                start.mutate({});
              }}
            >
              <Play className="h-3.5 w-3.5" aria-hidden />
              {run.progress > 0 ? 'Resume run' : 'Start run'}
            </Button>
          ) : terminal || run.approved ? null : isWaitingApproval ? (
            <Button
              variant="primary"
              onClick={() => {
                setDialog('approve');
              }}
            >
              Review &amp; approve
            </Button>
          ) : isPlanning ? (
            <Button
              variant="surface"
              disabled
              title={`Planning stage in progress: ${run.stage ?? 'planning'}`}
              className="cursor-not-allowed opacity-80"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
              Planning in progress…
            </Button>
          ) : null}
        </>
      )}

      {/* A refused start is reported where the button is, not swallowed. The gates
          live in the use case, so the 202 only means "asked" — a refusal comes back
          from the job, and a transport failure comes back from here. */}
      {start.error === null ? null : (
        <div className="absolute right-page top-16 z-30 w-[min(420px,80vw)]">
          <ActionRefusal error={start.error} title="Could not start:" />
        </div>
      )}

      <ApprovalDialog
        open={dialog === 'approve'}
        projectId={props.projectId}
        run={run}
        onClose={() => {
          setDialog(undefined);
        }}
        onRevise={(inst?: string) => {
          setRevisionInstruction(inst ?? '');
          setDialog('revise');
        }}
      />

      <RevisionDialog
        open={dialog === 'revise'}
        projectId={props.projectId}
        runId={run.runId}
        approved={run.approved}
        initialInstruction={revisionInstruction}
        onClose={() => {
          setDialog(undefined);
        }}
      />

      <RejectDialog
        open={dialog === 'reject'}
        projectId={props.projectId}
        runId={run.runId}
        onClose={() => {
          setDialog(undefined);
        }}
      />
    </div>
  );
}

/**
 * A long action in flight.
 *
 * The job's own outcome, not the run's: a gate the workflow refused never touched
 * `state.json`, so it would never reach the stream and the screen would sit there
 * looking like nothing had happened.
 */
export function ReviewGateButton(props: {
  projectId: string | undefined;
  run: RunDetailView;
  label?: string;
  variant?: 'primary' | 'surface';
}): JSX.Element {
  const { t } = useI18n();
  const [dialog, setDialog] = useState<'approve' | 'revise' | undefined>(undefined);
  const [revisionInstruction, setRevisionInstruction] = useState<string>('');

  const isWaiting = props.run.status === 'waiting_for_approval';

  return (
    <>
      <Button
        variant={props.variant ?? 'primary'}
        size="sm"
        disabled={!isWaiting}
        onClick={() => {
          setDialog('approve');
        }}
      >
        {props.label ?? t.common.approve}
      </Button>

      <ApprovalDialog
        open={dialog === 'approve'}
        projectId={props.projectId}
        run={props.run}
        onClose={() => {
          setDialog(undefined);
        }}
        onRevise={(inst?: string) => {
          setRevisionInstruction(inst ?? '');
          setDialog('revise');
        }}
      />
      <RevisionDialog
        open={dialog === 'revise'}
        projectId={props.projectId}
        runId={props.run.runId}
        approved={props.run.approved}
        initialInstruction={revisionInstruction}
        onClose={() => {
          setDialog(undefined);
        }}
      />
    </>
  );
}

function JobIndicator(props: { job: ActionJobView }): JSX.Element {
  const { job } = props;

  return (
    <Tooltip
      content={
        <span>
          {job.kind === 'start' ? 'Executing the plan' : job.kind === 'review' ? 'Reviewing the result' : job.kind === 'plan' ? 'Planning' : 'Re-planning'} since{' '}
          {formatWhen(job.startedAt)}. Progress appears as the run records it.
        </span>
      }
    >
      <span className="flex h-7 items-center gap-1.5 rounded-sm border border-primary-border bg-primary-soft px-2.5 text-body-lg text-text">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary-bright" aria-hidden />
        {job.kind === 'start' ? 'Running…' : job.kind === 'review' ? 'Reviewing…' : job.kind === 'plan' ? 'Planning…' : 'Re-planning…'}
      </span>
    </Tooltip>
  );
}

/**
 * The human gate (§90).
 *
 * Shows the verdict, the findings, the degradations and the plan hash — and the
 * hash is the server's, fetched for this modal rather than carried over from the
 * page. The approve request sends no hash at all: the server reads the plan on disk
 * and hashes it, so there is no version of this dialog that could approve a plan
 * the reader did not see.
 *
 * `Approve` is disabled when the gate refuses, unless the refusal is one the server
 * says is forcible — and then the button says what forcing means rather than
 * quietly doing it. There is no `--force` here dressed up as a normal action.
 */
function ApprovalDialog(props: {
  open: boolean;
  projectId: string | undefined;
  run: RunDetailView;
  onClose: () => void;
  onRevise: (instruction?: string) => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const gate = useApprovalGate(props.projectId, props.run.runId, { enabled: props.open });
  const planArtifact = useArtifact(props.projectId, props.run.runId, 'plan', { enabled: props.open });
  const approve = useApprove(props.projectId, props.run.runId);
  const [override, setOverride] = useState(false);
  const [selectedFindings, setSelectedFindings] = useState<number[]>([]);

  const data = gate.data;
  const forcible = data?.refusal?.forcible === true;
  const blocked = data !== undefined && !data.canApprove;

  const findings = data?.review?.findings ?? [];
  const selectedFindingsInstruction = useMemo(() => {
    if (selectedFindings.length === 0) return undefined;
    const selected = selectedFindings
      .map((i) => findings[i])
      .filter((f): f is NonNullable<typeof f> => f !== undefined);
    return (
      'Please address the following review findings:\n' +
      selected
        .map(
          (f) =>
            `- [${f.severity}] ${f.description}${
              f.suggestedAction ? ` (Action: ${f.suggestedAction})` : ''
            }`,
        )
        .join('\n')
    );
  }, [selectedFindings, findings]);

  return (
    <Dialog
      open={props.open}
      onClose={() => {
        setOverride(false);
        setSelectedFindings([]);
        approve.reset();
        props.onClose();
      }}
      title={`${t.approval.dialogTitle} ${props.run.runId}`}
      description={t.approval.dialogSubtitle}
      className="w-[min(780px,94vw)]"
      footer={
        <>
          <Button
            onClick={() => {
              props.onClose();
              props.onRevise(selectedFindingsInstruction);
            }}
          >
            {locale === 'pt-BR'
              ? selectedFindings.length > 0
                ? `${t.approval.reviseButton} (${selectedFindings.length} selecionados)`
                : t.approval.reviseButton
              : selectedFindings.length > 0
                ? `Request revision (${selectedFindings.length} selected)`
                : 'Request revision'}
          </Button>
          <Button
            variant="primary"
            disabled={
              data === undefined || approve.isPending || (blocked && !(forcible && override))
            }
            onClick={() => {
              approve.mutate(
                { force: blocked && override },
                { onSuccess: () => { props.onClose(); } },
              );
            }}
          >
            {blocked && override ? 'Approve over the review' : 'Approve Plan'}
          </Button>
        </>
      }
    >
      {gate.isError ? (
        <ActionRefusal error={gate.error} title="The gate could not be read:" />
      ) : data === undefined ? (
        <p className="text-body-lg text-muted">Reading the plan and its review…</p>
      ) : (
        <GateBody
          gate={data}
          run={props.run}
          planRaw={planArtifact.data?.content}
          override={override}
          onOverrideChange={setOverride}
          selectedFindings={selectedFindings}
          onSelectedFindingsChange={setSelectedFindings}
          error={approve.error}
        />
      )}
    </Dialog>
  );
}

function GateBody(props: {
  gate: ApprovalGateView;
  run: RunDetailView;
  planRaw?: string | undefined;
  override: boolean;
  onOverrideChange: (value: boolean) => void;
  selectedFindings: number[];
  onSelectedFindingsChange: (selected: number[]) => void;
  error: unknown;
}): JSX.Element {
  const { gate, run, planRaw, selectedFindings, onSelectedFindingsChange } = props;
  const review = gate.review;
  const forcible = gate.refusal?.forcible === true;
  const verdictInfo = formatPlanReviewVerdict(review);

  // §19.2 — is the review still about the code that is there? The reviewer read
  // the integration tree at `review.integrationHead`; the run's current head is
  // `run.isolation.integrationHead`. Equal is CURRENT, differing is STALE, and
  // a review that never recorded its head cannot be verified at all.
  //
  // The badge exists only where an integration head does: a plan-only run has no
  // code for a review to have gone stale against, so its currency is carried by
  // `coversThisPlan` rather than by a freshness guess.
  // **Rendered, not derived** (M6 §59). This compared the review's head against the
  // run's, in the browser, from whichever of `planHash` and `integrationHead` it happened
  // to hold — so a stale verdict rendered as current whenever it was handed one field and
  // not the other. Identity against the integrated tree is the only thing that answers
  // freshness, and only the server knows both halves.
  const freshness = reviewFreshnessBadge(gate.review?.freshness);

  return (
    <div className="flex flex-col gap-3.5">
      {/* 1. Feature Context */}
      <div className="rounded-md border border-border bg-surface-2 px-3 py-2">
        <span className="text-micro font-medium uppercase tracking-caps text-faint">Feature Request</span>
        <p className="text-body-lg font-semibold text-text">{run.feature}</p>
      </div>

      {/* 2. Review Verdict & Badges */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={verdictInfo.tone} caps>
          {verdictInfo.fullLabel}
        </Badge>
        {verdictInfo.isPassingWithFindings ? (
          <span className="text-micro text-warning">
            ({verdictInfo.totalFindings} non-blocking finding{verdictInfo.totalFindings === 1 ? '' : 's'})
          </span>
        ) : null}
        {review?.coversThisPlan === false ? (
          <Badge tone="warning" caps>
            judged a different plan
          </Badge>
        ) : null}
        {review?.independence === 'same-provider-fresh-context' ? (
          <Badge tone="warning" caps>
            same provider
          </Badge>
        ) : null}
        {freshness === undefined ? null : (
          <Tooltip content={<span>{freshness.explanation}</span>}>
            <Badge tone={freshness.tone} caps>
              {freshness.label}
            </Badge>
          </Tooltip>
        )}
      </div>

      {/* 3. Plan Identifiers */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-border bg-surface-2 px-3 py-2.5 xl:grid-cols-4">
        <Fact label="Plan hash" value={gate.planHash} mono />
        <Fact label="SDD digest" value={gate.sddDigest ?? 'no SDD'} mono />
        <Fact label="Tasks" value={String(gate.taskCount)} />
        <Fact
          label="Reviewed plan"
          value={review?.planHash ?? 'not stated'}
          mono
          {...(review !== undefined && !review.coversThisPlan
            ? { tone: 'warning' as const }
            : {})}
        />
      </dl>

      {/* 4. Structured Plan & Tasks Preview */}
      {planRaw ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-micro uppercase tracking-caps text-faint">
            Plan &amp; Tasks Preview
          </h3>
          <div className="max-h-[260px] overflow-y-auto rounded-md border border-border bg-surface p-2.5">
            <StructuredPlanView rawContent={planRaw} />
          </div>
        </section>
      ) : null}

      {/* 5. Degradation Warnings */}
      {gate.warnings.length === 0 ? null : (
        <ul className="flex flex-col gap-1 rounded-md border border-warning/25 bg-warning-soft px-3 py-2">
          {gate.warnings.map((warning) => (
            <li key={warning} className="flex gap-2 text-body-lg text-text">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
              {warning}
            </li>
          ))}
        </ul>
      )}

      {/* 6. Review Findings (Selectable for Revision) */}
      {review === undefined || review.findings.length === 0 ? null : (
        <section className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <h3 className="text-micro uppercase tracking-caps text-faint">
              Review findings ({review.findings.length})
            </h3>
            <span className="text-micro text-muted">
              Select findings to include in revision instruction
            </span>
          </div>
          <ul className="flex flex-col divide-y divide-border">
            {review.findings.map((finding, index) => {
              const checked = selectedFindings.includes(index);
              return (
                <li
                  key={`${finding.type}:${String(index)}`}
                  className={cx(
                    'flex items-start gap-2.5 py-2 px-1 rounded transition-colors',
                    checked ? 'bg-primary-soft/40' : '',
                  )}
                >
                  <input
                    type="checkbox"
                    id={`finding-${index}`}
                    checked={checked}
                    onChange={(e) => {
                      if (e.target.checked) {
                        onSelectedFindingsChange([...selectedFindings, index]);
                      } else {
                        onSelectedFindingsChange(selectedFindings.filter((i) => i !== index));
                      }
                    }}
                    className="mt-1 h-3.5 w-3.5 rounded border-border"
                  />
                  <label htmlFor={`finding-${index}`} className="flex flex-col gap-0.5 flex-1 cursor-pointer">
                    <span className="flex items-center gap-1.5">
                      <Badge
                        tone={
                          finding.severity === 'critical' || finding.severity === 'high'
                            ? 'danger'
                            : 'warning'
                        }
                        caps
                      >
                        {finding.severity}
                      </Badge>
                      <span className="truncate text-micro text-faint">{finding.type}</span>
                    </span>
                    <span className="text-body-lg text-text">{finding.description}</span>
                    <span className="text-body-lg text-muted">→ {finding.suggestedAction}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* 6.5 Residual Risks Requiring Human Sign-off */}
      {review?.residualRisks && review.residualRisks.length > 0 ? (
        <section className="flex flex-col gap-1.5 rounded-md border border-warning/40 bg-warning-soft/30 p-3">
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-hidden />
            <h3 className="text-micro font-semibold uppercase tracking-caps text-warning">
              Residual Risks Requiring Human Sign-off ({review.residualRisks.length})
            </h3>
          </div>
          <ul className="flex flex-col gap-1 pl-5 list-disc text-body-lg text-text">
            {review.residualRisks.map((risk, idx) => (
              <li key={idx}>{risk}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 6.6 Finding Adjudications */}
      {review?.adjudications && review.adjudications.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-micro uppercase tracking-caps text-faint">
            Finding Adjudications ({review.adjudications.length})
          </h3>
          <ul className="flex flex-col gap-1.5">
            {review.adjudications.map((adj, idx) => (
              <li key={idx} className="flex items-start gap-2 rounded border border-border bg-surface-2 p-2 text-body-lg">
                <Badge
                  tone={
                    adj.decision === 'ACCEPTED'
                      ? 'success'
                      : adj.decision === 'ACCEPT_AS_RESIDUAL_RISK'
                        ? 'warning'
                        : 'danger'
                  }
                  caps
                >
                  {adj.decision}
                </Badge>
                <div className="flex flex-col flex-1">
                  <span className="text-text font-medium">Finding #{adj.findingIndex + 1}</span>
                  {adj.reason ? <span className="text-micro text-muted">{adj.reason}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 7. Resource & Model-Call Impact */}
      <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-2 p-3 text-body-lg">
        <span className="text-micro font-semibold uppercase tracking-caps text-faint flex items-center gap-1">
          <Coins className="h-3 w-3 text-primary" aria-hidden />
          Resource &amp; Model-Call Impact
        </span>
        <ul className="grid grid-cols-1 md:grid-cols-3 gap-2 text-micro">
          <li className="flex flex-col rounded bg-surface p-2 border border-border">
            <span className="text-faint uppercase tracking-caps">Approve</span>
            <span className="font-semibold text-success">0 model calls</span>
            <span className="text-muted">Signs off plan without invoking models</span>
          </li>
          <li className="flex flex-col rounded bg-surface p-2 border border-border">
            <span className="text-faint uppercase tracking-caps">Implementation</span>
            <span className="font-semibold text-text">~{gate.taskCount} executor calls</span>
            <span className="text-muted">~1 call per task (before retries)</span>
          </li>
          <li className="flex flex-col rounded bg-surface p-2 border border-border">
            <span className="text-faint uppercase tracking-caps">Request Revision</span>
            <span className="font-semibold text-warning">2 expected calls</span>
            <span className="text-muted">1 planner + 1 reviewer (before retries)</span>
          </li>
        </ul>
      </div>

      {gate.approved ? (
        <p className="flex items-center gap-1.5 text-body-lg text-success">
          <Check className="h-3.5 w-3.5" aria-hidden />
          Already approved{gate.approvedAt === undefined ? '' : ` ${formatWhen(gate.approvedAt)}`}.
        </p>
      ) : null}

      {gate.refusal === undefined ? null : (
        <div className="flex flex-col gap-2 rounded-md border border-danger/25 bg-danger-soft px-3 py-2">
          <span className="text-body-lg text-text">
            The gate refuses this plan: {humanise(gate.refusal.kind)}.
          </span>

          {forcible ? (
            <label className="flex items-start gap-2 text-body-lg text-muted">
              <input
                type="checkbox"
                checked={props.override}
                onChange={(changed) => {
                  props.onOverrideChange(changed.target.checked);
                }}
                className="mt-0.5"
              />
              <span>
                Approve over this refusal. The override is recorded on the run as a
                degradation, so a gate opened this way never looks like one that passed.
              </span>
            </label>
          ) : (
            <span className="text-micro text-muted">
              This one cannot be overridden. Fix the plan and try again.
            </span>
          )}
        </div>
      )}

      <ActionRefusal error={props.error} title="Approval refused:" />
    </div>
  );
}

/**
 * Revision (§91).
 *
 * One textarea and two buttons, exactly as the spec draws it. What it does is more
 * than it looks: the approval is invalidated before the re-plan begins, because a
 * plan produced after approval has not been through the gate — and the new plan is
 * written by the existing planning pipeline. Nothing here edits `plan.json`.
 */
function RevisionDialog(props: {
  open: boolean;
  projectId: string | undefined;
  runId: string;
  approved: boolean;
  initialInstruction?: string;
  onClose: () => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const [instruction, setInstruction] = useState(props.initialInstruction ?? '');
  const revise = useRevise(props.projectId, props.runId);

  useEffect(() => {
    if (props.open) {
      setInstruction(props.initialInstruction ?? '');
    }
  }, [props.open, props.initialInstruction]);

  const close = (): void => {
    setInstruction('');
    revise.reset();
    props.onClose();
  };

  return (
    <Dialog
      open={props.open}
      onClose={close}
      title={locale === 'pt-BR' ? t.approval.revisionPrompt : 'What should change?'}
      description="The planner re-plans with this instruction. Expected model calls: 2 before retries/fallbacks."
      footer={
        <>
          <Button onClick={close}>{locale === 'pt-BR' ? t.common.cancel : 'Cancel'}</Button>
          <Button
            variant="primary"
            disabled={instruction.trim().length === 0 || revise.isPending}
            onClick={() => {
              revise.mutate({ instruction }, { onSuccess: close });
            }}
          >
            {locale === 'pt-BR' ? t.approval.reviseButton : 'Request revision'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* Cost awareness notification */}
        <div className="flex items-center gap-2 rounded-md border border-primary-border bg-primary-soft px-3 py-2 text-micro text-text">
          <Coins className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
          <span>Re-planning consumes 2 expected model calls (1 planner + 1 plan reviewer) before retries/fallbacks.</span>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="sr-only">What should change?</span>
          <textarea
            value={instruction}
            onChange={(changed) => {
              setInstruction(changed.target.value);
            }}
            rows={6}
            placeholder={
              locale === 'pt-BR'
                ? t.approval.revisionPlaceholder
                : 'TASK-004 is too large — split the service from the scheduling rules.'
            }
            className="w-full rounded-md border border-border bg-sunken px-3 py-2 text-body-lg text-text placeholder:text-faint focus:border-border-strong focus:outline-none"
          />
        </label>

        {props.approved ? (
          <p className="flex items-start gap-2 rounded-md border border-warning/25 bg-warning-soft px-3 py-2 text-body-lg text-text">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
            This run is approved. Requesting a revision clears that approval — the gate
            is granted to one specific plan, and this produces a different one.
          </p>
        ) : null}

        <ActionRefusal error={revise.error} title="Revision refused:" />
      </div>
    </Dialog>
  );
}

/** Reject (§30) — confirmed, because it closes the run. */
function RejectDialog(props: {
  open: boolean;
  projectId: string | undefined;
  runId: string;
  onClose: () => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const [reason, setReason] = useState('');
  const reject = useReject(props.projectId, props.runId);

  const close = (): void => {
    setReason('');
    reject.reset();
    props.onClose();
  };

  return (
    <Dialog
      open={props.open}
      onClose={close}
      title={locale === 'pt-BR' ? `${t.common.reject} ${props.runId}?` : `Reject ${props.runId}?`}
      description="The run closes without being implemented. Its artifacts stay on disk."
      footer={
        <>
          <Button onClick={close}>{locale === 'pt-BR' ? t.common.cancel : 'Cancel'}</Button>
          <Button
            variant="primary"
            disabled={reject.isPending}
            className="bg-danger hover:brightness-110"
            onClick={() => {
              reject.mutate(
                reason.trim() === '' ? {} : { reason: reason.trim() },
                { onSuccess: close },
              );
            }}
          >
            {locale === 'pt-BR' ? t.approval.rejectButton : 'Reject run'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-micro uppercase tracking-caps text-faint">
            Reason (optional)
          </span>
          <textarea
            value={reason}
            onChange={(changed) => {
              setReason(changed.target.value);
            }}
            rows={3}
            placeholder="The SDD misread the requirement."
            className="w-full rounded-md border border-border bg-sunken px-3 py-2 text-body-lg text-text placeholder:text-faint focus:border-border-strong focus:outline-none"
          />
        </label>
        <ActionRefusal error={reject.error} title="Rejection refused:" />
      </div>
    </Dialog>
  );
}

function Fact(props: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'warning';
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="whitespace-nowrap text-micro text-faint">{props.label}</dt>
      <dd
        className={cx(
          'truncate text-label',
          props.mono === true && 'font-mono',
          props.tone === 'warning' ? 'text-warning' : 'text-text',
        )}
        title={props.value}
      >
        {props.value}
      </dd>
    </div>
  );
}
