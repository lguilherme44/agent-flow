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
        /* The layout target of §66. Tailwind's own scale stops at 1280, and
           the two viewports this design is validated at sit either side of
           it. Added under `extend` so the defaults survive: replacing
           `screens` wholesale would silently delete sm/md/lg/xl. */
        wide: '1440px',
      },
      colors: {
        bg: 'var(--af-bg)',
        surface: 'var(--af-surface)',
        'surface-2': 'var(--af-surface-2)',
        'surface-3': 'var(--af-surface-3)',
        /* Below the page. The terminal, and nothing else. */
        sunken: 'var(--af-sunken)',
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
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        /* §67 plus the two the reference needs and the spec omits: an 11px
           micro label for table sub-lines and metadata captions, and a 24px
           run id, which is the largest thing on the screen. */
        micro: ['11px', { lineHeight: '14px' }],
        label: ['12px', { lineHeight: '16px' }],
        body: ['13px', { lineHeight: '18px' }],
        'body-lg': ['14px', { lineHeight: '20px' }],
        section: ['15px', { lineHeight: '22px' }],
        title: ['17px', { lineHeight: '24px' }],
        hero: ['24px', { lineHeight: '30px' }],
        metric: ['18px', { lineHeight: '24px' }],
      },
    },
  },
  plugins: [],
};
