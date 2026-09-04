import { useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, ChevronDown } from 'lucide-react';
import type { AttentionItem, AttentionFocus, AttentionPriority } from '@contracts/index.js';
import { Badge, Empty, Panel, SectionHeader, cx } from '../components/ui';
import type { Tone } from '../lib/status';
import { formatWhenCompact } from '../lib/format';

/**
 * What needs a person, most urgent first (M8 §4, §13).
 *
 * **Nothing here is decided in the browser.** The priority, the sentence, the one
 * recommended action and the order all arrive from `core/attention.ts`. This component
 * renders a list and turns a scope into a URL, which is the only thing it is allowed to
 * decide — routing is presentation, and the domain must not know about `?view=board`.
 *
 * The list is deliberately not dismissible. A failed gate, a stale review and a diverged
 * remote go away when the *fact* goes away; a row somebody could close is a row that
 * disappears while the problem does not.
 */

const PRIORITY_TONE: Record<AttentionPriority, Tone> = {
  P0: 'danger',
  P1: 'warning',
  P2: 'danger',
  P3: 'info',
  P4: 'muted',
};

/**
 * What each rung means, in words.
 *
 * Beside the badge rather than instead of it: `P1` is a sort key and not a sentence, and a
 * person reading the queue for the first time has no reason to know that P1 outranks P2.
 */
const PRIORITY_LABEL: Record<AttentionPriority, string> = {
  P0: 'integrity',
  P1: 'needs a decision',
  P2: 'failed',
  P3: 'degraded',
  P4: 'for information',
};

/**
 * A scope and a focus become a route.
 *
 * The one mapping in the app, so a queue row and a card click cannot land in different
 * places for the same object. `focus` is exhaustive, so adding a surface to the contract
 * is a compile error here rather than a row that silently links to the run.
 */
export function routeFor(item: AttentionItem, projectId?: string): string {
  const project = projectId === undefined ? '' : `&project=${encodeURIComponent(projectId)}`;
  const base = `/runs/${encodeURIComponent(item.scope.runId)}`;

  const focus: AttentionFocus = item.focus;
  switch (focus) {
    case 'task':
      return item.scope.taskId === undefined
        ? `${base}?view=board${project}`
        : `${base}?view=board&task=${encodeURIComponent(item.scope.taskId)}${project}`;
    case 'plan':
      return `${base}?panel=approval${project}`;
    case 'review':
      return `${base}?panel=review${project}`;
    case 'quality':
      return `${base}?panel=quality${project}`;
    case 'delivery':
      return `${base}?panel=delivery${project}`;
    case 'team':
      return `${base}?panel=team${project}`;
    case 'run':
      return `${base}?${project.slice(1)}`;
    default: {
      const exhaustive: never = focus;
      void exhaustive;
      return base;
    }
  }
}

export function AttentionRow(props: {
  item: AttentionItem;
  projectId?: string;
  /** Shown on the workspace home, where one queue spans several runs. */
  showRun?: boolean;
}): JSX.Element {
  const { item } = props;

  return (
    <li className="border-b border-border last:border-b-0">
      <Link
        to={routeFor(item, props.projectId)}
        className={cx(
          'group flex items-start gap-3 px-4 py-2.5',
          'hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none',
          'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary',
        )}
      >
        {/* Priority is a word as well as a colour (§97): a greyscale screenshot and a
            colour-blind reader need the same answer a glance gets. */}
        <Badge tone={PRIORITY_TONE[item.priority]} caps className="mt-0.5 shrink-0">
          {item.priority}
        </Badge>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-body-lg font-medium text-text">{item.what}</span>
            {props.showRun !== true ? null : (
              <span className="tabular text-micro text-faint">{item.scope.runId}</span>
            )}
          </span>
          {/* The fact this was folded from, in the operator's vocabulary. Never
              "check the logs" — the projection refuses to emit one.

              Clamped to two lines, because it quotes text nobody here wrote: a degradation
              impact runs to 180 characters and a forge failure can be longer. An unbounded
              row makes the queue's height depend on the worst sentence in it, and the item
              below it is the one that then falls off the screen. */}
          <span className="mt-0.5 line-clamp-2 block text-label text-muted">{item.why}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-faint">
            <span>{PRIORITY_LABEL[item.priority]}</span>
            <span>·</span>
            <span>{formatWhenCompact(item.since)}</span>
            {item.scope.taskId === undefined ? null : (
              <>
                <span>·</span>
                <span className="tabular">{item.scope.taskId}</span>
              </>
            )}
          </span>
        </span>

        {/* Exactly one action, and it is the projection's. Ten buttons per row is how a
            queue becomes something people scroll past. */}
        <span className="flex shrink-0 items-center gap-1 self-center text-label text-muted group-hover:text-text">
          {item.action.label}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </span>
      </Link>
    </li>
  );
}

