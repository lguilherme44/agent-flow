import { useState } from 'react';
import type { ConfigEditorChangeView, ConfigEditorScope, ConfigValidationView } from '@contracts/index.js';
import type { ConfigEditorOperation } from '../../lib/api';
import { cliCommandFor, displayValue, effectSummary, pathLabel } from './crew-config';

/**
 * Saving as one act, with the diff it is about to write.
 *
 * The page used to answer "what did I change?" in two places and neither of them was the
 * file: a list of effective values above, a row of buttons below, and no way to see the
 * edit as the edit. This is one bar — how many changes, when they take effect, what the
 * before and after are, and the `agent-flow config` line that does the same thing.
 *
 * The CLI line is not decoration. The footer promises that every write goes through the
 * use case the CLI calls, and this is where that promise becomes checkable: the command
 * shown is the command that produces this operation, so a person can put it in a script,
 * a commit message or an issue instead of describing which boxes they clicked.
 */
export function ChangeBar({ scope, projectPath, operations, validation, state, activeRunId, onDiscard, onSave }: {
  readonly scope: ConfigEditorScope;
  /** Where `agent-flow config` has to run for the project-scope commands to match. */
  readonly projectPath: string;
  readonly operations: readonly ConfigEditorOperation[];
  readonly validation: ConfigValidationView | undefined;
  readonly state: 'idle' | 'validating' | 'saving' | 'saved' | 'conflict';
  readonly activeRunId: string | null;
  readonly onDiscard: () => void;
  readonly onSave: () => void;
}) {
  const [open, setOpen] = useState(false);
  const changes = validation?.changes ?? [];
  const count = operations.length;
  const status = state === 'validating' ? 'Validating…'
    : state === 'saving' ? 'Saving…'
      : state === 'saved' ? 'Saved.'
        : state === 'conflict' ? 'Conflict.'
          : '';
  return (
    <div className="crew-actions" data-dirty={count > 0}>
      <div className="crew-actions__row">
        <span className="crew-actions__count" aria-live="polite">
          {count === 0 ? status || 'No unsaved changes' : <><b className="mono">{count}</b> unsaved change{count === 1 ? '' : 's'}{status === '' ? '' : ` · ${status}`}</>}
        </span>
        {changes.length === 0
          ? null
          : <span className="tag">takes effect {effectSummary(changes.map(({ effect }) => effect))}</span>}
        <span className="crew-actions__spacer" />
        <button type="button" className="btn btn--ghost btn--sm" disabled={count === 0} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide diff' : 'Show diff'}
        </button>
        <button type="button" className="btn" disabled={count === 0} onClick={onDiscard}>Discard</button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={validation?.valid !== true || state === 'saving' || state === 'validating'}
          onClick={onSave}
        >
          Save configuration
        </button>
      </div>
      {open && count > 0
        ? <div className="crew-diff" aria-live="polite">
          {operations.map((operation) => (
            <ChangeLine key={pathLabel(operation.path)} scope={scope} operation={operation} change={changes.find((entry) => pathLabel(entry.path) === pathLabel(operation.path))} />
          ))}
          {scope === 'project'
            ? <p className="crew-diff__note crew-diff__note--quiet">Project scope is the CLI's working directory, so run these from <code>{projectPath}</code>.</p>
            : null}
          {activeRunId === null
            ? null
            : <p className="crew-diff__note">Run {activeRunId} is in flight and keeps the execution context it started with.</p>}
        </div>
        : null}
    </div>
  );
}

function ChangeLine({ scope, operation, change }: {
  readonly scope: ConfigEditorScope;
  readonly operation: ConfigEditorOperation;
  readonly change: ConfigEditorChangeView | undefined;
}) {
  const label = pathLabel(operation.path);
  const after = operation.kind === 'unset' ? undefined : operation.value;
  return (
    <div className="crew-diff__entry">
      {change === undefined
        ? <div className="crew-diff__same"><code>{label}</code>: {displayValue(after)} — no change to the effective value</div>
        : <>
          <div className="crew-diff__del">- {label}: {displayValue(change.before)}</div>
          <div className="crew-diff__add">+ {label}: {displayValue(change.after)}</div>
        </>}
      <div className="crew-diff__cli">$ {cliCommandFor(scope, operation)}</div>
    </div>
  );
}
