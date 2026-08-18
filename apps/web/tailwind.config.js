/**
 * Tailwind maps onto the design tokens of §67 — it never carries a colour of its
 * own.
 *
 * Every colour below resolves to a CSS variable defined in `tokens.css`. That is
 * the rule the spec states as "não usar cores soltas nos componentes", enforced
 * where it can actually hold: a component writing `bg-surface` cannot pick a
 * shade the token file does not define, and changing the palette is one file.
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      screens: {
        /* The two boundaries §66 draws that Tailwind's own scale does not.
           `pane` is where the inspector stops sitting beside the table and
           becomes a drawer over it; `wide` is the full layout. Added under
           `extend` so the defaults survive — replacing `screens` wholesale
           would silently delete sm/md/lg/xl. */
        pane: '1200px',
        wide: '1440px',
      },
      colors: {
        bg: 'var(--af-bg)',
        surface: 'var(--af-surface)',
        'surface-2': 'var(--af-surface-2)',
        'surface-3': 'var(--af-surface-3)',
        sunken: 'var(--af-sunken)',
        glass: 'var(--af-glass-bg)',
        'glass-border': 'var(--af-glass-border)',
        border: 'var(--af-border)',
        'border-strong': 'var(--af-border-strong)',
        text: 'var(--af-text)',
        muted: 'var(--af-text-muted)',
        faint: 'var(--af-text-faint)',
        primary: 'var(--af-primary)',
        'primary-bright': 'var(--af-primary-bright)',
        'primary-soft': 'var(--af-primary-soft)',
        'primary-border': 'var(--af-primary-border)',
        success: 'var(--af-success)',
        'success-soft': 'var(--af-success-soft)',
        info: 'var(--af-info)',
        'info-soft': 'var(--af-info-soft)',
        warning: 'var(--af-warning)',
        'warning-soft': 'var(--af-warning-soft)',
        danger: 'var(--af-danger)',
        'danger-soft': 'var(--af-danger-soft)',
        'scale-1': 'var(--af-scale-1)',
        'scale-2': 'var(--af-scale-2)',
        'scale-3': 'var(--af-scale-3)',
        'scale-4': 'var(--af-scale-4)',
        'scale-5': 'var(--af-scale-5)',
        'ambient-1': 'var(--af-ambient-1)',
        'ambient-2': 'var(--af-ambient-2)',
      },
      boxShadow: {
        sm: 'var(--af-shadow-sm)',
        md: 'var(--af-shadow-md)',
        lg: 'var(--af-shadow-lg)',
        glow: 'var(--af-shadow-glow)',
        'glow-primary': 'var(--af-glow-primary)',
        'glow-success': 'var(--af-glow-success)',
        'glow-info': 'var(--af-glow-info)',
        'glow-danger': 'var(--af-glow-danger)',
        'glow-warning': 'var(--af-glow-warning)',
      },
      backdropBlur: {
        glass: 'var(--af-glass-blur)',
      },
      borderRadius: {
        sm: 'var(--af-radius-sm)',
        md: 'var(--af-radius-md)',
        lg: 'var(--af-radius-lg)',
      },
      spacing: {
        sidebar: 'var(--af-sidebar-width)',
        topbar: 'var(--af-topbar-height)',
        inspector: 'var(--af-inspector-width)',
        page: 'var(--af-page-padding)',
        bottom: 'var(--af-bottom-height)',
      },
      fontFamily: {
        /* No `Inter`, and its absence is the honest state rather than a regression.
           It headed this stack and never once rendered: nothing loads it — no
           `@font-face`, no stylesheet link, no font package — so every browser fell
           through to `system-ui`. Both committed baseline sets are pictures of that
           fallback, and so are the measured values in `tokens.css`: 132px is what
           "Implementation" needs in the system face, not in Inter. Naming a font the
           layout was never calibrated against is a claim this file cannot keep, and
           adding it now would re-open every one of those measurements. */
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        /* §67 plus the two the reference needs and the spec omits: an 11px
           micro label for table sub-lines and metadata captions, and a large
           run id, which is the largest thing on the screen.

           **The scale has eight steps; it used to render as two.** Measured
           across the `.tsx` files under `src`, tests excluded: 109 uses of
           `text-micro` and 85 of `text-label` — 194 of 209 size applications,
           93% of the
           interface, in two steps one pixel apart. The other six shared 15
           uses, and `title`, `metric` and `hero` appeared once each in the
           whole app. A hero at 24px over a floor at 11–12px with nothing
           between them gives the eye one landing point per screen and then a
           uniform grey field.

           This file is half the fix. `body-lg` was always here at 14px and was
           used three times; it is now the working size of the interface — table
           primary values, nav items, metadata values, button text — and the
           four steps above it moved up so the gaps stay legible. `micro` is
           back to being micro: badges, column headers, unit suffixes.
           Promoting the call sites is the other half. */
        micro: ['11px', { lineHeight: '14px', letterSpacing: '0.02em' }],
        label: ['12px', { lineHeight: '16px', letterSpacing: '0.01em' }],
        body: ['13px', { lineHeight: '18px' }],
        /* The working size. Everything a person reads a value from. */
        'body-lg': ['14px', { lineHeight: '20px' }],
        section: ['16px', { lineHeight: '22px', letterSpacing: '-0.005em' }],
        title: ['18px', { lineHeight: '24px', letterSpacing: '-0.01em' }],
        hero: ['26px', { lineHeight: '32px', letterSpacing: '-0.025em' }],
        metric: ['22px', { lineHeight: '28px', letterSpacing: '-0.015em' }],
      },
      letterSpacing: {
        /* The floor for upper-case, and it is not a preference: below 0.06em the
           counters collide on screen and the word reads as cramped. Every
           upper-case string in the app used `tracking-wide` (0.025em) or
           `tracking-wider` (0.05em) — column headers, the wordmark, status
           badges, the Projects heading. All of them were under it. */
        caps: '0.08em',
      },
    },
  },
  plugins: [],
};
