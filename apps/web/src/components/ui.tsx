import type { ReactNode } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import {
  AlertTriangle,
  Check,
  Circle,
  CircleDashed,
  Loader2,
  Search,
  X,
  type LucideIcon,
} from 'lucide-react';
import { TONE_BG, TONE_BORDER, TONE_DOT, TONE_TEXT, type Tone } from '../lib/status';

/**
 * The primitives everything else is built from (UI-07).
 *
 * The set is deliberately small, and the important thing about it is that there
 * are *two* surfaces rather than one. The first pass had a single `Card`, so
 * every region of the page — the run, the pipeline, each of five metrics, the
 * table, the inspector, four summaries — arrived as the same bordered rectangle
 * at the same visual weight. Sixteen boxes of equal importance is not a
 * hierarchy; it is a grid, and the eye has nothing to land on.
 *
 * So:
 *
 *   `Panel` is a place where work happens. The run, the tasks, the inspector.
 *   `Card`  is a place where a number lives. Secondary, lighter, quieter.
 *
 * Neither takes a colour. They take a *tone*, which `lib/status.ts` maps from a
 * real status — so no component decides for itself that a failed task is amber.
 */

export function cx(...values: (string | false | undefined | null)[]): string {
  return values.filter(Boolean).join(' ');
}

/**
 * A primary work surface.
 *
 * Has a border, because it genuinely is a separate region of the page. Its
 * header is part of the panel rather than a strip on top of it: no second
 * border, no darker bar, just a title and whatever belongs beside it, separated
 * from the body by one hairline where the content needs the separation.
 */
export function Panel(props: {
  children: ReactNode;
  className?: string;
  /** Rendered flush against the top of the panel, above the body. */
  header?: ReactNode;
  /** A single hairline under the header. Omit when the body supplies its own. */
  divided?: boolean;
}): JSX.Element {
  return (
    <section
      className={cx(
        'flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface',
        props.className,
      )}
    >
      {props.header === undefined ? null : (
        <div className={cx('shrink-0', props.divided === true && 'border-b border-border')}>
          {props.header}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">{props.children}</div>
    </section>
  );
}

/**
 * The header of a section inside a panel.
 *
 * Title on the left at 15px, anything else on the right. The reference puts the
 * task metrics here rather than in their own row of boxes, which is what buys
 * the table its vertical space back.
 */
export function SectionHeader(props: {
  title: ReactNode;
  children?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={cx('flex items-center justify-between gap-4 px-4 py-3', props.className)}>
      <h2 className="shrink-0 text-section font-semibold text-text">{props.title}</h2>
      {props.children}
    </div>
  );
}

/**
 * Secondary information. Quieter than a panel on purpose.
 *
 * Same border, flatter background, smaller header — so the bottom row reads as
 * a footnote to the screen rather than as four more things competing with the
 * table.
 */
export function Card(props: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  action?: ReactNode;
  /** A muted link-ish row pinned to the bottom, as in the reference. */
  footer?: ReactNode;
}): JSX.Element {
  return (
    <section
      className={cx(
        'flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface',
        props.className,
      )}
    >
      {props.title === undefined ? null : (
        <header className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2 pt-3">
          <h2 className="truncate whitespace-nowrap text-body-lg font-semibold text-text">
            {props.title}
          </h2>
          {props.action}
        </header>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-3">{props.children}</div>
      {props.footer === undefined ? null : (
        <footer className="shrink-0 border-t border-border px-3 py-1.5 text-micro text-faint">
          {props.footer}
        </footer>
      )}
    </section>
  );
}

export function Badge(props: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  /** Small-caps label styling. Off by default: badges carry data too. */
  caps?: boolean;
}): JSX.Element {
  const tone = props.tone ?? 'muted';
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-px',
        'text-micro font-medium',
        props.caps === true && 'uppercase tracking-wide',
        TONE_BG[tone],
        TONE_TEXT[tone],
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}

const TONE_ICON: Record<Tone, LucideIcon> = {
  success: Check,
  primary: Loader2,
  danger: X,
  warning: AlertTriangle,
  info: Circle,
  muted: CircleDashed,
};

/**
 * A status marker: ring, glyph, and — unless suppressed — a word.
 *
 * The word is not decoration. §97 requires status to be icon plus text as well
 * as colour, because a greyscale screenshot, a colour-blind reader and a glance
 * from across the desk all need the same answer.
 */
export function StatusDot(props: {
  tone: Tone;
  label: string;
  showLabel?: boolean;
  spin?: boolean;
  /** Filled ring, as the pipeline nodes use. */
  solid?: boolean;
  /**
   * The status is already stated visibly beside this marker.
   *
   * Then the marker is decoration and must say nothing: the table row shows a
   * status chip and the pipeline shows a status word, and a hidden label on top
   * of either makes a screen reader read the same status twice.
   */
  decorative?: boolean;
  className?: string;
}): JSX.Element {
  const Icon = TONE_ICON[props.tone];

  if (props.decorative === true) {
    return (
      <span
        className={cx(
          'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full',
          props.solid === true ? TONE_DOT[props.tone] : cx('border', TONE_BORDER[props.tone]),
          props.className,
        )}
        aria-hidden
      >
        <Icon
          className={cx(
            'h-2.5 w-2.5',
            props.solid === true ? 'text-bg' : TONE_TEXT[props.tone],
            props.spin === true && 'animate-spin',
          )}
        />
      </span>
    );
  }

  return (
    <span className={cx('inline-flex items-center gap-1.5', props.className)} title={props.label}>
      <span
        className={cx(
          'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
          props.solid === true ? TONE_DOT[props.tone] : cx('border', TONE_BORDER[props.tone]),
        )}
        aria-hidden
      >
        <Icon
          className={cx(
            'h-2.5 w-2.5',
            props.solid === true ? 'text-bg' : TONE_TEXT[props.tone],
            props.spin === true && 'animate-spin',
          )}
        />
      </span>
      <span className={cx('text-label', props.showLabel === false && 'sr-only')}>
        {props.label}
      </span>
    </span>
  );
}

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'surface';
  size?: 'sm' | 'md';
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  className?: string;
}): JSX.Element {
  const variant = props.variant ?? 'surface';

  return (
    <button
      type={props.type ?? 'button'}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-sm font-medium',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        props.size === 'sm' ? 'h-6 px-2 text-micro' : 'h-7 px-2.5 text-label',
        variant === 'primary' && 'bg-primary text-white hover:bg-primary-bright',
        variant === 'surface' &&
          'border border-border bg-surface-2 text-text hover:border-border-strong hover:bg-surface-3',
        variant === 'ghost' && 'text-muted hover:bg-surface-2 hover:text-text',
        props.className,
      )}
    >
      {props.children}
    </button>
  );
}

