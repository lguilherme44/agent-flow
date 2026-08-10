import type { ReactNode } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import {
  AlertTriangle,
  Check,
  CircleDashed,
  Loader2,
  Pause,
  X,
  type LucideIcon,
} from 'lucide-react';
import { TONE_BG, TONE_DOT, TONE_TEXT, type Tone } from '../lib/status';

/**
 * The primitives everything else is built from (UI-07).
 *
 * Small on purpose. A dashboard needs a surface, a label, a status marker and a
 * bar; anything more elaborate here would be a component library nobody asked
 * for, and every extra prop is a decision the pages stop making consistently.
 *
 * None of these take a colour. They take a *tone*, which `lib/status.ts` maps
 * from a real status — so no component can decide for itself that a failed task
 * is amber.
 */

export function cx(...values: (string | false | undefined | null)[]): string {
  return values.filter(Boolean).join(' ');
}

export function Card(props: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <section
      className={cx(
        'rounded-lg border border-border bg-surface',
        'flex min-h-0 flex-col',
        props.className,
      )}
    >
      {props.title === undefined ? null : (
        <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
          {/* Fixed-height header, so the title must never wrap into it. A
              two-line "Model Usage" pushed the card's own content out of view. */}
          <h2 className="truncate whitespace-nowrap text-label font-medium uppercase tracking-wide text-muted">
            {props.title}
          </h2>
          {props.action}
        </header>
      )}
      {/* Scrolls rather than clips. A card with more rows than fit used to hide
          the rest with nothing to indicate they existed. */}
      <div className="min-h-0 flex-1 overflow-auto">{props.children}</div>
    </section>
  );
}

export function Badge(props: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  const tone = props.tone ?? 'muted';
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5',
        // Not upper-cased. A badge carries data as often as it carries a label —
        // `25m04s` became `25M04S`, which is a different unit in every other
        // context a reader has ever seen.
        'text-label font-medium tracking-wide',
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
  info: Pause,
  muted: CircleDashed,
};

/**
 * Status as a dot *and* an icon *and* a word (§97).
 *
 * The dot alone is the version that fails: for a colour-blind reader, a
 * greyscale screenshot, or a glance from across the desk, colour carries nothing.
 */
export function StatusDot(props: {
  tone: Tone;
  label: string;
  showLabel?: boolean;
  spin?: boolean;
}): JSX.Element {
  const Icon = TONE_ICON[props.tone];

  return (
    <span className="inline-flex items-center gap-1.5" title={props.label}>
      <span className="relative inline-flex h-4 w-4 items-center justify-center">
        <span className={cx('absolute h-2 w-2 rounded-full', TONE_DOT[props.tone])} aria-hidden />
        <Icon
          className={cx(
            'relative h-3 w-3',
            TONE_TEXT[props.tone],
            props.spin === true && 'animate-spin',
          )}
          aria-hidden
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
        'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        props.size === 'sm' ? 'h-7 px-2 text-label' : 'h-8 px-3 text-body',
        variant === 'primary' && 'bg-primary text-white hover:brightness-110',
        variant === 'surface' &&
          'border border-border bg-surface-2 text-text hover:bg-surface-3',
        variant === 'ghost' && 'text-muted hover:bg-surface-2 hover:text-text',
        props.className,
      )}
    >
      {props.children}
    </button>
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
          className="z-50 max-w-xs rounded-sm border border-border bg-surface-2 px-2 py-1 text-label text-text shadow-lg"
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
      {props.hint === undefined ? null : (
        <p className="text-label text-faint">{props.hint}</p>
      )}
    </div>
  );
}

export function Metric(props: {
  label: string;
  value: ReactNode;
  tone?: Tone;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-label uppercase tracking-wide text-faint">{props.label}</span>
      <span
        className={cx('tabular text-metric font-semibold', TONE_TEXT[props.tone ?? 'muted'], props.tone === undefined && 'text-text')}
      >
        {props.value}
      </span>
    </div>
  );
}

export { TooltipPrimitive };