/**
 * Attention on the run screen: a strip, never a panel (M8.5 §9).
 *
 * **The queue was a bordered panel with a title, a count and up to four rows, capped at
 * 22rem.** On a run with three items that is 350 pixels of the always-visible layer,
 * above a board that had 555 — and its *title* said "Needs attention" over rows whose
 * whole point is that they need attention.
 *
 * §9's three cases, exactly:
 *
 *   nothing        → nothing is rendered, and no space is reserved
 *   one item       → one strip: what happened, why it matters, one action
 *   several items  → the same strip for the top one, and the rest one line each
 *                    behind a disclosure that says how many
 *
 * The top item is the projection's top item. Nothing here re-ranks: the ladder, the
 * tie-break and the order are `core/attention.ts`, and a strip that sorted its own rows
 * would be a second queue whose first row disagrees with the queue everywhere else.
 *
 * The list is deliberately not dismissible. A failed gate, a stale review and a diverged
 * remote go away when the *fact* goes away; a row somebody could close is a row that
 * disappears while the problem does not.
 */
export function AttentionStrip(props: {
  items: readonly AttentionItem[];
  projectId?: string;
  className?: string;
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const [lead, ...rest] = props.items;

  if (lead === undefined) return null;

  const tone = PRIORITY_TONE[lead.priority];

  return (
    <section
      aria-label={`${String(props.items.length)} ${props.items.length === 1 ? 'item needs' : 'items need'} attention`}
      className={cx(
        'flex shrink-0 flex-col rounded-md border',
        // The tone carries the consequence and the badge carries the cause, which is the
        // same split the review panel makes between a colour and a word. A P0 and a P4
        // must not arrive in the same paint.
        tone === 'danger'
          ? 'border-danger/25 bg-danger-soft'
          : tone === 'warning'
            ? 'border-warning/25 bg-warning-soft'
            : 'border-border bg-surface-2',
        props.className,
      )}
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <Badge tone={tone} caps className="shrink-0">
          {lead.priority}
        </Badge>

        <Link
          to={routeFor(lead, props.projectId)}
          className="group flex min-w-0 flex-1 items-center gap-3 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body-lg font-medium text-text">{lead.what}</span>
            {/* The fact this was folded from, in the operator's vocabulary. Never "check
                the logs" — the projection refuses to emit one. One line here rather than
                two: the strip is the summary, and the row it links to holds the rest. */}
            <span className="block truncate text-label text-muted">{lead.why}</span>
          </span>

          {/* Exactly one action, and it is the projection's. */}
          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-label text-muted group-hover:text-text max-lg:hidden">
            {lead.action.label}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </span>
        </Link>

        {rest.length === 0 ? null : (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => {
              setExpanded((open) => !open);
            }}
            className="flex shrink-0 items-center gap-1 rounded-sm border border-border-strong px-1.5 py-0.5 text-micro text-muted hover:text-text"
          >
            <span className="tabular">{rest.length}</span> more
            <ChevronDown
              className={cx('h-3 w-3 transition-transform', expanded && 'rotate-180')}
              aria-hidden
            />
          </button>
        )}
      </div>

      {expanded && rest.length > 0 ? (
        <ul className="border-t border-border/60">
          {rest.map((item) => (
            <li key={item.id} className="border-b border-border/40 last:border-b-0">
              <Link
                to={routeFor(item, props.projectId)}
                className="group flex items-center gap-2.5 px-3 py-1.5 hover:bg-surface-3 focus-visible:bg-surface-3 focus-visible:outline-none"
              >
                <Badge tone={PRIORITY_TONE[item.priority]} caps className="shrink-0">
                  {item.priority}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-label text-text">{item.what}</span>
                <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-micro text-muted group-hover:text-text max-lg:hidden">
                  {item.action.label}
                  <ArrowRight className="h-3 w-3" aria-hidden />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function AttentionQueue(props: {
  items: readonly AttentionItem[];
  projectId?: string;
  showRun?: boolean;
  title?: string;
  className?: string;
  /**
   * The queue could not be read.
   *
   * Carried separately from an empty list because the two are opposite facts wearing the
   * same shape. "No items need attention" over a failed read is the one sentence this
   * whole milestone exists to prevent — it is `Everything healthy` with extra steps.
   */
  unread?: boolean;
}): JSX.Element {
  const items = props.items;

  return (
    <Panel
      {...(props.className === undefined ? {} : { className: props.className })}
      divided
      header={
        <SectionHeader title={props.title ?? 'Needs attention'}>
          {items.length === 0 ? null : (
            <span className="flex items-center gap-1.5 text-label text-muted">
              <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-hidden />
              <span className="tabular">{items.length}</span>
            </span>
          )}
        </SectionHeader>
      }
    >
      {props.unread === true ? (
        <Empty
          title="Attention could not be read"
          hint="Nothing here is stale — it is absent, which is a different thing."
        />
      ) : items.length === 0 ? (
        // Factual, never "everything healthy". A run whose required-CI evidence has not
        // been observed is not healthy; it is unobserved, and those are different
        // sentences (M8 §63).
        <Empty title="No items need attention" hint="Items appear from facts and leave when the facts do." />
      ) : (
        <ul aria-label={`${String(items.length)} items need attention`} className="min-h-0 overflow-auto">
          {items.map((item) => (
            <AttentionRow
              key={item.id}
              item={item}
              {...(props.projectId === undefined ? {} : { projectId: props.projectId })}
              {...(props.showRun === undefined ? {} : { showRun: props.showRun })}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}
