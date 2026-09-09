import { useState, type ReactNode } from 'react';
import type { ArtifactContentView, ArtifactName, ArtifactView, DeliveryView, ReviewView } from '@contracts/index.js';
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
  words,
} from '../../lib/tone';
import { Chip, Empty, Notice, Skeleton } from '../../components/ui';

export type OutcomeTab = 'review' | 'delivery' | 'artifacts';

/**
 * The end of a run: what the reviewers found, what shipped, and what the run wrote down.
 *
 * The recorder above answers *what happened*. These three answer *what came of it*, and
 * they were the reason a person running Deck still had to open the previous dashboard —
 * the review's findings, the pull request and the SDD were all one flag away, in another
 * bundle, at another URL.
 *
 * **Nothing here is derived.** `unsatisfiedGates` is the server's answer to
 * `required && status !== 'passed'`, a review thread's freshness and a delivery's
 * `detail` sentence likewise. The panel picks a colour for a word the server chose and
 * renders the rest; that is the whole of its authority.
 */
export function Outcome({ address, tab, onTab, reviewFreshness }: {
  readonly address: RunAddress;
  readonly tab: OutcomeTab;
  readonly onTab: (next: OutcomeTab) => void;
  /** `runtime.reviewFreshness` (C-20) — whether the newest review describes the run's current state. */
  readonly reviewFreshness: string | undefined;
}) {
  return (
    <section className="panel" aria-labelledby="outcome-h">
      <div className="panel__head">
        <div className="panel__tabs" role="tablist" aria-labelledby="outcome-h">
          <span id="outcome-h" className="visually-hidden">Outcome</span>
          <button type="button" role="tab" aria-selected={tab === 'review'} onClick={() => onTab('review')}>Review</button>
          <button type="button" role="tab" aria-selected={tab === 'delivery'} onClick={() => onTab('delivery')}>Delivery</button>
          <button type="button" role="tab" aria-selected={tab === 'artifacts'} onClick={() => onTab('artifacts')}>Artifacts</button>
        </div>
      </div>
      <div className="panel__body">
        {tab === 'review' ? <ReviewTab address={address} reviewFreshness={reviewFreshness} /> : null}
        {tab === 'delivery' ? <DeliveryTab address={address} /> : null}
        {tab === 'artifacts' ? <ArtifactsTab address={address} /> : null}
      </div>
    </section>
  );
}

function ReviewTab({ address, reviewFreshness }: { readonly address: RunAddress; readonly reviewFreshness: string | undefined }) {
  const review = useResource<ReviewView>(keys.review(address), () => api.reviewRecord(address));
  const data = review.data;

  if (review.error !== undefined) return <Empty error>The review could not be read for this run.</Empty>;
  if (data === undefined) return <Skeleton rows={4} />;

  // **`reviewed`, not an empty list.** A run with no reviewer configured produced no
  // statement at all, which is a different thing from a reviewer that found nothing —
  // and showing the second for the first is how "no findings" comes to mean "not looked at".
  if (!data.reviewed) {
    return (
      <Empty hint="A run reviews when a reviewer is routed for it. `Crew` shows which roles resolve.">
        This run reviewed nothing.
      </Empty>
    );
  }

  const t = data.totals;

  return (
    <div className="outcome">
      {reviewFreshness === undefined || reviewFreshness === 'current' ? null : (
        <Notice tone={freshnessTone(reviewFreshness)} k={words(reviewFreshness)}>
          {reviewFreshness === 'superseded'
            ? 'A planning stage started after this review was written, so it describes a state the run has already left.'
            : 'There is no review describing the current state of this run.'}
        </Notice>
      )}

      <div className="facts-grid">
        <Fact k="reviews" v={String(t.reviews)} />
        <Fact k="tasks" v={String(t.tasksReviewed)} />
        <Fact k="findings" v={String(t.findings)} />
        <Fact k="open" v={String(t.openFindings)} tone={t.openFindings > 0 ? 'bad' : 'ok'} />
        <Fact k="verified" v={String(t.verifiedFindings)} tone={t.verifiedFindings > 0 ? 'ok' : undefined} />
        <Fact k="stale" v={String(t.staleReviews)} tone={t.staleReviews > 0 ? 'warn' : undefined} />
        <Fact k="disputes" v={String(t.disputes)} tone={t.disputes > 0 ? 'warn' : undefined} />
      </div>

      {Object.keys(t.bySeverity).length === 0 ? null : (
        <div className="outcome__chips" aria-label="Findings by severity">
          {Object.entries(t.bySeverity).map(([severity, count]) => (
            <Chip key={severity} tone={severityTone(severity)}>
              {severity} {count}
            </Chip>
          ))}
        </div>
      )}

      <Block title="Gates" count={`${String(data.gates.length - data.unsatisfiedGates.length)}/${String(data.gates.length)} satisfied`}>
        {data.gates.length === 0 ? (
          <p className="faint outcome__none">No gate ran for this run.</p>
        ) : (
          <div className="gates">
            {data.gates.map((gate) => (
              <div key={gate.gateId} className="gate" data-tone={gateTone(gate.status)}>
                <span className="gate__id">{gate.gateId}</span>
                <span className="gate__status">{words(gate.status)}</span>
                <span className="gate__meta">
                  {gate.required ? 'required' : 'advisory'}
                  {gate.exitCode === undefined ? '' : ` · exit ${String(gate.exitCode)}`}
                </span>
                {gate.detail === undefined ? null : <span className="gate__detail">{gate.detail}</span>}
              </div>
            ))}
          </div>
        )}
      </Block>

      <Block title="Threads" count={`${String(data.threads.length)} task${data.threads.length === 1 ? '' : 's'}`}>
        {data.threads.length === 0 ? (
          <p className="faint outcome__none">No task was reviewed.</p>
        ) : (
          data.threads.map((thread) => <Thread key={thread.taskId} thread={thread} />)
        )}
      </Block>
    </div>
  );
}