/**
 * A filter control, on a native `<select>`.
 *
 * Deliberately not a Radix listbox. Keyboard driving, type-ahead, screen-reader
 * announcement and the platform's own popover come free and cannot regress; the
 * only thing a custom widget would buy here is a matching chevron, and these are
 * filters on a developer tool, not a brand surface.
 */
export function Select<T extends string>(props: {
  label: string;
  value: T;
  options: readonly { readonly value: T; readonly label: string }[];
  onChange: (value: T) => void;
  className?: string;
}): JSX.Element {
  return (
    <label className={cx('flex shrink-0 items-center gap-1.5', props.className)}>
      <span className="whitespace-nowrap text-micro text-faint">{props.label}</span>
      <select
        value={props.value}
        onChange={(changed) => {
          props.onChange(changed.target.value as T);
        }}
        className={cx(
          'h-6 max-w-[168px] rounded-sm border border-border bg-surface-2 px-1.5 text-label text-text',
          'hover:border-border-strong focus:outline-none focus:ring-1 focus:ring-primary-bright',
        )}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A search box. The same shape the task table already uses, in one place. */
export function SearchInput(props: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  className?: string;
}): JSX.Element {
  return (
    <label
      className={cx(
        'flex min-w-0 items-center gap-1.5 rounded-sm border border-border bg-surface-2 px-2 py-1',
        'focus-within:border-border-strong',
        props.className,
      )}
    >
      <Search className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
      <span className="sr-only">{props.label}</span>
      <input
        value={props.value}
        onChange={(changed) => {
          props.onChange(changed.target.value);
        }}
        placeholder={props.placeholder}
        className="w-full bg-transparent text-label text-text placeholder:text-faint focus:outline-none"
      />
    </label>
  );
}

export function Progress(props: {
  value: number;
  tone?: Tone;
  className?: string;
  label?: string;
}): JSX.Element {
  const value = Math.max(0, Math.min(100, props.value));
  const tone = props.tone ?? 'primary';

  return (
    <div
      className={cx('h-1.5 w-full overflow-hidden rounded-full bg-surface-3', props.className)}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={props.label ?? 'progress'}
    >
      <div
        className={cx('h-full rounded-full transition-all', TONE_DOT[tone])}
        style={{ width: `${String(value)}%` }}
      />
    </div>
  );
}

export function Tooltip(props: { content: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <TooltipPrimitive.Root delayDuration={200}>
      <TooltipPrimitive.Trigger asChild>{props.children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          sideOffset={6}
          className="z-50 max-w-xs rounded-sm border border-border-strong bg-surface-3 px-2 py-1 text-micro text-text shadow-xl"
        >
          {props.content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export function Empty(props: {
  title: string;
  hint?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cx(
        'flex h-full flex-col items-center justify-center gap-1 p-6 text-center',
        props.className,
      )}
    >
      <p className="text-body text-muted">{props.title}</p>
      {props.hint === undefined ? null : <p className="text-micro text-faint">{props.hint}</p>}
    </div>
  );
}

/**
 * One entry in a strip of counts, separated by hairlines rather than boxed.
 *
 * This is what replaced five bordered metric cards. The information is the same
 * and it occupies a fifth of the height, which the table gets instead.
 */
export function StripItem(props: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 px-4 first:pl-0 last:pr-0">
      <span
        className={cx(
          'whitespace-nowrap text-micro',
          props.tone === undefined ? 'text-faint' : TONE_TEXT[props.tone],
        )}
      >
        {props.label}
      </span>
      <span className="flex items-center gap-1">
        {props.icon}
        <span
          className={cx(
            'tabular text-metric font-semibold',
            props.tone === undefined ? 'text-text' : TONE_TEXT[props.tone],
          )}
        >
          {props.value}
        </span>
      </span>
    </div>
  );
}

/** A label/value pair in a horizontal metadata row, as the inspector uses. */
export function MetaCell(props: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="whitespace-nowrap text-micro text-faint">{props.label}</dt>
      <dd className="truncate text-label text-text">{props.value}</dd>
    </div>
  );
}

export { TooltipPrimitive };
