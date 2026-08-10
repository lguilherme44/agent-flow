import { useState } from 'react';
import { AlertTriangle, Check, Loader2, Play, Pencil, X } from 'lucide-react';
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
import { formatWhen, humanise } from '../lib/format';

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

  const job = useActiveJob(props.projectId, run.runId);
  const start = useStart(props.projectId, run.runId);

  const active = job.data ?? undefined;
  const busy = active !== undefined;

  const terminal = run.status === 'completed' || run.status === 'plan_rejected';
  const canStart = run.approved && !terminal && run.progress < 100;

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
          ) : terminal ? null : (
            <Button
              variant="primary"
              onClick={() => {
                setDialog('approve');
              }}
            >
              Review &amp; approve
            </Button>
          )}
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
        onRevise={() => {
          setDialog('revise');
        }}
      />

      <RevisionDialog
        open={dialog === 'revise'}
        projectId={props.projectId}
        runId={run.runId}
        approved={run.approved}
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
function JobIndicator(props: { job: ActionJobView }): JSX.Element {
  const { job } = props;

  return (
    <Tooltip
      content={
        <span>
          {job.kind === 'start' ? 'Executing the plan' : 'Re-planning'} since{' '}
          {formatWhen(job.startedAt)}. Progress appears as the run records it.
        </span>
      }
    >
      <span className="flex h-7 items-center gap-1.5 rounded-sm border border-primary-border bg-primary-soft px-2.5 text-label text-text">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary-bright" aria-hidden />
        {job.kind === 'start' ? 'Running…' : 'Re-planning…'}
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
  onRevise: () => void;
}): JSX.Element {
  const gate = useApprovalGate(props.projectId, props.run.runId, { enabled: props.open });
  const approve = useApprove(props.projectId, props.run.runId);
  const [override, setOverride] = useState(false);

  const data = gate.data;
  const forcible = data?.refusal?.forcible === true;
  const blocked = data !== undefined && !data.canApprove;

  return (
    <Dialog
      open={props.open}
      onClose={() => {
        setOverride(false);
        approve.reset();
        props.onClose();
      }}
      title={`Approve the plan for ${props.run.runId}`}
      description="Approval is bound to this exact plan. Revise it and the gate closes again."
      className="w-[min(680px,94vw)]"
      footer={
        <>
          <Button
            onClick={() => {
              props.onClose();
              props.onRevise();
            }}
          >
            Request revision
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
        <p className="text-label text-muted">Reading the plan and its review…</p>
      ) : (
        <GateBody
          gate={data}
          override={override}
          onOverrideChange={setOverride}
          error={approve.error}
        />
      )}
    </Dialog>
  );
}

function GateBody(props: {
  gate: ApprovalGateView;
  override: boolean;
  onOverrideChange: (value: boolean) => void;
  error: unknown;
}): JSX.Element {
  const { gate } = props;
  const review = gate.review;
  const forcible = gate.refusal?.forcible === true;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {review === undefined ? (
          <Badge tone="warning" caps>
            no review
          </Badge>
        ) : (
          <Badge tone={review.verdict === 'PASS' ? 'success' : 'danger'} caps>
            Plan review: {review.verdict}
          </Badge>
        )}
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
      </div>

      {/* The identities. No versions: neither the SDD nor the plan declares one, and
          a digest that says it is a digest beats a number nobody maintains. */}
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

      {/* Degradations, before the decision rather than in a post-mortem (R-16). */}
      {gate.warnings.length === 0 ? null : (
        <ul className="flex flex-col gap-1 rounded-md border border-warning/25 bg-warning-soft px-3 py-2">
          {gate.warnings.map((warning) => (
            <li key={warning} className="flex gap-2 text-label text-text">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
              {warning}
            </li>
          ))}
        </ul>
      )}

      {review === undefined || review.findings.length === 0 ? null : (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-micro uppercase tracking-wide text-faint">
            Review findings ({review.findings.length})
          </h3>
          <ul className="flex flex-col divide-y divide-border">
            {review.findings.map((finding, index) => (
              <li
                key={`${finding.type}:${String(index)}`}
                className="flex flex-col gap-0.5 py-1.5"
              >
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
                <span className="text-label text-text">{finding.description}</span>
                <span className="text-micro text-muted">→ {finding.suggestedAction}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {gate.approved ? (
        <p className="flex items-center gap-1.5 text-label text-success">
          <Check className="h-3.5 w-3.5" aria-hidden />
          Already approved{gate.approvedAt === undefined ? '' : ` ${formatWhen(gate.approvedAt)}`}.
        </p>
      ) : null}

      {gate.refusal === undefined ? null : (
        <div className="flex flex-col gap-2 rounded-md border border-danger/25 bg-danger-soft px-3 py-2">
          <span className="text-label text-text">
            The gate refuses this plan: {humanise(gate.refusal.kind)}.
          </span>

          {/* Not a button. Forcing is a decision, and a decision needs a deliberate
              act rather than a click that happens to be in the right place — the
              override says what it costs before it is available. */}
          {forcible ? (
            <label className="flex items-start gap-2 text-micro text-muted">
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
  onClose: () => void;
}): JSX.Element {
  const [instruction, setInstruction] = useState('');
  const revise = useRevise(props.projectId, props.runId);

  const close = (): void => {
    setInstruction('');
    revise.reset();
    props.onClose();
  };

  return (
    <Dialog
      open={props.open}
      onClose={close}
      title="What should change?"
      description="The planner re-plans with this instruction. Re-planning spends quota."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabled={instruction.trim().length === 0 || revise.isPending}
            onClick={() => {
              revise.mutate({ instruction }, { onSuccess: close });
            }}
          >
            Request revision
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="sr-only">What should change?</span>
          <textarea
            value={instruction}
            onChange={(changed) => {
              setInstruction(changed.target.value);
            }}
            rows={6}
            placeholder="TASK-004 is too large — split the service from the scheduling rules."
            className="w-full rounded-md border border-border bg-sunken px-3 py-2 text-label text-text placeholder:text-faint focus:border-border-strong focus:outline-none"
          />
        </label>

        {props.approved ? (
          <p className="flex items-start gap-2 rounded-md border border-warning/25 bg-warning-soft px-3 py-2 text-label text-text">
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
      title={`Reject ${props.runId}?`}
      description="The run closes without being implemented. Its artifacts stay on disk."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
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
            Reject run
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-micro uppercase tracking-wide text-faint">
            Reason (optional)
          </span>
          <textarea
            value={reason}
            onChange={(changed) => {
              setReason(changed.target.value);
            }}
            rows={3}
            placeholder="The SDD misread the requirement."
            className="w-full rounded-md border border-border bg-sunken px-3 py-2 text-label text-text placeholder:text-faint focus:border-border-strong focus:outline-none"
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
