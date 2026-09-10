import { useState } from 'react';
import type { ArtifactContentView, ArtifactName, ArtifactView, AttentionFocus, DeliveryView, ReviewView } from '@contracts/index.js';
import { api, keys, type RunAddress } from '../../lib/api';
import { useResource } from '../../lib/store';
import { formatRelative } from '../../lib/time';
import {
  checkTone,
  deliveryTone,
  findingTone,
  freshnessTone,
  gateTone,
  independenceTone,
  severityTone,
  threadTone,
} from '../../lib/tone';
import { useT, word } from '../../lib/i18n';
import { Block, Chip, Empty, Notice, Skeleton } from '../../components/ui';
import { TelemetryTab } from './Telemetry';
import { TeamTab } from './Team';
import { CollaborationTab } from './Collaboration';

export type OutcomeTab = 'review' | 'delivery' | 'artifacts' | 'telemetry' | 'team' | 'collaboration';

/**
 * Where an attention item lands, as a table rather than a switch (M8, 7.8).
 *
 * The core emits a *surface* and refuses to emit a route — "a projection that emitted
 * `/runs/AF-2026-001?view=board` would be the domain deciding the browser's information
 * architecture". Mapping the surface onto a tab is the browser's one decision here, and
 * this is where it is made.
 *
 * **A `Record` and not a `switch`, because the switch had a `default`.** `team` used to
 * fall through it to `undefined` — the projection had been emitting that focus since M8
 * and there was no tab to open, so "no member could take this task" moved the selection
 * and showed nothing. A default case is how a focus goes missing silently; a record keyed
 * by the union does not compile until the day's new focus is given somewhere to land.
 *
 * `undefined` is a deliberate answer, not a gap: `run`, `plan` and `task` are answered
 * above this panel — `plan` by the gate dialog, because a plan is a decision and the
 * dialog is where a decision is made.
 */
const TAB_FOR_FOCUS: Record<AttentionFocus, OutcomeTab | undefined> = {
  review: 'review',
  quality: 'review',
  delivery: 'delivery',
  team: 'team',
  run: undefined,
  plan: undefined,
  task: undefined,
};

export function tabForFocus(focus: AttentionFocus): OutcomeTab | undefined {
  return TAB_FOR_FOCUS[focus];
}

/**
 * The run's record: what the reviewers found, what shipped, what it wrote down, what it
 * cost, who did it and what they said to each other.
 *
 * The recorder above answers *what happened*. These answer *what came of it*, and they
 * were the reason a person running Deck still had to open the previous dashboard — the
 * review's findings, the pull request and the SDD were all one flag away, in another
 * bundle, at another URL.
 *
 * **Six tabs, always present, each explaining its own absence.** The previous dashboard
 * hid a tab whose projection was empty, because it had eight panels stacked on one page
 * and a permanent empty box teaches people to skip the row it lives in. This panel is one
 * row of six words: hiding two of them would make the row's shape depend on the run, and
 * "where did Delivery go" is a worse question than "no forge is configured".
 *
 * **Nothing here is derived.** `unsatisfiedGates` is the server's answer to
 * `required && status !== 'passed'`, a review thread's freshness, a candidate's score and
 * a delivery's `detail` sentence likewise. The panel picks a colour for a word the server
 * chose and renders the rest; that is the whole of its authority.
 */
export function Outcome({ address, tab, onTab, reviewFreshness }: {
  readonly address: RunAddress;
  readonly tab: OutcomeTab;
  readonly onTab: (next: OutcomeTab) => void;
  /** `runtime.reviewFreshness` (C-20) — whether the newest review describes the run's current state. */
  readonly reviewFreshness: string | undefined;
}) {
  const t = useT();
  return (
    <section className="panel" aria-labelledby="outcome-h">
      <div className="panel__head">
        <div className="panel__tabs" role="tablist" aria-labelledby="outcome-h">
          {/* Named for what the six tabs have in common now that two of them are about
              the run's conduct rather than its end: everything it recorded. */}
          <span id="outcome-h" className="visually-hidden">{t.outcome.record}</span>
          <button type="button" role="tab" aria-selected={tab === 'review'} onClick={() => onTab('review')}>{t.outcome.review}</button>
          <button type="button" role="tab" aria-selected={tab === 'delivery'} onClick={() => onTab('delivery')}>{t.outcome.delivery}</button>
          <button type="button" role="tab" aria-selected={tab === 'artifacts'} onClick={() => onTab('artifacts')}>{t.outcome.artifacts}</button>
          <button type="button" role="tab" aria-selected={tab === 'telemetry'} onClick={() => onTab('telemetry')}>{t.outcome.telemetryTab}</button>
          {/*
            Team before Collaboration, because it answers "who is doing this" — the
            context that makes an open thread legible. "executor.normal is blocked" reads
            differently once the screen has said which member that is.
          */}
          <button type="button" role="tab" aria-selected={tab === 'team'} onClick={() => onTab('team')}>{t.outcome.team}</button>
          <button type="button" role="tab" aria-selected={tab === 'collaboration'} onClick={() => onTab('collaboration')}>{t.outcome.collaboration}</button>
        </div>
      </div>
      <div className="panel__body">
        {tab === 'review' ? <ReviewTab address={address} reviewFreshness={reviewFreshness} /> : null}
        {tab === 'delivery' ? <DeliveryTab address={address} /> : null}
        {tab === 'artifacts' ? <ArtifactsTab address={address} /> : null}
        {tab === 'telemetry' ? <TelemetryTab address={address} /> : null}
        {tab === 'team' ? <TeamTab address={address} /> : null}
        {tab === 'collaboration' ? <CollaborationTab address={address} /> : null}
      </div>
    </section>
  );
}

