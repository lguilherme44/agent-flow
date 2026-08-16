import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Breadcrumbs } from './Breadcrumbs';
import { ProjectProvider } from '../app/project-context';
import { I18nProvider } from '../lib/i18n/i18n-context';

function renderWithProviders(initialEntries: string[], selectedTaskId?: string | undefined) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  const breadcrumbsProps = selectedTaskId !== undefined ? { selectedTaskId } : {};

  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <ProjectProvider>
            <Routes>
              <Route path="/runs" element={<Breadcrumbs {...breadcrumbsProps} />} />
              <Route path="/runs/:runId" element={<Breadcrumbs {...breadcrumbsProps} />} />
              <Route path="/projects" element={<Breadcrumbs {...breadcrumbsProps} />} />
              <Route path="/agents" element={<Breadcrumbs {...breadcrumbsProps} />} />
              <Route path="/prompts" element={<Breadcrumbs {...breadcrumbsProps} />} />
              <Route path="/prompts/:prompt" element={<Breadcrumbs {...breadcrumbsProps} />} />
              <Route path="/analytics" element={<Breadcrumbs {...breadcrumbsProps} />} />
              <Route path="/settings" element={<Breadcrumbs {...breadcrumbsProps} />} />
              <Route path="/dashboard" element={<Breadcrumbs {...breadcrumbsProps} />} />
              <Route path="*" element={<Breadcrumbs {...breadcrumbsProps} />} />
            </Routes>
          </ProjectProvider>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Breadcrumbs component', () => {
  it('renders semantic nav with aria-label="Breadcrumb"', () => {
    renderWithProviders(['/analytics']);
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav).toBeInTheDocument();
  });

  it('renders hierarchy for Analytics page', () => {
    renderWithProviders(['/analytics']);
    expect(screen.getByText('workspace')).toBeInTheDocument();
    const current = screen.getByText('Metrics');
    expect(current).toHaveAttribute('aria-current', 'page');
  });

  it('renders hierarchy for Agents & Models page', () => {
    renderWithProviders(['/agents']);
    expect(screen.getByText('workspace')).toBeInTheDocument();
    const current = screen.getByText('Agents & Models');
    expect(current).toHaveAttribute('aria-current', 'page');
  });

  it('renders hierarchy for Projects page', () => {
    renderWithProviders(['/projects']);
    expect(screen.getByText('workspace')).toBeInTheDocument();
    const current = screen.getByText('Projects');
    expect(current).toHaveAttribute('aria-current', 'page');
  });

  it('renders hierarchy for Prompts detail page', () => {
    renderWithProviders(['/prompts/discovery']);
    expect(screen.getByText('workspace')).toBeInTheDocument();
    expect(screen.getByText('Prompts')).toBeInTheDocument();
    const current = screen.getByText('discovery');
    expect(current).toHaveAttribute('aria-current', 'page');
  });

  it('renders hierarchy for Run detail route with clickable ancestor', () => {
    renderWithProviders(['/runs/AF-2026-001']);
    expect(screen.getByText('workspace')).toBeInTheDocument();
    const runCrumb = screen.getByText('AF-2026-001');
    expect(runCrumb).toHaveAttribute('aria-current', 'page');

    // Runs ancestor should be a link
    const runsLink = screen.getByRole('link', { name: 'Runs' });
    expect(runsLink).toBeInTheDocument();
    expect(runsLink).toHaveAttribute('href', '/runs');
  });

  it('renders hierarchy for Run with selected Task', () => {
    renderWithProviders(['/runs/AF-2026-001'], 'TASK-001');
    expect(screen.getByText('workspace')).toBeInTheDocument();
    expect(screen.getByText('Runs')).toBeInTheDocument();
    expect(screen.getByText('AF-2026-001')).toBeInTheDocument();
  });
});
