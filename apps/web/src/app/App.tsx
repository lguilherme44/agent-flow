import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './Shell';
import { ControlPlanePage } from '../pages/ControlPlanePage';
import { DashboardPage } from '../pages/DashboardPage';
import { RunDetailPage } from '../pages/RunDetailPage';
import { RunsPage } from '../pages/RunsPage';
import { ProjectsPage } from '../pages/ProjectsPage';
import { AgentsPage } from '../pages/AgentsPage';
import { PromptsPage } from '../pages/PromptsPage';
import { AnalyticsPage } from '../pages/AnalyticsPage';
import { SettingsPage } from '../pages/SettingsPage';

/**
 * The control plane. Seven destinations, and it writes.
 *
 * What changed with UI-27 is narrower than it looks. Approving a plan, revising it,
 * rejecting it, starting a run and retrying a task are still state transitions the
 * StateStore owns and the CLI performs — this app asks for them through endpoints
 * that call the same use cases, and then re-reads. No mutation here patches a cache
 * or keeps a copy of `RunState`, so nothing on any of these screens can be wrong
 * about what a click did: it either happened on disk or it did not.
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
              {/*
                * The landing page is the control plane, not one run (M8 §13).
                *
                * `/dashboard` still opens the run most likely to want you, and is still
                * right for a single project. It answers "what is happening" for one
                * repository and hides it for the other nine, which is why it is no longer
                * where a person arrives.
                */}
              <Route path="/" element={<ControlPlanePage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/runs" element={<RunsPage />} />
              <Route path="/runs/:runId" element={<RunDetailPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/prompts" element={<PromptsPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </TooltipPrimitive.Provider>
    </QueryClientProvider>
  );
}