function ReviewTab({ address, reviewFreshness }: { readonly address: RunAddress; readonly reviewFreshness: string | undefined }) {
  const t = useT();
  const review = useResource<ReviewView>(keys.review(address), () => api.reviewRecord(address));
  const data = review.data;

  if (review.error !== undefined) return <Empty error>{t.outcome.reviewCouldNotRead}</Empty>;
  if (data === undefined) return <Skeleton rows={4} />;

  // **`reviewed`, not an empty list.** A run with no reviewer configured produced no
  // statement at all, which is a different thing from a reviewer that found nothing —
  // and showing the second for the first is how "no findings" comes to mean "not looked at".
  if (!data.reviewed) {
    return (
      <Empty hint={t.outcome.reviewedNothingHint}>
        {t.outcome.reviewedNothing}
      </Empty>
    );
  }

  const totals = data.totals;

  return (
    <div className="outcome">
      {reviewFreshness === undefined || reviewFreshness === 'current' ? null : (
        <Notice tone={freshnessTone(reviewFreshness)} k={word(t, reviewFreshness)}>
          {reviewFreshness === 'superseded' ? t.outcome.supersededReview : t.outcome.noCurrentReview}
        </Notice>
      )}

      <div className="facts-grid">
        <Fact k={t.outcome.reviews} v={String(totals.reviews)} />
        <Fact k={t.outcome.tasks} v={String(totals.tasksReviewed)} />
        <Fact k={t.outcome.findings} v={String(totals.findings)} />
        <Fact k={t.outcome.openFindings} v={String(totals.openFindings)} tone={totals.openFindings > 0 ? 'bad' : 'ok'} />
        <Fact k={t.outcome.verified} v={String(totals.verifiedFindings)} tone={totals.verifiedFindings > 0 ? 'ok' : undefined} />
        <Fact k={t.outcome.stale} v={String(totals.staleReviews)} tone={totals.staleReviews > 0 ? 'warn' : undefined} />
        <Fact k={t.outcome.disputes} v={String(totals.disputes)} tone={totals.disputes > 0 ? 'warn' : undefined} />
      </div>

      {Object.keys(totals.bySeverity).length === 0 ? null : (
        <div className="outcome__chips" aria-label={t.outcome.bySeverity}>
          {Object.entries(totals.bySeverity).map(([severity, count]) => (
            <Chip key={severity} tone={severityTone(severity)}>
              {word(t, severity)} {count}
            </Chip>
          ))}
        </div>
      )}

      <Block title={t.outcome.gates} count={t.outcome.satisfied(data.gates.length - data.unsatisfiedGates.length, data.gates.length)}>
        {data.gates.length === 0 ? (
          <p className="faint outcome__none">{t.outcome.noGateRan}</p>
        ) : (
          <div className="gates">
            {data.gates.map((gate) => (
              <div key={gate.gateId} className="gate" data-tone={gateTone(gate.status)}>
                <span className="gate__id">{gate.gateId}</span>
                <span className="gate__status">{word(t, gate.status)}</span>
                <span className="gate__meta">
                  {gate.required ? t.outcome.required : t.outcome.advisory}
                  {gate.exitCode === undefined ? '' : ` · ${t.outcome.exit(gate.exitCode)}`}
                </span>
                {gate.detail === undefined ? null : <span className="gate__detail">{gate.detail}</span>}
              </div>
            ))}
          </div>
        )}
      </Block>

      <Block title={t.outcome.threads} count={t.events.taskCount(data.threads.length)}>
        {data.threads.length === 0 ? (
          <p className="faint outcome__none">{t.outcome.noTaskReviewed}</p>
        ) : (
          data.threads.map((thread) => <Thread key={thread.taskId} thread={thread} />)
        )}
      </Block>
    </div>
  );
}

