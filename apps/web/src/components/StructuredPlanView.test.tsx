import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StructuredPlanView, type StructuredPlan } from './StructuredPlanView';

const SAMPLE_PLAN: StructuredPlan = {
  feature: 'Add dark mode support',
  tasks: [
    {
      id: 'TASK-001',
      title: 'Define theme tokens and CSS variables',
      description: 'Create CSS color variables for dark mode palette.',
      scope: 'src/styles/theme.css',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      files: { likely: ['src/styles/theme.css'] },
      acceptanceCriteria: ['CSS variables defined for background and text', 'High contrast ratios verified'],
      validation: ['lint'],
      flags: { databaseChange: false, crossModule: false },
    },
    {
      id: 'TASK-002',
      title: 'Implement ThemeToggle component',
      description: 'Add toggle button in navigation header.',
      complexity: 'normal',
      risk: 'medium',
      dependencies: ['TASK-001'],
      requirements: ['FR-002'],
      files: { likely: ['src/components/ThemeToggle.tsx'] },
      acceptanceCriteria: ['Toggle button switches theme', 'Theme preference persists in localStorage'],
      validation: ['test'],
      flags: { databaseChange: false, crossModule: true },
    },
  ],
};

describe('StructuredPlanView (MVP2.1 M2.1-B)', () => {
  it('renders structured tasks, acceptance criteria, dependencies, and validation', () => {
    render(<StructuredPlanView plan={SAMPLE_PLAN} />);

    expect(screen.getByText('Add dark mode support')).toBeInTheDocument();
    expect(screen.getByText('2 tasks')).toBeInTheDocument();

    // TASK-001 appears as task ID badge and as dependency of TASK-002
    expect(screen.getAllByText('TASK-001')).toHaveLength(2);
    expect(screen.getByText('Define theme tokens and CSS variables')).toBeInTheDocument();
    expect(screen.getByText('Create CSS color variables for dark mode palette.')).toBeInTheDocument();
    expect(screen.getByText('CSS variables defined for background and text')).toBeInTheDocument();
    expect(screen.getByText('None (starts immediately)')).toBeInTheDocument();
    expect(screen.getByText('src/styles/theme.css')).toBeInTheDocument();

    // TASK-002
    expect(screen.getByText('TASK-002')).toBeInTheDocument();
    expect(screen.getByText('Implement ThemeToggle component')).toBeInTheDocument();
    expect(screen.getByText('cross module')).toBeInTheDocument();
  });

  it('safely handles tasks with missing optional fields', () => {
    const minimalPlan: StructuredPlan = {
      feature: 'Minimal feature',
      tasks: [
        {
          id: 'TASK-100',
          title: 'Minimal task',
          description: 'No extra fields',
          complexity: 'normal',
          risk: 'low',
        },
      ],
    };

    render(<StructuredPlanView plan={minimalPlan} />);
    expect(screen.getByText('TASK-100')).toBeInTheDocument();
    expect(screen.getByText('Minimal task')).toBeInTheDocument();
    expect(screen.getByText('None (starts immediately)')).toBeInTheDocument();
  });

  it('parses raw JSON string and allows toggling to raw JSON', async () => {
    const raw = JSON.stringify(SAMPLE_PLAN, null, 2);
    render(<StructuredPlanView rawContent={raw} />);

    // Starts in structured view
    expect(screen.getByText('Add dark mode support')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View raw JSON' })).toBeInTheDocument();

    // Toggle to raw view
    await userEvent.click(screen.getByRole('button', { name: 'View raw JSON' }));
    expect(screen.getByText('Raw Plan JSON')).toBeInTheDocument();
    expect(screen.getByText(/"feature": "Add dark mode support"/)).toBeInTheDocument();

    // Toggle back to structured
    await userEvent.click(screen.getByRole('button', { name: 'View structured plan' }));
    expect(screen.getByText('Add dark mode support')).toBeInTheDocument();
  });

  it('renders raw JSON directly when string is not a valid plan structure', () => {
    render(<StructuredPlanView rawContent="some random raw text" />);
    expect(screen.getByText('some random raw text')).toBeInTheDocument();
  });
});
