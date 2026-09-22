import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Kanban } from './Kanban';
import { ptBR as t } from '../../lib/i18n';

describe('Kanban', () => {
  const rows = [
    { id: 'TASK-001', title: 'Setup database schema' },
    { id: 'TASK-002', title: 'Implement user login' },
    { id: 'TASK-003', title: 'Build checkout flow' },
    { id: 'TASK-004', title: 'Fix session token expiry' },
    { id: 'TASK-005', title: 'Add telemetry metrics' },
  ];

  const stateOf = (id: string): string | undefined => {
    switch (id) {
      case 'TASK-001':
        return 'completed';
      case 'TASK-002':
        return 'running';
      case 'TASK-003':
        return 'ready';
      case 'TASK-004':
        return 'blocked';
      case 'TASK-005':
      default:
        return 'queued';
    }
  };

  it('renders all 5 columns with proper task counts', () => {
    render(
      <Kanban
        tasks={undefined}
        rows={rows}
        stateOf={stateOf}
        selected={undefined}
        onSelect={vi.fn()}
      />,
    );

    // Columns should be present
    expect(screen.getByText(t.run.kanbanColQueued)).toBeTruthy();
    expect(screen.getByText(t.run.kanbanColReady)).toBeTruthy();
    expect(screen.getByText(t.run.kanbanColRunning)).toBeTruthy();
    expect(screen.getByText(t.run.kanbanColAttention)).toBeTruthy();
    expect(screen.getByText(t.run.kanbanColCompleted)).toBeTruthy();

    // Cards should be rendered in their respective columns
    expect(screen.getByText('TASK-001')).toBeTruthy();
    expect(screen.getByText('Setup database schema')).toBeTruthy();
    expect(screen.getByText('TASK-002')).toBeTruthy();
    expect(screen.getByText('TASK-004')).toBeTruthy();
  });

  it('triggers onSelect when clicking a task card', () => {
    const onSelect = vi.fn();
    render(
      <Kanban
        tasks={undefined}
        rows={rows}
        stateOf={stateOf}
        selected={undefined}
        onSelect={onSelect}
      />,
    );

    const card = screen.getByText('TASK-002').closest('button');
    expect(card).toBeTruthy();
    fireEvent.click(card!);

    expect(onSelect).toHaveBeenCalledWith('TASK-002');
  });

  it('filters task cards by search query', () => {
    render(
      <Kanban
        tasks={undefined}
        rows={rows}
        stateOf={stateOf}
        selected={undefined}
        onSelect={vi.fn()}
      />,
    );

    const filterInput = screen.getByPlaceholderText('Filtrar tarefas por ID ou título...');
    fireEvent.change(filterInput, { target: { value: 'checkout' } });

    expect(screen.getByText('TASK-003')).toBeTruthy();
    expect(screen.queryByText('TASK-001')).toBeNull();
    expect(screen.queryByText('TASK-002')).toBeNull();
  });
});
