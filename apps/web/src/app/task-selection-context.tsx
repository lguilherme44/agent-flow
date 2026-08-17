import { createContext, useContext, useState, type ReactNode } from 'react';

interface TaskSelectionContextValue {
  readonly selectedTaskId: string | undefined;
  setSelectedTaskId(taskId: string | undefined): void;
}

const TaskSelectionContext = createContext<TaskSelectionContextValue>({
  selectedTaskId: undefined,
  setSelectedTaskId: () => undefined,
});

export function TaskSelectionProvider(props: { children: ReactNode }): JSX.Element {
  const [activeId, setActiveId] = useState<string | undefined>();

  return (
    <TaskSelectionContext.Provider
      value={{ selectedTaskId: activeId, setSelectedTaskId: setActiveId }}
    >
      {props.children}
    </TaskSelectionContext.Provider>
  );
}

export function useGlobalTaskSelection(): TaskSelectionContextValue {
  return useContext(TaskSelectionContext);
}
