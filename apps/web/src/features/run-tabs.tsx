import type { JSX, ReactNode } from 'react';
import { cx } from '../components/ui';
import { SURFACE_LABEL, type RunSurface } from '../lib/run-surface';

/**
 * The tab strip, and nothing else.
 *
 * **The URL contract lives in `lib/run-surface.ts`, which has no JSX in it.** That split
 * is what lets the node acceptance suite import and *call* `surfaceFromParams` rather than
 * grep `RunDetailPage.tsx` for a regular expression — which is what `M8-ACC-19` did, and
 * why its own comment could claim `?task=` round-tripped while nothing checked it.
 */
export {
  availableSurfaces,
  defaultSurface,
  isTaskSurface,
  paramsForSurface,
  surfaceFromParams,
  RUN_SURFACES,
  type RunSurface,
} from '../lib/run-surface';

/**
 * The tab strip.
 *
 * Underline, not pills. Seven pills is seven bordered rectangles competing with each
 * other and with everything below them; an underline marks one and leaves the rest as
 * text, which is what §5 means by few competing accents.
 *
 * A real `tablist`, so the arrow keys work and a screen reader is told how many there
 * are and which is current. `aria-current` as well as `aria-selected`, because these
 * tabs are also addresses.
 */
export function RunTabs(props: {
  surfaces: readonly RunSurface[];
  active: RunSurface;
  onSelect: (surface: RunSurface) => void;
  /** Rendered at the right end of the strip: filters, view actions. */
  children?: ReactNode;
}): JSX.Element {
  const move = (delta: number): void => {
    const index = props.surfaces.indexOf(props.active);
    if (index === -1) return;
    const next = props.surfaces[(index + delta + props.surfaces.length) % props.surfaces.length];
    if (next !== undefined) props.onSelect(next);
  };

  return (
    /*
     * **Two rows below the drawer boundary, and the reason is a photograph.** At 390 the
     * strip was one row: seven tabs, a search box and five status chips in a 390px line
     * with `justify-end`. The chips wrapped into a vertical column pinned to the right
     * edge and were sliced by it — `All`, `Ru`, `Wa`, `Co`, `Fai` — while the search box
     * collapsed to a circle. The page-overflow check read zero the whole time, because
     * the damage was inside a flex child rather than past the document edge: a filter you
     * cannot read the name of is a filter nobody uses, and no number said so.
     */
    <div className="flex shrink-0 gap-3 border-b border-border px-page max-lg:flex-col max-lg:gap-y-1.5 max-lg:py-1.5 lg:items-center">
      <div
        role="tablist"
        aria-label="Run surfaces"
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto"
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            move(1);
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            move(-1);
          }
        }}
      >
        {props.surfaces.map((surface) => {
          const active = surface === props.active;

          return (
            <button
              key={surface}
              type="button"
              role="tab"
              aria-selected={active}
              aria-current={active ? 'page' : undefined}
              tabIndex={active ? 0 : -1}
              onClick={() => {
                props.onSelect(surface);
              }}
              className={cx(
                'relative shrink-0 whitespace-nowrap px-2.5 py-2 text-body-lg transition-colors',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
                active ? 'font-medium text-text' : 'text-muted hover:text-text',
              )}
            >
              {SURFACE_LABEL[surface]}
              {active ? (
                // Inside the button and flush with the strip's own hairline, so the
                // marker sits *on* the border rather than a pixel above it — a rule
                // that misses by one reads as a rendering fault.
                <span
                  className="absolute inset-x-1.5 -bottom-px h-0.5 rounded-full bg-primary-bright"
                  aria-hidden
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {props.children === undefined ? null : (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 lg:justify-end max-lg:pb-1">
          {props.children}
        </div>
      )}
    </div>
  );
}
