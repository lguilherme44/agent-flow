import { useLayoutEffect, useRef, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
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
        // `tracking-caps` is 0.08em. `tracking-wide` was 0.025em, which is
        // under the 0.06em floor upper-case needs to stop reading as cramped.
        props.caps === true && 'uppercase tracking-caps',
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
            // Violet is the one solid tone dark enough to need light glyph:
            // #070b14 on #7c3aed is 3.45:1, white is 5.70:1. The other four
            // solid tones are light, where the page ground is the readable one.
            props.solid !== true
              ? TONE_TEXT[props.tone]
              : props.tone === 'primary'
                ? 'text-white'
                : 'text-bg',
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
            // Violet is the one solid tone dark enough to need light glyph:
            // #070b14 on #7c3aed is 3.45:1, white is 5.70:1. The other four
            // solid tones are light, where the page ground is the readable one.
            props.solid !== true
              ? TONE_TEXT[props.tone]
              : props.tone === 'primary'
                ? 'text-white'
                : 'text-bg',
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
  /**
   * Marks a button that turns something on and leaves it on.
   *
   * A toggle that only looked different is a toggle a screen reader cannot
   * report the state of, and colour alone is not a state (§97).
   */
  pressed?: boolean;
  className?: string;
}): JSX.Element {
  const variant = props.variant ?? 'surface';

  return (
    <button
      type={props.type ?? 'button'}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      aria-pressed={props.pressed}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-sm font-medium',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        // Button text is a value a person acts on, so it takes the working
        // size. 28px tall at 12px text was a control you had to lean in to.
        props.size === 'sm' ? 'h-6 px-2 text-label' : 'h-7 px-2.5 text-body-lg',
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
          'h-7 max-w-[176px] rounded-sm border border-border bg-surface-2 px-2 text-body-lg text-text',
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
        className="w-full bg-transparent text-body-lg text-text placeholder:text-faint focus:outline-none"
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
          className="z-50 max-w-xs rounded-sm border border-border-strong bg-surface-3 px-2 py-1 text-label text-text shadow-xl"
        >
          {props.content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/**
 * Something went wrong, or something is missing, said the way §95 asks.
 *
 * Four things, in this order: what happened, where, whether the workflow stopped,
 * and what to do about it. They are separate props rather than one sentence
 * because a reader uses them differently — the first two explain, the third
 * decides whether to panic, and the last is the only one they can act on.
 *
 * The third is the one that keeps getting dropped, and it is the one that
 * matters most: "the plan review used the same provider" and "the run stopped"
 * are both worth showing and mean entirely different things about whether
 * anybody needs to do something right now.
 *
 * A notice belongs beside the content it is about. A toast for everything is how
 * a dashboard ends up with an error nobody can locate.
 */
export function Notice(props: {
  tone: 'warning' | 'danger' | 'info';
  /** What happened. One line, in words a person reads. */
  title: ReactNode;
  /** Where — a command, a task, a file. Rendered as evidence, not prose. */
  detail?: ReactNode;
  /** Whether the workflow stopped, when that is not obvious from the title. */
  consequence?: ReactNode;
  /** What to do next. Buttons, or a sentence naming a command. */
  action?: ReactNode;
  className?: string;
}): JSX.Element {
  const Icon = props.tone === 'info' ? Circle : AlertTriangle;

  return (
    <div
      role={props.tone === 'danger' ? 'alert' : 'status'}
      className={cx(
        'flex flex-col gap-1.5 rounded-md border px-3 py-2',
        props.tone === 'danger' && 'border-danger/25 bg-danger-soft',
        props.tone === 'warning' && 'border-warning/25 bg-warning-soft',
        props.tone === 'info' && 'border-info/25 bg-info-soft',
        props.className,
      )}
    >
      {/* The first line is what happened, and it is the one line somebody reads
          from across the desk — so it takes the working size, not the floor. */}
      <span className="flex items-start gap-2 text-body-lg text-text">
        <Icon
          className={cx('mt-px h-3.5 w-3.5 shrink-0', TONE_TEXT[props.tone])}
          aria-hidden
        />
        <span className="min-w-0">{props.title}</span>
      </span>

      {props.detail === undefined ? null : (
        <div className="overflow-x-auto pl-5 font-mono text-label text-muted">{props.detail}</div>
      )}
      {props.consequence === undefined ? null : (
        <span className="pl-5 text-label text-muted">{props.consequence}</span>
      )}
      {props.action === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2 pl-5 pt-0.5 text-label text-muted">
          {props.action}
        </div>
      )}
    </div>
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
      <p className="text-body-lg text-muted">{props.title}</p>
      {props.hint === undefined ? null : <p className="text-label text-faint">{props.hint}</p>}
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
  /**
   * A zero is an absence, and absence does not get a colour.
   *
   * The strip painted its tone on every count unconditionally, so a run with
   * nothing wrong rendered `FAILED 0` in danger red and `RUNNING 0` in info blue
   * at the same weight as the counts that carried news. Two of the five loudest
   * things on the panel were reporting that nothing had happened.
   *
   * Colour here is meant to say "look at this". When the value is zero there is
   * nothing to look at, so the item recedes to the neutral pair and the eye lands
   * on the counts that are actually non-zero. Nothing is hidden: the label, the
   * number and the position are unchanged, which is what keeps the strip
   * scannable as a fixed set rather than a list that reshuffles.
   */
  const empty = props.value === 0 || props.value === '0';
  const tone = empty ? undefined : props.tone;

  return (
    <div className="flex flex-col gap-0.5 px-4 first:pl-0 last:pr-0">
      <span
        className={cx(
          'whitespace-nowrap text-micro uppercase tracking-caps',
          tone === undefined ? 'text-faint' : TONE_TEXT[tone],
        )}
      >
        {props.label}
      </span>
      <span className="flex items-center gap-1">
        {props.icon}
        <span
          className={cx(
            'tabular text-metric font-semibold',
            tone === undefined ? (empty ? 'text-faint' : 'text-text') : TONE_TEXT[tone],
          )}
        >
          {props.value}
        </span>
      </span>
    </div>
  );
}

/**
 * A label/value pair in a horizontal metadata row, as the inspector uses.
 *
 * `title` exists for the values that genuinely may not fit — a path, a list of
 * roles. Truncation with nothing behind it reads as deliberate; truncation with a
 * tooltip reads as an abbreviation.
 */
export function MetaCell(props: {
  label: string;
  value: ReactNode;
  title?: string;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {/* Caption stays at the floor; the value it captions does not. This pair
          is the single most repeated shape in the inspector. */}
      <dt className="whitespace-nowrap text-micro uppercase tracking-caps text-faint">
        {props.label}
      </dt>
      <dd className="truncate text-body-lg text-text" title={props.title}>
        {props.value}
      </dd>
    </div>
  );
}

/**
 * The one modal in this app (§97).
 *
 * Radix supplies everything that is hard and easy to get wrong: `aria-modal`, a
 * focus trap, Escape, dismissal on an outside click, and `aria-hidden` on
 * everything else so a screen reader finds one dialog rather than a page with a
 * panel floating over it. Every dialog in the app goes through here, so none of
 * them can be the one that forgot.
 *
 * Focus return is the exception Radix does not cover: a modal `Dialog.Content`
 * overrides its own restore to focus a `Dialog.Trigger`, and the triggers here are
 * ordinary buttons rendered wherever they belong. The element that had focus is
 * captured in a layout effect — before the passive effect inside Radix moves it —
 * and given it back on close.
 */
export function Dialog(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Pinned to the bottom, separated by a hairline. Buttons belong here. */
  footer?: ReactNode;
  className?: string;
}): JSX.Element {
  const opener = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (props.open) opener.current = document.activeElement as HTMLElement | null;
  }, [props.open]);

  return (
    <DialogPrimitive.Root
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <DialogPrimitive.Content
          aria-modal="true"
          onCloseAutoFocus={(event) => {
            const target = opener.current;
            if (target === null || !document.contains(target)) return;
            event.preventDefault();
            target.focus({ preventScroll: true });
          }}
          className={cx(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[86vh] w-[min(560px,92vw)] -translate-x-1/2',
            '-translate-y-1/2 flex-col rounded-lg border border-border-strong bg-surface shadow-2xl',
            props.className,
          )}
        >
          <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div className="flex min-w-0 flex-col gap-1">
              <DialogPrimitive.Title className="text-section font-semibold text-text">
                {props.title}
              </DialogPrimitive.Title>
              {props.description === undefined ? null : (
                <DialogPrimitive.Description className="text-body-lg text-muted">
                  {props.description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close className="shrink-0 rounded-sm p-1 text-faint hover:bg-surface-2 hover:text-text">
              <X className="h-4 w-4" aria-hidden />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </header>

          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">{props.children}</div>

          {props.footer === undefined ? null : (
            <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
              {props.footer}
            </footer>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * A refusal, as §95 asks for it: what happened, and what to do about it.
 *
 * The two are separate fields on the wire and stay separate here, because a person
 * reads them differently — one explains, the other instructs. Rendered wherever an
 * action can be refused, so a refusal never arrives as a bare sentence.
 */
export function ActionRefusal(props: {
  error: unknown;
  /** Prefix for the first line, when the caller has better words than the server. */
  title?: string;
}): JSX.Element | null {
  if (props.error === null || props.error === undefined) return null;

  const api = props.error as {
    message?: unknown;
    action?: unknown;
    code?: unknown;
  };
  const message = typeof api.message === 'string' ? api.message : 'The action failed.';
  const action = typeof api.action === 'string' ? api.action : undefined;
  const code = typeof api.code === 'string' ? api.code : undefined;

  return (
    <div
      role="alert"
      className="flex flex-col gap-1 rounded-md border border-danger/25 bg-danger-soft px-3 py-2"
    >
      <span className="flex items-start gap-2 text-body-lg text-text">
        <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-danger" aria-hidden />
        <span>
          {props.title === undefined ? null : <strong className="font-medium">{props.title} </strong>}
          {message}
        </span>
      </span>
      {action === undefined ? null : <span className="pl-5 text-label text-muted">{action}</span>}
      {code === undefined ? null : (
        <span className="pl-5 font-mono text-label text-faint">{code}</span>
      )}
    </div>
  );
}

export { TooltipPrimitive };