function Thread({ thread }: { readonly thread: ReviewView['threads'][number] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const findings = thread.findings;

  return (
    <div className="thread">
      <button type="button" className="thread__head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="thread__task">{thread.taskId}</span>
        <Chip tone={threadTone(thread.status)}>{word(t, thread.status)}</Chip>
        {thread.freshness === 'current' ? null : <Chip tone={freshnessTone(thread.freshness)}>{word(t, thread.freshness)}</Chip>}
        {/*
          Independence is §19's level and the number a person actually asks about: a
          reviewer that shared the author's execution context reviewed its own work. The
          server records the level achieved, so a degradation is a fact on the run.
        */}
        <Chip tone={independenceTone(thread.independence)} plain title={t.outcome.reviewerAuthor(thread.reviewerName, thread.author)}>
          {t.gate.independence(thread.independence)}
        </Chip>
        {thread.openBlocking > 0 ? <Chip tone="bad">{t.outcome.blocking(thread.openBlocking)}</Chip> : null}
        <span className="thread__meta">
          {t.outcome.rounds(thread.rounds)} · {t.events.findingCount(findings.length)}
        </span>
      </button>

      {!open ? null : (
        <div className="thread__body">
          {thread.decision.blockedBy.length > 0 ? (
            <Notice tone="bad" k={t.outcome.blockedBy}>{thread.decision.blockedBy.join(', ')}</Notice>
          ) : null}
          {thread.decision.conditions.length === 0 ? null : (
            <div className="outcome__chips" aria-label={t.outcome.conditions}>
              {thread.decision.conditions.map((condition) => (
                <Chip key={condition.name} tone={condition.met ? 'ok' : 'warn'} plain title={condition.detail}>
                  {word(t, condition.name)} {condition.met ? '✓' : '·'}
                </Chip>
              ))}
            </div>
          )}
          {thread.reviewedTree === undefined ? null : (
            <div className="facts-grid">
              <Fact k={t.outcome.reviewedTree} v={thread.reviewedTree.slice(0, 10)} />
              {thread.integratedTree === undefined ? null : (
                // §4: the tree the review read against the tree that was integrated. When
                // these differ the review is a statement about something else.
                <Fact k={t.outcome.integratedTree} v={thread.integratedTree.slice(0, 10)} tone={thread.integratedTree === thread.reviewedTree ? 'ok' : 'warn'} />
              )}
            </div>
          )}
          {findings.length === 0 ? (
            <p className="faint outcome__none">{t.outcome.reviewerFoundNothing}</p>
          ) : (
            findings.map((projected) => (
              <div key={projected.finding.id} className="finding finding--full" data-tone={severityTone(projected.finding.severity)}>
                <span className="finding__sev">{word(t, projected.finding.severity)}</span>
                <div>
                  <div className="finding__text">{projected.finding.description}</div>
                  <div className="finding__foot">
                    <Chip tone={findingTone(projected.status)} plain>{word(t, projected.status)}</Chip>
                    <span className="faint">{projected.finding.type}</span>
                    {projected.finding.file === undefined ? null : <span className="mono">{projected.finding.file}</span>}
                    {projected.correctiveTask === undefined ? null : <span className="faint">→ {projected.correctiveTask}</span>}
                  </div>
                  <div className="finding__action">{projected.finding.suggestedAction}</div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function DeliveryTab({ address }: { readonly address: RunAddress }) {
  const t = useT();
  const delivery = useResource<DeliveryView>(keys.delivery(address), () => api.delivery(address));
  const data = delivery.data;

  if (delivery.error !== undefined) return <Empty error>{t.outcome.deliveryCouldNotRead}</Empty>;
  if (data === undefined) return <Skeleton rows={3} />;

  // `disabled` is the ordinary case and not a problem — the contract says so. A screen
  // that drew it as an absence would be reporting a configuration choice as a fault.
  if (data.state === 'disabled') {
    return <Empty hint={t.outcome.deliveryOptIn}>{data.detail}</Empty>;
  }

  return (
    <div className="outcome">
      <Notice tone={deliveryTone(data.state)} k={word(t, data.state)}>{data.detail}</Notice>

      {data.failure === undefined ? null : (
        <Notice tone="bad" k={word(t, data.failure.code)}>{data.failure.detail}</Notice>
      )}

      <div className="facts-grid">
        <Fact k={t.outcome.provider} v={data.provider} />
        {data.repository === undefined ? null : <Fact k={t.outcome.repository} v={data.repository} />}
        {data.branch === undefined ? null : <Fact k={t.outcome.branch} v={data.branch} />}
        {data.publishedCommit === undefined ? null : <Fact k={t.outcome.commit} v={data.publishedCommit.slice(0, 10)} />}
        {data.syncedAt === undefined ? null : <Fact k={t.outcome.synced} v={formatRelative(data.syncedAt, Date.now(), t.time)} />}
      </div>

      {data.pullRequest === undefined && data.issue === undefined ? null : (
        <div className="outcome__links">
          {data.pullRequest === undefined ? null : (
            <a className="btn btn--sm" href={data.pullRequest.url} target="_blank" rel="noreferrer noopener">
              {t.outcome.pullRequest(data.pullRequest.number)} · {word(t, data.pullRequest.state)}
            </a>
          )}
          {data.issue === undefined ? null : (
            <a className="btn btn--sm btn--ghost" href={data.issue.url} target="_blank" rel="noreferrer noopener">
              {t.outcome.issue(data.issue.number)}
            </a>
          )}
        </div>
      )}

      <Block
        title={t.outcome.checks}
        count={t.outcome.checkSummary(data.checkSummary.green, data.checkSummary.red, data.checkSummary.pending)}
      >
        {data.checks.length === 0 ? (
          <p className="faint outcome__none">{t.outcome.noChecks}</p>
        ) : (
          <div className="checks">
            {data.checks.map((check) => (
              <div key={check.id} className="check" data-tone={checkTone(check.status, check.conclusion)}>
                <span className="check__name truncate">{check.name}</span>
                <span className="check__status">{word(t, check.conclusion ?? check.status)}</span>
                {check.url === undefined ? null : (
                  <a className="check__link" href={check.url} target="_blank" rel="noreferrer noopener">{t.outcome.openLink}</a>
                )}
              </div>
            ))}
          </div>
        )}
      </Block>
    </div>
  );
}

function ArtifactsTab({ address }: { readonly address: RunAddress }) {
  const t = useT();
  const list = useResource<ArtifactView[]>(keys.artifacts(address), () => api.artifacts(address));
  const [shown, setShown] = useState<ArtifactName | undefined>(undefined);

  if (list.error !== undefined) return <Empty error>{t.outcome.artifactsCouldNotRead}</Empty>;
  if (list.data === undefined) return <Skeleton rows={3} />;

  const available = list.data.filter((artifact) => artifact.available);
  if (available.length === 0) {
    return <Empty hint={t.outcome.artifactsHint}>{t.outcome.noArtifacts}</Empty>;
  }

  return (
    <div className="outcome">
      {/*
        The name is the server's, round-tripped. Deck never spells one, which is what
        keeps "the browser sends ids, never locations" true of this panel too — the enum
        on the route is the whole defence and it has nothing to defend against here.
      */}
      <div className="outcome__chips" role="tablist" aria-label={t.outcome.artifactsAria}>
        {available.map((artifact) => (
          <button
            key={artifact.name}
            type="button"
            role="tab"
            className="pill"
            aria-selected={shown === artifact.name}
            onClick={() => setShown(shown === artifact.name ? undefined : (artifact.name as ArtifactName))}
          >
            {artifact.label}
            {artifact.sizeBytes === undefined ? null : <span className="pill__meta">{kb(artifact.sizeBytes)}</span>}
          </button>
        ))}
      </div>

      {shown === undefined ? (
        <p className="faint outcome__none">{t.outcome.pickArtifact}</p>
      ) : (
        <ArtifactText address={address} name={shown} />
      )}
    </div>
  );
}

function ArtifactText({ address, name }: { readonly address: RunAddress; readonly name: ArtifactName }) {
  const t = useT();
  const artifact = useResource<ArtifactContentView>(keys.artifact(address, name), () => api.artifact(address, name));

  if (artifact.error !== undefined) return <Empty error>{t.outcome.artifactCouldNotRead}</Empty>;
  if (artifact.data === undefined) return <Skeleton rows={6} />;

  return (
    <div className="artifact">
      <div className="artifact__head">
        <span className="eyebrow">{artifact.data.label}</span>
        <span className="section__count">
          {artifact.data.updatedAt === undefined ? '' : formatRelative(artifact.data.updatedAt, Date.now(), t.time)}
          {artifact.data.truncated ? ` · ${t.outcome.cut}` : ''}
        </span>
      </div>
      {/*
        Rendered as text, deliberately. An artifact is a runner's output, and a bundle
        that turned it into markup would be handing a model's words the page's authority.
      */}
      <pre className="artifact__text">{artifact.data.content}</pre>
    </div>
  );
}

function Fact({ k, v, tone }: { readonly k: string; readonly v: string; readonly tone?: string | undefined }) {
  return (
    <div className="fact">
      <span className="fact__k">{k}</span>
      <span className="fact__v" {...(tone === undefined ? {} : { 'data-tone': tone })}>{v}</span>
    </div>
  );
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} B` : `${String(Math.round(bytes / 1024))} kB`;
}
