import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

/**
 * Which project the dashboard is looking at (§65, UI-29).
 *
 * Local UI state, and one of the few things that legitimately is: the *selection*
 * belongs to this browser tab, while everything about the project belongs to the
 * server. Storing the project's runs or status here instead of in the query cache
 * is the duplication §88 rules out.
 *
 * It lives in the URL rather than in a `useState`, which matters once a workspace
 * holds several projects. A reload, a bookmark and a link all mean the same thing
 * then, and "which project am I looking at" stops being a fact only this tab
 * knows. It is still a *selection* — the id came from the server's registry, and
 * the browser never learns or sends a path.
 *
 * Switching also leaves the run behind. A run id belongs to one project, and
 * carrying `/runs/AF-2026-104` across a switch asks the new project for a run it
 * almost certainly does not have — a 404 that reads as a broken dashboard rather
 * than as the wrong question.
 */
interface ProjectSelection {
  readonly projectId: string | undefined;
  select(projectId: string | undefined): void;
}

const Context = createContext<ProjectSelection>({
  projectId: undefined,
  select: () => undefined,
});

/** The search parameter the selection lives in. */
export const PROJECT_PARAM = 'project';

export function ProjectProvider(props: { children: ReactNode }): JSX.Element {
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const projectId = search.get(PROJECT_PARAM) ?? undefined;

  const select = useCallback(
    (next: string | undefined) => {
      const params = new URLSearchParams(search);
      if (next === undefined) params.delete(PROJECT_PARAM);
      else params.set(PROJECT_PARAM, next);

      // A run belongs to a project. Staying on `/runs/:runId` through a switch
      // would ask the new project for another project's run.
      if (pathname.startsWith('/runs/')) {
        navigate({ pathname: '/dashboard', search: params.toString() });
        return;
      }

      setSearch(params, { replace: true });
    },
    [search, setSearch, navigate, pathname],
  );

  const value = useMemo<ProjectSelection>(() => ({ projectId, select }), [projectId, select]);

  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}

export function useProjectSelection(): ProjectSelection {
  return useContext(Context);
}

/**
 * How a run is addressed: its id, and the project it belongs to.
 *
 * One function because there is one answer, and getting it wrong is invisible
 * until a workspace holds two projects. Run ids restart at 001 per project per
 * year, so two repositories initialised in the same year both hold AF-2026-001 —
 * and a link without the project resolved against the *primary* one, opening a
 * different project's run of the same name under a row that named the other.
 */
export function runHref(runId: string, projectId: string): string {
  return `/runs/${runId}?${new URLSearchParams({ [PROJECT_PARAM]: projectId }).toString()}`;
}
