import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigEditorFieldView } from '@contracts/index.js';
import { FieldControl } from './FieldControl';

const field = (over: Partial<ConfigEditorFieldView> = {}): ConfigEditorFieldView => ({
  path: ['parallelism', 'maxTasks'],
  explicitValue: undefined,
  effectiveValue: undefined,
  editable: true,
  effect: 'next_execution_context',
  valueType: 'string',
  ...over,
});

function control(over: Partial<ConfigEditorFieldView>, props: { raw?: string; inherited?: boolean } = {}) {
  const onChange = vi.fn();
  render(
    <FieldControl
      id="control"
      field={field(over)}
      raw={props.raw ?? ''}
      inherited={props.inherited ?? props.raw === undefined}
      onChange={onChange}
    />,
  );
  return onChange;
}

describe('FieldControl', () => {
  it('renders a boolean as a switch that reflects the inherited value', () => {
    const onChange = control({ valueType: 'boolean', effectiveValue: true }, { inherited: true });
    const control_ = screen.getByRole('switch');
    expect(control_).toBeChecked();
    expect(control_).not.toHaveAttribute('type', 'text');
    fireEvent.click(control_);
    expect(onChange).toHaveBeenCalledWith('false');
  });

  it('renders a closed field as the values it accepts, and offers inheritance as an option', () => {
    const onChange = control(
      { valueType: 'enum', options: ['none', 'github'], explicitValue: 'github' },
      { raw: 'github', inherited: false },
    );
    const select = screen.getByRole('combobox');
    expect([...select.querySelectorAll('option')].map((option) => option.textContent)).toEqual(['inherit', 'none', 'github']);
    expect(select).toHaveValue('github');
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith('', true);
  });

  it('offers the four reasoning levels the server sent, in the schema order', () => {
    control({ valueType: 'reasoning_level', options: ['low', 'medium', 'high', 'very_high'], effectiveValue: 'high' }, { inherited: true });
    expect([...screen.getByRole('combobox').querySelectorAll('option')].map((option) => option.value))
      .toEqual(['', 'low', 'medium', 'high', 'very_high']);
    expect(screen.getByRole('option', { name: 'inherit · high' })).toBeInTheDocument();
  });

  it('renders an integer as a number input carrying the inherited value as its placeholder', () => {
    const onChange = control({ valueType: 'integer', effectiveValue: 2 }, { inherited: true });
    const input = screen.getByRole('spinbutton');
    expect(input).toHaveAttribute('type', 'number');
    expect(input).toHaveAttribute('step', '1');
    expect(input).toHaveAttribute('placeholder', '2');
    fireEvent.change(input, { target: { value: '4' } });
    expect(onChange).toHaveBeenCalledWith('4');
  });

  it('edits a list by item rather than by separator', () => {
    const onChange = control(
      { path: ['ui', 'allowedHosts'], valueType: 'string_list', explicitValue: ['localhost', 'deck.local'] },
      { raw: 'localhost, deck.local', inherited: false },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove localhost from ui.allowedHosts' }));
    expect(onChange).toHaveBeenCalledWith('deck.local');

    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' apex ' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('localhost, deck.local, apex');
  });

  it('shows an inherited list without pretending the items were set here', () => {
    control({ path: ['ui', 'allowedHosts'], valueType: 'string_list', effectiveValue: ['localhost'] }, { inherited: true });
    expect(screen.getByText('localhost')).toBeInTheDocument();
    expect(screen.getByText('localhost').closest('.field-list')).toHaveAttribute('data-inherited', 'true');
  });

  it('refuses every edit a global-only field cannot take', () => {
    control({ valueType: 'boolean', editable: false, effectiveValue: false }, { inherited: true });
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('falls back to text for an open string field', () => {
    const onChange = control({ path: ['runners', 'claude', 'command'], valueType: 'string', effectiveValue: 'claude' }, { inherited: true });
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveAttribute('placeholder', 'claude');
    fireEvent.change(input, { target: { value: '/opt/claude' } });
    expect(onChange).toHaveBeenCalledWith('/opt/claude');
  });
});
