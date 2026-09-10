import type { ContextTelemetryObservation, RunTelemetryView } from '@contracts/index.js';
import { api, keys, type RunAddress } from '../../lib/api';
import { useResource } from '../../lib/store';
import { formatDuration } from '../../lib/time';
import { useT, word } from '../../lib/i18n';
import { Chip, Empty, Meter, Notice, Skeleton, Stat } from '../../components/ui';

/**
 * What each stage cost, and what its prompt was made of (7.4, AR-09).
 *
 * `/runs/:id/telemetry` has been served since M3 and nothing in Deck drew it, so the one
 * question a slow run provokes — *why did that stage cost so much* — was answerable only
 * from `--classic`. The previous dashboard did draw the durations, and it still could not
 * answer that one: its hand-written response type had dropped `context` on the way in.
 *
 * **No money appears here, at any level.** `AnalyticsView` carries no monetary figure and
 * is not going to; a subscriber's flat fee is not an API rate, and a total that pretended
 * otherwise would be a bill nobody is sending. What a runner reported about *tokens* is a
 * count, and counts are what this draws.
 *
 * Every number is the server's. The bars are proportions of the run's own total, which is
 * arithmetic over one response rather than a second opinion about it.
 */
export function TelemetryTab({ address }: { readonly address: RunAddress }) {
  const t = useT();
  const telemetry = useResource<RunTelemetryView>(keys.telemetry(address), () =>
    api.telemetry(address),
  );

  if (telemetry.error !== undefined) {
    return <Empty error>{t.telemetry.couldNotRead}</Empty>;
  }
  if (telemetry.data === undefined) return <Skeleton rows={5} />;

  const { summary, context } = telemetry.data;

  if (summary.entries === 0) {
    return (
      <Empty hint={t.telemetry.foldHint}>
        {t.telemetry.nothingRunYet}
      </Empty>
    );
  }

  return (
    <div className="telemetry">
      <div className="telemetry__totals" aria-label={t.telemetry.totals}>
        <Stat label={t.telemetry.stagesAndTasks} value={String(summary.entries)} />
        <Stat label={t.telemetry.totalTime} value={formatDuration(summary.durationMs)} />
        <Stat label={t.telemetry.failures} value={String(summary.failures)} tone={summary.failures > 0 ? 'bad' : undefined} />
        <Stat label={t.telemetry.retries} value={String(summary.retries)} tone={summary.retries > 0 ? 'warn' : undefined} />
        <Stat
          label={t.telemetry.fellBack}
          value={String(summary.fallbacks)}
          tone={summary.fallbacks > 0 ? 'warn' : undefined}
        />
        <Stat
          label={t.telemetry.belowEffort}
          value={String(summary.reasoningClamped)}
          tone={summary.reasoningClamped > 0 ? 'warn' : undefined}
        />
      </div>

      <Buckets title={t.telemetry.byStage} buckets={summary.byStage} total={summary.durationMs} />
      <Buckets title={t.telemetry.byRunner} buckets={summary.byRunner} total={summary.durationMs} />
      <Buckets
        title={t.telemetry.byModel}
        buckets={summary.byModel}
        total={summary.durationMs}
        empty={t.telemetry.noModelReported}
      />

      <ContextSection context={context} />
    </div>
  );
}

function Buckets({
  title,
  buckets,
  total,
  empty,
}: {
  title: string;
  buckets: Record<string, { count: number; durationMs: number; failures: number; retries: number }>;
  total: number;
  empty?: string;
}) {
  const t = useT();
  const rows = Object.entries(buckets).sort((a, b) => b[1].durationMs - a[1].durationMs);

  return (
    <section className="doctor-section" aria-label={title}>
      <div className="doctor-section__head">
        <h3>{title}</h3>
      </div>
      {rows.length === 0 ? (
        <p className="doctor-note">{empty ?? t.telemetry.nothingToShow}</p>
      ) : (
        <ul className="doctor-list">
          {rows.map(([key, bucket]) => (
            <li key={key} className="telemetry-row">
              <span className="doctor-row__name">{word(t, key)}</span>
              <Meter
                label={formatDuration(bucket.durationMs)}
                done={bucket.durationMs}
                total={total === 0 ? 1 : total}
                tone={bucket.failures > 0 ? 'bad' : 'live'}
              />
              <span className="doctor-row__value">
                {t.telemetry.calls(bucket.count)}
                {bucket.retries > 0 ? ` · ${t.telemetry.retried(bucket.retries)}` : ''}
                {bucket.failures > 0 ? ` · ${t.telemetry.failed(bucket.failures)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * What the prompt was made of, by source (AR-09).
 *
 * Absent is not zero, and the contract is explicit about it: a run that predates the
 * recorder, or one whose log was capped before an honest conclusion could be drawn, says
 * nothing rather than reporting a comfortable nought.
 */
function ContextSection({ context }: { context: RunTelemetryView['context'] }) {
  const t = useT();
  if (context === undefined) {
    return (
      <Notice tone="ghost" k={t.telemetry.notObserved}>
        {t.telemetry.noContextRecorded}
      </Notice>
    );
  }

  return (
    <section className="doctor-section" aria-label={t.telemetry.promptMadeOf}>
      <div className="doctor-section__head">
        <h3>{t.telemetry.promptMadeOf}</h3>
        <p className="doctor-note">
          {t.telemetry.scope(context.scope.observations, context.scope.eventsScanned, context.scope.truncated)}
        </p>
      </div>

      {context.observations.length === 0 ? (
        <p className="doctor-note">{t.telemetry.nothingObserved}</p>
      ) : (
        <ul className="doctor-list">
          {context.observations.map((observation) => (
            <ObservationRow key={`${observation.stage}:${observation.source}`} observation={observation} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ObservationRow({ observation }: { observation: ContextTelemetryObservation }) {
  const t = useT();
  const detail: string[] = [];
  if (observation.estimatedInputTokens !== undefined) {
    detail.push(t.telemetry.tokensIn(observation.estimatedInputTokens.toLocaleString()));
  }
  if (observation.estimatedOutputTokens !== undefined) {
    detail.push(t.telemetry.tokensOut(observation.estimatedOutputTokens.toLocaleString()));
  }
  if (observation.estimatedAvoidedTokens !== undefined) {
    detail.push(t.telemetry.tokensAvoided(observation.estimatedAvoidedTokens.toLocaleString()));
  }
  if (observation.filesBefore !== undefined && observation.filesAfter !== undefined) {
    detail.push(t.telemetry.files(observation.filesBefore, observation.filesAfter));
  }
  if (observation.bypassReason !== undefined) {
    detail.push(t.telemetry.bypassed(word(t, observation.bypassReason)));
  }

  return (
    <li className="doctor-row" data-stage={observation.stage} data-source={observation.source}>
      <span className="doctor-row__name">{word(t, observation.stage)}</span>
      <span className="doctor-row__value">
        {detail.length === 0 ? t.telemetry.noEstimate : detail.join(' · ')}
      </span>
      {/* The source, which is the "by source" half of the question. */}
      <Chip tone="ghost" title={t.telemetry.provenance(observation.provenance)}>
        {word(t, observation.source)}
      </Chip>
    </li>
  );
}
