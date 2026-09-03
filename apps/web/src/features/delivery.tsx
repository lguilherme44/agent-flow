import type { DeliveryView } from '../../../../src/core/forge/delivery.js';
import { useDelivery } from '../lib/queries';

/**
 * Where this run went (M7 §57, M7-A12).
 *
 * **Renders the projection and derives none of it.** Whether delivery is pending, green,
 * red or diverged arrives decided; a browser that folded a check list into a verdict would
 * disagree with the server the first time the treatment of an unknown conclusion changed,
 * and the disagreement would look like a caching bug rather than a second authority.
 *
 * **Absent rather than empty when nothing is configured.** Most runs deliver nowhere, and
 * a permanent "no forge" box teaches people to skip the row it lives in — which is the
 * same reasoning the collaboration and review panels already follow.
 */
export function DeliveryPanel({
  projectId,
  runId,
}: {
  projectId: string | undefined;
  runId: string | undefined;
}): React.JSX.Element | null {
  const { data } = useDelivery(projectId, runId);

  if (data === undefined || data.state === 'disabled') return null;

  return (
    <section className="card" aria-labelledby="delivery-heading">
      <header className="card__header">
        <h2 id="delivery-heading">Delivery</h2>
        <StateBadge state={data.state} />
      </header>

      <p className="delivery__detail">{data.detail}</p>

      <dl className="delivery__facts">
        {data.repository !== undefined && <Fact label="Repository" value={data.repository} />}
        {data.branch !== undefined && data.publishedCommit !== undefined && (
          <Fact label="Published" value={`${data.publishedCommit.slice(0, 8)} → ${data.branch}`} />
        )}
        {data.issue !== undefined && (
          <Fact label="Issue" value={`#${String(data.issue.number)}`} href={data.issue.url} />
        )}
        {data.pullRequest !== undefined && (
          <Fact
            label="Pull request"
            value={`#${String(data.pullRequest.number)} · ${data.pullRequest.state}`}
            href={data.pullRequest.url}
          />
        )}
        {data.syncedAt !== undefined && <Fact label="Last sync" value={data.syncedAt} />}
      </dl>

      {data.checks.length > 0 && <Checks view={data} />}
    </section>
  );
}

/**
 * The checks, with the sentence that has to be on the page.
 *
 * A person who sees red here and nothing else concludes the run failed. It did not, and
 * the panel says so where they are looking rather than in a document.
 */
function Checks({ view }: { view: DeliveryView }): React.JSX.Element {
  const { total, green, red, pending } = view.checkSummary;

  return (
    <div className="delivery__checks">
      <h3>
        Remote checks{' '}
        <span className="delivery__checks-count">
          {green}/{total} passed
          {red > 0 && `, ${String(red)} failed`}
          {pending > 0 && `, ${String(pending)} pending`}
        </span>
      </h3>

      <ul className="delivery__check-list">
        {view.checks.slice(0, 12).map((check) => (
          <li key={check.id}>
            <span className={`delivery__check delivery__check--${check.conclusion ?? check.status}`}>
              {check.conclusion ?? check.status.replace(/_/g, ' ')}
            </span>{' '}
            {check.url === undefined ? (
              check.name
            ) : (
              <a href={check.url} target="_blank" rel="noreferrer">
                {check.name}
              </a>
            )}
          </li>
        ))}
      </ul>

      <p className="delivery__note">
        These are observations. The local quality decision is already made, and a check here
        does not change it in either direction.
      </p>
    </div>
  );
}

function Fact({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href?: string;
}): React.JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {href === undefined ? (
          value
        ) : (
          <a href={href} target="_blank" rel="noreferrer">
            {value}
          </a>
        )}
      </dd>
    </>
  );
}

/** Status in words as well as colour, which §97 has required since the first panel. */
function StateBadge({ state }: { state: DeliveryView['state'] }): React.JSX.Element {
  return (
    <span className={`badge badge--delivery-${state}`}>{state.replace(/_/g, ' ')}</span>
  );
}
