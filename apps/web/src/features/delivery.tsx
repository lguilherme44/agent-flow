import type { JSX } from 'react';
import { ExternalLink } from 'lucide-react';
import type { DeliveryView } from '@contracts/index.js';
import { Badge, MetaCell, Panel, SectionHeader, cx } from '../components/ui';
import type { Tone } from '../lib/status';
import { useDelivery } from '../lib/queries';
import { formatWhenCompact } from '../lib/format';

/**
 * Where this run went (M7 §57, M7-A12; M8.5 §18).
 *
 * **Rebuilt on the design system, and it had never been on one.** Every class this file
 * used — `card`, `card__header`, `delivery__detail`, `delivery__facts`,
 * `delivery__checks`, `delivery__check--success`, `badge--delivery-published` — was
 * defined in no stylesheet in the repository, and none of them is a Tailwind utility
 * either. The panel rendered as raw HTML: an unstyled `<h2>`, a `<dl>` with browser
 * default margins and a bulleted `<ul>`, inside an app where every other panel is a
 * `Panel`.
 *
 * **Nothing was ever going to catch it.** A class nobody defines fails no compiler, no
 * linter and no DOM assertion — the element exists, it simply has no style. And the only
 * delivery fixture in the repository is `DELIVERY_NONE`, whose state is `disabled`, so
 * the guard clause below returned `null` in every unit test and every one of the 296
 * visual baselines. A component no fixture renders is a component with no guaranteed
 * appearance; this one had none for two milestones.
 *
 * **Renders the projection and derives none of it.** Whether delivery is pending, green,
 * red or diverged arrives decided; a browser that folded a check list into a verdict
 * would disagree with the server the first time the treatment of an unknown conclusion
 * changed, and the disagreement would look like a caching bug rather than a second
 * authority.
 *
 * **Absent rather than empty when nothing is configured.** Most runs deliver nowhere.
 * That absence is now also what removes the Delivery *tab*, so a run with no forge does
 * not carry a door to an empty room.
 */
export function DeliveryPanel({
  projectId,
  runId,
}: {
  projectId: string | undefined;
  runId: string | undefined;
}): JSX.Element | null {
  const { data } = useDelivery(projectId, runId);

  if (data === undefined || data.state === 'disabled') return null;

  return (
    <Panel
      className="min-h-0 flex-1"
      divided
      header={
        <SectionHeader title="Delivery">
          <StateBadge state={data.state} />
        </SectionHeader>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
        <p className="text-body-lg text-text">{data.detail}</p>

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {data.repository === undefined ? null : (
            <MetaCell label="Repository" value={data.repository} title={data.repository} />
          )}
          {data.branch === undefined || data.publishedCommit === undefined ? null : (
            <MetaCell
              label="Published"
              value={
                <span className="tabular font-mono">
                  {data.publishedCommit.slice(0, 8)} → {data.branch}
                </span>
              }
              title={`${data.publishedCommit} → ${data.branch}`}
            />
          )}
          {data.issue === undefined ? null : (
            <MetaCell
              label="Issue"
              value={<Outbound href={data.issue.url} label={`#${String(data.issue.number)}`} />}
            />
          )}
          {data.pullRequest === undefined ? null : (
            <MetaCell
              label="Pull request"
              value={
                <Outbound
                  href={data.pullRequest.url}
                  label={`#${String(data.pullRequest.number)} · ${data.pullRequest.state}`}
                />
              }
            />
          )}
          {data.syncedAt === undefined ? null : (
            /* **Formatted, and the first photograph of this panel is what said so.** It
               printed `2026-08-10T20:02:00.000Z` — a raw ISO string, in an app where every
               other instant goes through `formatWhenCompact`. No assertion could see it:
               the value was there, it was correct, and it was the only unformatted date on
               any screen. A component nothing renders has no chance to look wrong. */
            <MetaCell label="Last sync" value={formatWhenCompact(data.syncedAt)} title={data.syncedAt} />
          )}
        </dl>

        {/* The refusal, in the domain's vocabulary rather than an HTTP code — and it was
            rendered nowhere before this. `ForgeFailure` has been on the projection since
            M7 and neither the old panel nor anything else drew it, so a run whose
            publication was refused for want of a token showed the state and never the
            reason. `detail` is written for a person and carries no token, header or raw
            response body by contract. */}
        {data.failure === undefined ? null : (
          <div
            role="alert"
            className="flex flex-col gap-1 rounded-md border border-danger/25 bg-danger-soft px-3 py-2"
          >
            <span className="text-body-lg text-text">{data.failure.detail}</span>
            <span className="font-mono text-label text-faint">{data.failure.code}</span>
          </div>
        )}

        {data.checks.length > 0 ? <Checks view={data} /> : null}
      </div>
    </Panel>
  );
}

/**
 * The checks, with the sentence that has to be on the page.
 *
 * A person who sees red here and nothing else concludes the run failed. It did not, and
 * the panel says so where they are looking rather than in a document.
 */
function Checks({ view }: { view: DeliveryView }): JSX.Element {
  const { total, green, red, pending } = view.checkSummary;

  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-surface-2 p-3">
      <h3 className="flex flex-wrap items-baseline gap-x-2 text-body-lg font-semibold text-text">
        Remote checks
        <span className="tabular text-label font-normal text-muted">
          {green}/{total} passed
          {red > 0 ? `, ${String(red)} failed` : ''}
          {pending > 0 ? `, ${String(pending)} pending` : ''}
        </span>
      </h3>

      <ul className="flex flex-col gap-1">
        {view.checks.slice(0, 12).map((check) => (
          <li key={check.id} className="flex min-w-0 items-center gap-2">
            {/* Status in words as well as colour, which §97 has required since the first
                panel — and the words are the check's own conclusion, never a verdict this
                file folded from them. */}
            <Badge tone={checkTone(check.conclusion ?? check.status)} caps className="shrink-0">
              {(check.conclusion ?? check.status).replace(/_/g, ' ')}
            </Badge>
            {check.url === undefined ? (
              <span className="min-w-0 truncate text-label text-text">{check.name}</span>
            ) : (
              <Outbound href={check.url} label={check.name} className="min-w-0 truncate" />
            )}
          </li>
        ))}
      </ul>

      {view.checks.length > 12 ? (
        <p className="text-micro text-faint">
          Showing 12 of {view.checks.length}. The forge has the rest.
        </p>
      ) : null}

      <p className="text-label text-muted">
        These are observations. The local quality decision is already made, and a check
        here does not change it in either direction.
      </p>
    </section>
  );
}

