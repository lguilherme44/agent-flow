import { useState } from 'react';
import type { ConfigEditorFieldView } from '@contracts/index.js';
import { displayValue, listItems } from './crew-config';

/**
 * One configuration value, in the control its type deserves.
 *
 * The server already says what a field is — `valueType`, and for a closed one the
 * `options` it accepts. Rendering all seven types as a text box threw that away and
 * moved every mistake to the round-trip: a boolean was the word `true` typed by hand,
 * an enum was free text, and the diagnostic explaining the typo arrived after a request.
 * This is the only place in the browser that maps a type to a widget.
 *
 * Every control still speaks one language upward — the raw string `parseFieldValue`
 * already reads — so the operation built from a switch is the operation built from a
 * text box, and the parser stayed where it was.
 */
export interface FieldControlProps {
  readonly id: string;
  readonly field: ConfigEditorFieldView;
  /** The pending or explicit value as text; empty when the field inherits. */
  readonly raw: string;
  /** True when neither this source nor a pending edit sets the value. */
  readonly inherited: boolean;
  /**
   * A closed set the screen knows and the schema does not — the runner ids declared in
   * this source, most concretely. Overrides `field.options` when present.
   */
  readonly options?: readonly string[];
  readonly onChange: (raw: string, inherit?: boolean) => void;
}

export function FieldControl(props: FieldControlProps) {
  const { field } = props;
  const options = props.options ?? field.options;
  if (field.valueType === 'boolean') return <BooleanControl {...props} />;
  if (field.valueType === 'string_list') return <ListControl {...props} />;
  if (options !== undefined && options.length > 0) return <ChoiceControl {...props} options={options} />;
  if (field.valueType === 'integer' || field.valueType === 'number') return <NumberControl {...props} />;
  return <TextControl {...props} />;
}

/**
 * A switch, and the inherited value shown as the state it actually is.
 *
 * An unchecked box would be a lie for a field inheriting `true`, so the box reflects the
 * effective value and `data-inherited` says the value is not this source's yet. Touching
 * it writes the value here, which is what a click on an inherited switch means.
 */
function BooleanControl({ id, field, raw, inherited, onChange }: FieldControlProps) {
  const checked = inherited ? field.effectiveValue === true : raw === 'true';
  return (
    <span className="field-bool" data-inherited={inherited}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="field-switch"
        checked={checked}
        disabled={!field.editable}
        onChange={(event) => onChange(String(event.target.checked))}
      />
      <span aria-hidden="true" className="field-bool__word">{checked ? 'true' : 'false'}</span>
    </span>
  );
}

/**
 * A closed field offers exactly what it accepts, plus the one way back to inheritance.
 *
 * A value the list does not contain is carried as its own option rather than dropped.
 * Falling back to the empty option would render a role pointing at a deleted runner as
 * "inherit" — a screen quietly disagreeing with the file it is editing, and the next
 * save would make the screen right.
 */
function ChoiceControl({ id, field, raw, inherited, onChange, options }: FieldControlProps & { options: readonly string[] }) {
  const unknown = !inherited && raw !== '' && !options.includes(raw);
  return (
    <select
      id={id}
      className="input mono"
      data-unknown={unknown}
      value={inherited ? '' : raw}
      disabled={!field.editable}
      onChange={(event) => (event.target.value === '' ? onChange('', true) : onChange(event.target.value))}
    >
      <option value="">{inherited ? `inherit · ${displayValue(field.effectiveValue)}` : 'inherit'}</option>
      {unknown ? <option value={raw}>{raw} — not declared</option> : null}
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  );
}

function NumberControl({ id, field, raw, inherited, onChange }: FieldControlProps) {
  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      step={field.valueType === 'integer' ? 1 : 'any'}
      className="input mono"
      value={raw}
      disabled={!field.editable}
      placeholder={inherited ? displayValue(field.effectiveValue) : undefined}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function TextControl({ id, field, raw, inherited, onChange }: FieldControlProps) {
  return (
    <input
      id={id}
      type="text"
      className="input mono"
      value={raw}
      disabled={!field.editable}
      placeholder={inherited ? displayValue(field.effectiveValue) : undefined}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * A list as its items.
 *
 * The comma-separated string was the storage format leaking into the control: one typo in
 * a separator changed the length of the list and nothing said so. Items are removed by
 * name and added one at a time; the value handed upward is still the joined string the
 * parser reads.
 */
function ListControl({ id, field, raw, inherited, onChange }: FieldControlProps) {
  const [draft, setDraft] = useState('');
  const items = inherited ? listItems(field.effectiveValue) : raw.split(',').map((item) => item.trim()).filter(Boolean);
  const label = field.path.map(String).join('.');
  const commit = (next: readonly string[]): void => onChange(next.join(', '));
  const add = (): void => {
    const value = draft.trim();
    if (value === '' || items.includes(value)) return;
    setDraft('');
    commit([...items, value]);
  };
  return (
    <span className="field-list" data-inherited={inherited}>
      {items.map((item) => (
        <span key={item} className="value-chip">
          <span className="mono">{item}</span>
          <button
            type="button"
            className="value-chip__remove"
            aria-label={`Remove ${item} from ${label}`}
            disabled={!field.editable}
            onClick={() => commit(items.filter((entry) => entry !== item))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        id={id}
        type="text"
        className="field-list__draft mono"
        value={draft}
        disabled={!field.editable}
        placeholder={items.length === 0 ? 'empty' : 'add…'}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={add}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          add();
        }}
      />
    </span>
  );
}
