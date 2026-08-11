import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ProjectProvider, useProjectSelection } from './project-context';

/**
 * UI-29 — which project the dashboard is looking at.
 *
 * The selection lives in the URL, so a reload, a bookmark and a link all mean the
 * same thing once a workspace holds more than one project. It is still local UI
 * state in §88's sense: the id came from the server's registry, and the browser
 * never learns or sends a path.
 */

function Probe(): JSX.Element {
  const { projectId, select } = useProjectSelection();
  const location = useLocation();

  return (
    <div>
      <span data-testid="selected">{projectId ?? 'none'}</span>
      <span data-testid="where">{`${location.pathname}${location.search}`}</span>
      <button
        type="button"
        onClick={() => {
          select('beta');
        }}
      >
        pick beta
      </button>
      <button
        type="button"
        onClick={() => {
          select(undefined);
        }}
      >
        clear
      </button>
    </div>
  );
}

function at(entry: string): void {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <ProjectProvider>
        <Routes>
          <Route path="/dashboard" element={<Probe />} />
          <Route path="/projects" element={<Probe />} />
          <Route path="/runs/:runId" element={<Probe />} />
        </Routes>
      </ProjectProvider>
    </MemoryRouter>,
  );
}

describe('the project selection', () => {
  it('is whatever the URL says, including nothing', () => {
    at('/dashboard?project=alpha');
    expect(screen.getByTestId('selected')).toHaveTextContent('alpha');
  });

  it('is the whole workspace when the URL names no project', () => {
    at('/dashboard');
    expect(screen.getByTestId('selected')).toHaveTextContent('none');
  });

  it('writes the choice into the URL', async () => {
    at('/projects');

    await userEvent.click(screen.getByRole('button', { name: 'pick beta' }));

    expect(screen.getByTestId('where')).toHaveTextContent('/projects?project=beta');
    expect(screen.getByTestId('selected')).toHaveTextContent('beta');
  });

  it('leaves the run behind when the project changes', async () => {
    // A run id belongs to one project, and two repositories in a workspace will
    // both have an AF-2026-001. Carrying the run across a switch asks the new
    // project for another project's run — a 404 that reads as a broken dashboard
    // rather than as the wrong question.
    at('/runs/AF-2026-001?project=alpha');

    await userEvent.click(screen.getByRole('button', { name: 'pick beta' }));

    expect(screen.getByTestId('where')).toHaveTextContent('/dashboard?project=beta');
  });

  it('stays where it is when the route does not belong to a run', async () => {
    at('/projects?project=alpha');

    await userEvent.click(screen.getByRole('button', { name: 'clear' }));

    expect(screen.getByTestId('where')).toHaveTextContent('/projects');
    expect(screen.getByTestId('selected')).toHaveTextContent('none');
  });

  it('keeps whatever else the URL was carrying', async () => {
    // The graph is a view of the run page, and it is in the URL too. Switching
    // project must not silently close it.
    at('/projects?view=dag');

    await userEvent.click(screen.getByRole('button', { name: 'pick beta' }));

    expect(screen.getByTestId('where')).toHaveTextContent('view=dag');
    expect(screen.getByTestId('where')).toHaveTextContent('project=beta');
  });
});