/**
 * A check's own reported conclusion, coloured.
 *
 * **This maps a string to a tone and decides nothing.** M6's architecture rules forbid
 * the browser from turning an exit code into a `GateStatus` or weighing `required`
 * against a status, and both stay true: a remote check's conclusion is a word GitHub
 * chose, this returns a colour for it, and nothing here can make a red check block or a
 * green one pass. Anything the switch does not recognise is `muted` — the honest answer
 * for a conclusion this build has not seen, and better than a confident colour.
 */
function checkTone(word: string): Tone {
  switch (word) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
      return 'danger';
    case 'cancelled':
    case 'action_required':
    case 'stale':
      return 'warning';
    case 'in_progress':
    case 'queued':
    case 'pending':
      return 'info';
    default:
      return 'muted';
  }
}

/**
 * The delivery state, in words and in colour.
 *
 * **`checks_red` is warning rather than danger, and that is M7's rule rather than a
 * preference.** A person who sees the mark they associate with a failed run concludes the
 * run failed, and it did not: the local quality decision is already made and a remote
 * check does not move it. `delivery_failed` is danger, because that one genuinely is this
 * machine failing to do what it was asked.
 *
 * Exhaustive over `DeliveryState`, so adding a state to the contract is a compile error
 * here rather than a badge that silently falls back to grey. The first draft of this map
 * invented `pending`, `diverged` and `failed` — none of which the contract has — and the
 * compiler is what said so.
 */
const STATE_TONE: Record<DeliveryView['state'], Tone> = {
  disabled: 'muted',
  not_published: 'muted',
  published: 'info',
  pr_open: 'info',
  checks_pending: 'info',
  checks_green: 'success',
  checks_red: 'warning',
  remote_diverged: 'warning',
  delivery_failed: 'danger',
};

function StateBadge({ state }: { state: DeliveryView['state'] }): JSX.Element {
  return (
    <Badge tone={STATE_TONE[state]} caps>
      {state.replace(/_/g, ' ')}
    </Badge>
  );
}

/** A link that leaves this machine, marked as one. */
function Outbound(props: { href: string; label: string; className?: string }): JSX.Element {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer"
      className={cx(
        'inline-flex items-center gap-1 text-body-lg text-text underline decoration-border underline-offset-2 hover:decoration-text',
        props.className,
      )}
    >
      <span className="min-w-0 truncate">{props.label}</span>
      <ExternalLink className="h-3 w-3 shrink-0 text-faint" aria-hidden />
    </a>
  );
}