function Thread({ thread }: { readonly thread: ReviewView['threads'][number] }) {
  const [open, setOpen] = useState(false);
  const findings = thread.findings;

  return (
    <div className="thread">
      <button type="button" className="thread__head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="thread__task">{thread.taskId}</span>
        <Chip tone={threadTone(thread.status)}>{words(thread.status)}</Chip>
        {thread.freshness === 'current' ? null : <Chip tone={freshnessTone(thread.freshness)}>{words(thread.freshness)}</Chip>}
        {/*
          Independence is §19's level and the number a person actually asks about: a
          reviewer that shared the author's execution context reviewed its own work. The
          server records the level achieved, so a degradation is a fact on the run.
        */}
        <Chip tone={independenceTone(thread.independence)} plain title={`reviewer ${thread.reviewerName} · author ${thread.author}`}>
          independence {thread.independence}
        </Chip>
        {thread.openBlocking > 0 ? <Chip tone="bad">{thread.openBlocking} blocking</Chip> : null}
        <span className="thread__meta">
          {thread.rounds} round{thread.rounds === 1 ? '' : 's'} · {findings.length} finding{findings.length === 1 ? '' : 's'}
        </span>
      </button>

      {!open ? null : (
        <div className="thread__body">
          {thread.decision.blockedBy.length > 0 ? (
            <Notice tone="bad" k="blocked by">{thread.decision.blockedBy.join(', ')}</Notice>
          ) : null}
          {thread.decision.conditions.length === 0 ? null : (
            <div className="outcome__chips" aria-label="Conditions on this decision">
              {thread.decision.conditions.map((condition) => (
                <Chip key={condition.name} tone={condition.met ? 'ok' : 'warn'} plain title={condition.detail}>
                  {words(condition.name)} {condition.met ? '✓' : '·'}
                </Chip>
              ))}
            </div>
          )}
          {thread.reviewedTree === undefined ? null : (
            <div className="facts-grid">
              <Fact k="reviewed tree" v={thread.reviewedTree.slice(0, 10)} />
              {thread.integratedTree === undefined ? null : (
                // §4: the tree the review read against the tree that was integrated. When
                // these differ the review is a statement about something else.
                <Fact k="integrated" v={thread.integratedTree.slice(0, 10)} tone={thread.integratedTree === thread.reviewedTree ? 'ok' : 'warn'} />
              )}
            </div>
          )}
          {findings.length === 0 ? (
            <p className="faint outcome__none">The reviewer found nothing on this task.</p>
          ) : (
            findings.map((projected) => (
              <div key={projected.finding.id} className="finding finding--full" data-tone={severityTone(projected.finding.severity)}>
                <span className="finding__sev">{projected.finding.severity}</span>
                <div>
                  <div className="finding__text">{projected.finding.description}</div>
                  <div className="finding__foot">
                    <Chip tone={findingTone(projected.status)} plain>{words(projected.status)}</Chip>
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
  const delivery = useResource<DeliveryView>(keys.delivery(address), () => api.delivery(address));
  const data = delivery.data;

  if (delivery.error !== undefined) return <Empty error>The delivery record could not be read for this run.</Empty>;
  if (data === undefined) return <Skeleton rows={3} />;

  // `disabled` is the ordinary case and not a problem — the contract says so. A screen
  // that drew it as an absence would be reporting a configuration choice as a fault.
  if (data.state === 'disabled') {
    return <Empty hint="Delivery is opt-in, and every remote write is separately opt-in.">{data.detail}</Empty>;
  }

  return (
    <div className="outcome">
      <Notice tone={deliveryTone(data.state)} k={words(data.state)}>{data.detail}</Notice>

      {data.failure === undefined ? null : (
        <Notice tone="bad" k={words(data.failure.code)}>{data.failure.detail}</Notice>
      )}

      <div className="facts-grid">
        <Fact k="provider" v={data.provider} />
        {data.repository === undefined ? null : <Fact k="repository" v={data.repository} />}
        {data.branch === undefined ? null : <Fact k="branch" v={data.branch} />}
        {data.publishedCommit === undefined ? null : <Fact k="commit" v={data.publishedCommit.slice(0, 10)} />}
        {data.syncedAt === undefined ? null : <Fact k="synced" v={formatRelative(data.syncedAt, Date.now())} />}
      </div>

      {data.pullRequest === undefined && data.issue === undefined ? null : (
        <div className="outcome__links">
          {data.pullRequest === undefined ? null : (
            <a className="btn btn--sm" href={data.pullRequest.url} target="_blank" rel="noreferrer noopener">
              pull request #{data.pullRequest.number} · {words(data.pullRequest.state)}
            </a>
          )}
          {data.issue === undefined ? null : (
            <a className="btn btn--sm btn--ghost" href={data.issue.url} target="_blank" rel="noreferrer noopener">
              issue #{data.issue.number}
            </a>
          )}
        </div>
      )}

      <Block
        title="Checks"
        count={`${String(data.checkSummary.green)} green · ${String(data.checkSummary.red)} red · ${String(data.checkSummary.pending)} pending`}
      >
        {data.checks.length === 0 ? (
          <p className="faint outcome__none">The forge reported no check for this commit.</p>
        ) : (
          <div className="checks">
            {data.checks.map((check) => (
              <div key={check.id} className="check" data-tone={checkTone(check.status, check.conclusion)}>
                <span className="check__name truncate">{check.name}</span>
                <span className="check__status">{words(check.conclusion ?? check.status)}</span>
                {check.url === undefined ? null : (
                  <a className="check__link" href={check.url} target="_blank" rel="noreferrer noopener">open</a>
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
  const list = useResource<ArtifactView[]>(keys.artifacts(address), () => api.artifacts(address));
  const [shown, setShown] = useState<ArtifactName | undefined>(undefined);

  if (list.error !== undefined) return <Empty error>The artifact list could not be read for this run.</Empty>;
  if (list.data === undefined) return <Skeleton rows={3} />;

  const available = list.data.filter((artifact) => artifact.available);
  if (available.length === 0) {
    return <Empty hint="Every stage that produces one writes it when it completes.">This run has written no artifact yet.</Empty>;
  }

  return (
    <div className="outcome">
      {/*
        The name is the server's, round-tripped. Deck never spells one, which is what
        keeps "the browser sends ids, never locations" true of this panel too — the enum
        on the route is the whole defence and it has nothing to defend against here.
      */}
      <div className="outcome__chips" role="tablist" aria-label="Artifacts this run wrote">
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
        <p className="faint outcome__none">Pick one to read it.</p>
      ) : (
        <ArtifactText address={address} name={shown} />
      )}
    </div>
  );
}

function ArtifactText({ address, name }: { readonly address: RunAddress; readonly name: ArtifactName }) {
  const artifact = useResource<ArtifactContentView>(keys.artifact(address, name), () => api.artifact(address, name));

  if (artifact.error !== undefined) return <Empty error>That artifact could not be read.</Empty>;
  if (artifact.data === undefined) return <Skeleton rows={6} />;

  return (
    <div className="artifact">
      <div className="artifact__head">
        <span className="eyebrow">{artifact.data.label}</span>
        <span className="section__count">
          {artifact.data.updatedAt === undefined ? '' : formatRelative(artifact.data.updatedAt, Date.now())}
          {artifact.data.truncated ? ' · cut' : ''}
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

function Block({ title, count, children }: { readonly title: string; readonly count?: string; readonly children: ReactNode }) {
  return (
    <div className="block">
      <div className="block__head">
        <span className="eyebrow">{title}</span>
        {count === undefined ? null : <span className="section__count">{count}</span>}
      </div>
      {children}
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
