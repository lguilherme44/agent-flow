import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Which project the dashboard is looking at.
 *
 * Local state, and one of the few things that legitimately is: the *selection*
 * belongs to this browser tab, while everything about the project belongs to the
 * server. Storing the project's runs or status here instead of in the query
 * cache is the duplication §88 rules out.
 */
interface ProjectSelection {
  readonly projectId: string | undefined;
  select(projectId: string | undefined): void;
}

const Context = createContext<ProjectSelection>({
  projectId: undefined,
  select: () => undefined,
});

export function ProjectProvider(props: { children: ReactNode }): JSX.Element {
  const [projectId, setProjectId] = useState<string | undefined>(undefined);

  const value = useMemo<ProjectSelection>(
    () => ({ projectId, select: setProjectId }),
    [projectId],
  );

  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}

export function useProjectSelection(): ProjectSelection {
  return useContext(Context);
}
