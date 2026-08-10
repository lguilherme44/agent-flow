import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './Shell';
import { RunDetailPage } from '../pages/RunDetailPage';
import { RunsPage } from '../pages/RunsPage';
import { ProjectsPage } from '../pages/ProjectsPage';

/**
 * The dashboard, read-only.
 *
 * No mutation is wired anywhere in this app, and that is a design position
 * rather than an unfinished one: approving a plan, starting a run and retrying a
 * task are state transitions the StateStore owns, and the write API that lets
 * the browser ask for one has not been designed. Until it is, the CLI is the
 * only thing that changes a run — which means nothing on this screen can be
 * wrong about what a click did.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // The stream is what makes things fresh (§89). Refetching on every
        // window focus on top of it is work nobody asked for.
        refetchOnWindowFocus: false,
        staleTime: 5_000,
        retry: 1,
      },
    },
  });
}

export function App(): JSX.Element {
  return (
    <QueryClientProvider client={createQueryClient()}>
      <TooltipPrimitive.Provider>
        <BrowserRouter>
          <Routes>
            <Route element={<Shell />}>
              <Route path="/" element={<Navigate to="/runs" replace />} />
              <Route path="/runs" element={<RunsPage />} />
              <Route path="/runs/:runId" element={<RunDetailPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="*" element={<Navigate to="/runs" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </TooltipPrimitive.Provider>
    </QueryClientProvider>
  );
}
