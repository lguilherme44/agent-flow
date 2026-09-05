import { useEffect, useState } from 'react';

/**
 * Four screens, and every address carries what a reload needs.
 *
 * A run is always addressed with its project — `/p/<project>/runs/<run>` — because run
 * ids restart at 001 per project per year, and a link that named only the run would open
 * a different project's work the day two repositories both hold `AF-2026-001`.
 *
 * The previous dashboard's `/runs/<run>?project=<id>` is still understood, so nothing
 * anybody bookmarked stops working.
 */
export type Route =
  | { readonly name: 'deck' }
  | { readonly name: 'runs'; readonly projectId?: string }
  | { readonly name: 'run'; readonly projectId: string; readonly runId: string; readonly task?: string; readonly at?: string }
  | { readonly name: 'crew'; readonly projectId?: string }
  | { readonly name: 'missing'; readonly path: string };

export function parseRoute(pathname: string, search: string): Route {
  const params = new URLSearchParams(search);
  const project = params.get('project') ?? params.get('projectId') ?? undefined;
  const segments = pathname.split('/').filter((segment) => segment !== '');

  if (segments.length === 0) return { name: 'deck' };

  if (segments[0] === 'runs' && segments.length === 1) {
    return project === undefined ? { name: 'runs' } : { name: 'runs', projectId: project };
  }

  if (segments[0] === 'crew' && segments.length === 1) {
    return project === undefined ? { name: 'crew' } : { name: 'crew', projectId: project };
  }

  const runExtras = (): { task?: string; at?: string } => {
    const task = params.get('task') ?? undefined;
    const at = params.get('at') ?? undefined;
    return { ...(task === undefined ? {} : { task }), ...(at === undefined ? {} : { at }) };
  };

  if (segments[0] === 'p' && segments[2] === 'runs' && segments.length === 4) {
    const projectId = segments[1];
    const runId = segments[3];
    if (projectId !== undefined && runId !== undefined) {
      return { name: 'run', projectId, runId, ...runExtras() };
    }
  }

  // The previous dashboard's spelling.
  if (segments[0] === 'runs' && segments.length === 2 && project !== undefined) {
    const runId = segments[1];
    if (runId !== undefined) return { name: 'run', projectId: project, runId, ...runExtras() };
  }

  return { name: 'missing', path: pathname };
}

export function href(route: Route): string {
  switch (route.name) {
    case 'deck':
      return '/';
    case 'runs':
      return route.projectId === undefined ? '/runs' : `/runs?project=${encodeURIComponent(route.projectId)}`;
    case 'crew':
      return route.projectId === undefined ? '/crew' : `/crew?project=${encodeURIComponent(route.projectId)}`;
    case 'run': {
      const params = new URLSearchParams();
      if (route.task !== undefined) params.set('task', route.task);
      if (route.at !== undefined) params.set('at', route.at);
      const search = params.toString();
      return `/p/${encodeURIComponent(route.projectId)}/runs/${encodeURIComponent(route.runId)}${search === '' ? '' : `?${search}`}`;
    }
    case 'missing':
      return route.path;
  }
}

const listeners = new Set<() => void>();

export function navigate(to: string, options: { readonly replace?: boolean } = {}): void {
  const current = `${window.location.pathname}${window.location.search}`;
  if (to === current) return;
  if (options.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  for (const listener of [...listeners]) listener();
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname, window.location.search));

  useEffect(() => {
    const update = (): void => setRoute(parseRoute(window.location.pathname, window.location.search));
    listeners.add(update);
    window.addEventListener('popstate', update);
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', update);
    };
  }, []);

  return route;
}

/** Intercepts same-origin left clicks so a plain `<a href>` stays a plain link. */
export function onLinkClick(event: React.MouseEvent<HTMLAnchorElement>): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = event.currentTarget;
  if (target.target === '_blank' || target.hasAttribute('download')) return;
  const to = target.getAttribute('href');
  if (to === null || !to.startsWith('/')) return;
  event.preventDefault();
  navigate(to);
}
