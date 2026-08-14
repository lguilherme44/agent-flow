import { useMemo, useState, type ReactNode } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { ArrowDownToLine, Copy, Pause, RotateCcw, X } from 'lucide-react';
import type { TaskDetailView } from '@contracts/index.js';
import {
  ActionRefusal,
  Badge,
  Button,
  Dialog,
  Empty,
  MetaCell,
  Notice,
  Panel,
  cx,
} from '../components/ui';
import { useRetry } from '../lib/mutations';
import { formatDuration, formatTime } from '../lib/format';
import { taskLabel, taskTone, TONE_BG, TONE_TEXT } from '../lib/status';

/**
 * The execution panel (§73–§77).
 *
 * Two things make this read as an operational panel rather than as a detail
 * pane. The metadata is a horizontal row of columns under a hairline instead of
 * a grid of label/value pairs — the same six facts, one third of the height. And
 * the log is a *terminal*: its own surface, darker than the page, monospace,
 * with dim timestamps and its own toolbar.
 *
 * That darkness is the whole trick. Nothing else in the app is below the page
 * ground, so the log reads as a different kind of thing at a glance, without
 * needing a heavier border to say so.
 *
 * The Context tab has a rule attached: task metadata only, never anything that
 * could carry a secret. No environment, no auth state, no command line.
 */
export function TaskInspector(props: {
  task: TaskDetailView | undefined;
  projectId: string | undefined;
  runId: string | undefined;
  onClose?: () => void;
}): JSX.Element {
  const [tab, setTab] = useState('logs');

  if (props.task === undefined) {
    return (
      <Panel className="flex-1">
        <Empty title="Select a task" hint="Its logs, files, tests and context appear here." />
      </Panel>
    );
  }

  const task = props.task;
  const tone = taskTone(task.state);

  return (
    <Panel
      // Stretches to whatever holds it. In the grid the column does that on its
      // own; in the drawer the panel is a flex child and sized to its content,
      // which left the terminal floating above 250px of empty dark.
      className="flex-1"
      header={
        <div className="flex flex-col gap-2 px-3.5 pb-3 pt-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="tabular text-label font-semibold text-text">{task.id}</span>
                <span
                  className={cx(
                    'inline-flex items-center gap-1 rounded-sm px-1.5 py-px text-micro font-medium uppercase tracking-caps',
                    TONE_BG[tone],
                    TONE_TEXT[tone],
                  )}
                >
                  {taskLabel(task.state)}
                </span>
              </div>
              <h2 className="truncate text-section font-semibold" title={task.title}>
                {task.title}
              </h2>
              {task.description === '' ? null : (
                <p className="line-clamp-2 text-body-lg text-muted">{task.description}</p>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {props.runId === undefined ? null : (
                <RetryTask projectId={props.projectId} runId={props.runId} task={task} />
              )}

              {props.onClose === undefined ? null : (
                <button
                  type="button"
                  onClick={props.onClose}
                  className="shrink-0 rounded-sm p-1 text-faint hover:bg-surface-2 hover:text-text"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                  <span className="sr-only">Close inspector</span>
                </button>
              )}
            </div>
          </div>

          <dl className="grid grid-cols-3 gap-x-3 gap-y-2 border-t border-border pt-2.5">
            <MetaCell label="Agent" value={task.runner ?? '—'} />
            <MetaCell label="Model" value={task.model ?? 'not reported'} />
            <MetaCell label="Effort" value={task.reasoning ?? '—'} />
            <MetaCell label="Started" value={formatTime(task.startedAt)} />
            <MetaCell label="Duration" value={formatDuration(task.durationMs)} />
            <MetaCell label="Attempts" value={String(task.attempts)} />
          </dl>

          {/* Provenance that differs from intent is the part worth seeing. */}
          {task.fallback === undefined ? null : (
            <p className="rounded-sm bg-warning-soft px-2 py-1 text-label text-warning">
              Ran on {task.runner} after {task.fallback.from} returned {task.fallback.errorCode}.
            </p>
          )}
          {task.reasoningClamped === true ? (
            <p className="rounded-sm bg-warning-soft px-2 py-1 text-label text-warning">
              Ran below the configured effort: {task.runner} does not support it.
            </p>
          ) : null}
          {task.correctiveFor === undefined ? null : (
            <p className="rounded-sm bg-primary-soft px-2 py-1 text-body-lg text-text">
              Corrective task, from a {task.correctiveFor.findingType} finding in{' '}
              {task.correctiveFor.stage.replace(/-/g, ' ')}.
            </p>
          )}

          <TaskOutcome task={task} onOpenTests={() => { setTab('tests'); }} />
        </div>
      }
    >
      <TabsPrimitive.Root
        value={tab}
        onValueChange={setTab}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsPrimitive.List className="flex shrink-0 gap-3 border-y border-border px-3.5">
          {[
            ['logs', 'Logs'],
            ['files', `Files (${String(task.filesChanged.length)})`],
            ['tests', `Tests (${String(task.commands.length)})`],
            ['context', 'Context'],
          ].map(([value, label]) => (
            <TabsPrimitive.Trigger
              key={value}
              value={value as string}
              className={cx(
                '-mb-px border-b-2 py-2 text-label',
                'data-[state=active]:border-primary-bright data-[state=active]:font-medium data-[state=active]:text-text',
                'border-transparent text-faint hover:text-text',
              )}
            >
              {label}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>

        <TabsPrimitive.Content value="logs" className="flex min-h-0 flex-1 flex-col">
          <LogsTab task={task} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content value="files" className="min-h-0 flex-1 overflow-auto p-3.5">
          <FilesTab task={task} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content value="tests" className="min-h-0 flex-1 overflow-auto p-3.5">
          <TestsTab task={task} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content value="context" className="min-h-0 flex-1 overflow-auto p-3.5">
          <ContextTab task={task} />
        </TabsPrimitive.Content>
      </TabsPrimitive.Root>
    </Panel>
  );
}

/** `[19:56:42] Reading recurrence entity...` split so the clock can be dimmed. */
const TIMESTAMPED = /^(\[\d{2}:\d{2}:\d{2}\])\s?(.*)$/;

/**
 * Logs (§74) — the dominant element in the inspector.
 *
 * Terminal surface, monospace, dim timestamps, and a toolbar whose controls are
 * real local UI behaviour rather than promises: auto-scroll and pause are things
 * this component genuinely owns, and copy is one clipboard call. Nothing here
 * pretends to stream — the log arrives with the task, and the SSE bridge
 * refreshes it.
 *
 * Escape sequences are stripped server-side, on the way out. The file on disk
 * stays exactly what the process produced.
 */
function LogsTab(props: { task: TaskDetailView }): JSX.Element {
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);

  const lines = useMemo(
    () => [...props.task.log, ...props.task.notes.map((note) => `note: ${note}`)],
    [props.task.log, props.task.notes],
  );

  const copy = (): void => {
    void navigator.clipboard?.writeText(lines.join('\n')).then(
      () => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 1_500);
      },
      () => undefined,
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3.5">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <span className="text-micro uppercase tracking-caps text-faint">Output</span>
        <div className="flex items-center gap-1">
          <ToolbarButton
            active={autoScroll}
            onClick={() => {
              setAutoScroll(true);
            }}
            title="Follow the end of the log"
          >
            <ArrowDownToLine className="h-3 w-3" aria-hidden />
            Auto scroll
          </ToolbarButton>
          <ToolbarButton
            active={!autoScroll}
            onClick={() => {
              setAutoScroll(false);
            }}
            title="Stop following"
          >
            <Pause className="h-3 w-3" aria-hidden />
            Pause
          </ToolbarButton>
          <ToolbarButton onClick={copy} title="Copy the log to the clipboard">
            <Copy className="h-3 w-3" aria-hidden />
            {copied ? 'Copied' : 'Copy'}
          </ToolbarButton>
        </div>
      </div>

      <div
        ref={(node) => {
          if (node !== null && autoScroll) node.scrollTop = node.scrollHeight;
        }}
        className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-sunken p-2.5 font-mono text-label leading-[1.6]"
      >
        {lines.length === 0 ? (
          <p className="text-faint">No log for this task yet.</p>
        ) : (
          lines.map((line, index) => {
            const match = TIMESTAMPED.exec(line);
            return (
              <div key={`${String(index)}:${line}`} className="whitespace-pre-wrap break-words">
                {match === null ? (
                  <span className={toneOfLine(line)}>{line}</span>
                ) : (
                  <>
                    <span className="text-faint">{match[1]} </span>
                    <span className={toneOfLine(line)}>{match[2]}</span>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * How a task ended, when how it ended is worth stating (§95).
 *
 * Four things: what happened, where, whether the workflow stopped, and what to do
 * about it. The status chip above says `FAILED`; it does not say that the run
 * halted, which command exited non-zero, or that Retry is the next move — and
 * those are the three a person actually needs.
 *
 * Nothing here decides anything. The state, the error code and the commands all
 * come from the run's own record; a component that inferred "the workflow
 * stopped" from a red chip would be guessing at the scheduler's policy.
 */
function TaskOutcome(props: { task: TaskDetailView; onOpenTests: () => void }): JSX.Element | null {
  const { task } = props;

  const failedCommand = task.commands.find((command) => command.exitCode !== 0);
  const evidence =
    failedCommand === undefined ? undefined : (
      <span>
        {failedCommand.command}
        <span className="text-danger"> · exit {failedCommand.exitCode}</span>
      </span>
    );

  if (task.state === 'failed') {
    return (
      <Notice
        tone="danger"
        title={
          failedCommand === undefined
            ? `${task.id} failed${task.errorCode === undefined ? '' : `: ${task.errorCode}`}.`
            : `${task.id} failed validation.`
        }
        detail={evidence}
        // The scheduler stops on the first task that fails rather than pressing
        // on with independent branches (§22), so this is a fact about the run and
        // not a guess about it.
        //
        // Terse on purpose: this sits above the log, and every line it takes is a
        // line of the log that a person now has to scroll for.
        consequence="The run stopped here — nothing downstream of it will start."
        action={
          failedCommand === undefined ? (
            'Read the log, then retry above.'
          ) : (
            <>
              <Button size="sm" onClick={props.onOpenTests}>
                Command output
              </Button>
              <span>then retry above.</span>
            </>
          )
        }
      />
    );
  }

  if (task.state === 'blocked') {
    return (
      <Notice
        tone="warning"
        title={`${task.id} is blocked.`}
        consequence="Either something it depends on failed, or the SDD did not answer a question this task needs answered. It will not be retried on its own (§23)."
        action="Resolve the cause, then retry deliberately — the button above forces it."
      />
    );
  }

  if (task.state === 'review_required') {
    return (
      <Notice
        tone="warning"
        title={`${task.id} finished, and its validation did not settle the question.`}
        detail={evidence}
        consequence="The run is waiting on a person rather than on a runner."
        action="Read the output, then retry or accept it."
      />
    );
  }

  if (task.state === 'interrupted') {
    return (
      <Notice
        tone="warning"
        title={`${task.id} was interrupted.`}
        consequence="The process running it stopped before it reported anything, so what it did — if anything — was not recorded."
        action="Running the workflow again queues it afresh; the attempt already counted."
      />
    );
  }

  // A completed task whose validation was expected to fail is not a problem, and
  // saying nothing about it is the right amount to say.
  return null;
}

/**
 * stdout and stderr are the same stream on disk, so this reads the line.
 *
 * Deliberately conservative: a line has to look like a failure or a completion
 * to be coloured at all. Guessing wrongly on ordinary output would make the
 * terminal a christmas tree, which is worse than one uniform colour.
 */
function toneOfLine(line: string): string {
  if (/\b(error|failed|failure|exception|traceback)\b/i.test(line)) return 'text-danger';
  if (/\b(passed|completed|success|ok|done)\b/i.test(line)) return 'text-success';
  if (line.startsWith('note:')) return 'text-warning';
  return 'text-muted';
}

function ToolbarButton(props: {
  children: ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.title}
      aria-pressed={props.active}
      className={cx(
        'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-micro',
        props.active === true
          ? 'bg-surface-3 text-text'
          : 'text-faint hover:bg-surface-2 hover:text-text',
      )}
    >
      {props.children}
    </button>
  );
}

/** Files (§75). List only in this milestone; inline diff comes later. */
function FilesTab(props: { task: TaskDetailView }): JSX.Element {
  if (props.task.filesChanged.length === 0) {
    return (
      <Empty
        title="No files recorded."
        hint={
          props.task.files.length === 0
            ? undefined
            : `The plan expected: ${props.task.files.join(', ')}`
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-micro text-faint">
        {props.task.filesChanged.length} file(s) changed
      </p>
      <ul className="flex flex-col divide-y divide-border">
        {props.task.filesChanged.map((file) => (
          <li
            key={file}
            className="truncate py-1.5 font-mono text-label text-text"
            title={file}
          >
            {file}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Tests (§76).
 *
 * Shows the exit code beside the verdict, because they are not the same thing.
 * A test-first task is done correctly when its commands *fail*, and a tab that
 * rendered only "passed / failed" would call the right outcome a problem.
 */
function TestsTab(props: { task: TaskDetailView }): JSX.Element {
  if (props.task.commands.length === 0) {
    return (
      <Empty
        title="No validation ran."
        hint={
          props.task.validation.length === 0
            ? 'This task declares no validation.'
            : `Declared: ${props.task.validation.join(', ')}`
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-micro text-faint">
        Expectation: {props.task.validationExpectation}
        {props.task.validationExpectation === 'fail'
          ? ' — these commands are supposed to fail at this point'
          : ''}
      </p>

      {props.task.commands.map((command, index) => (
        <div key={`${command.command}:${String(index)}`} className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <code className="truncate font-mono text-label text-text" title={command.command}>
              {command.command}
            </code>
            <Badge tone={command.exitCode === 0 ? 'success' : 'danger'}>
              exit {command.exitCode}
            </Badge>
          </div>
          <span className="text-micro text-faint">{formatDuration(command.durationMs)}</span>
          {/* `text-label`, which is what stderr below already takes and what the
              log console in `LogsTab` takes. Two `pre` blocks in one block of
              output, at two sizes, made stdout look like the louder of the two
              when stderr is the one that matters. 14px mono in a 160px box also
              shows seven lines where 12px shows eleven, and command output is
              the one surface where the line you need is rarely the first. */}
          {command.stdout === '' ? null : (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-sm border border-border bg-sunken p-2 font-mono text-label text-muted">
              {command.stdout}
            </pre>
          )}
          {command.stderr === '' ? null : (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-sm border border-danger/25 bg-danger-soft p-2 font-mono text-label text-danger">
              {command.stderr}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

/** Context (§77). Task metadata only — never a secret, never an environment. */
function ContextTab(props: { task: TaskDetailView }): JSX.Element {
  const { task } = props;

  return (
    <div className="flex flex-col gap-3.5">
      <Section title="Requirements">
        {task.requirements.length === 0 ? (
          <p className="text-body-lg text-muted">
            {task.correctiveFor === undefined
              ? 'None recorded.'
              : 'None — this task answers a finding, not a requirement.'}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {task.requirements.map((requirement) => (
              <Badge key={requirement} tone="info">
                {requirement}
              </Badge>
            ))}
          </div>
        )}
      </Section>

      <Section title="Dependencies">
        {task.dependencies.length === 0 ? (
          <p className="text-body-lg text-muted">None.</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {task.dependencies.map((dependency) => (
              <Badge key={dependency}>{dependency}</Badge>
            ))}
          </div>
        )}
      </Section>

      <Section title="Acceptance criteria">
        <ul className="flex list-disc flex-col gap-0.5 pl-4 text-body-lg text-muted">
          {task.acceptanceCriteria.map((criterion) => (
            <li key={criterion}>{criterion}</li>
          ))}
        </ul>
      </Section>

      <Section title="Execution">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          <MetaCell label="Runner" value={task.runner ?? '—'} />
          <MetaCell label="Model" value={task.model ?? 'not reported'} />
          <MetaCell label="Effort" value={task.reasoning ?? '—'} />
          <MetaCell label="Risk" value={task.risk} />
        </dl>
      </Section>
    </div>
  );
}

function Section(props: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-micro uppercase tracking-caps text-faint">{props.title}</h3>
      {props.children}
    </section>
  );
}

/**
 * Retrying one task (§23, UI-27).
 *
 * Confirmed, always, because all three of its consequences are irreversible: the
 * previous result is overwritten, the attempt counter moves, and the task re-enters
 * the queue for the scheduler to pick up. None of those is visible from a button
 * label, so the dialog states them.
 *
 * Only offered for a task that has finished badly, or finished at all. A queued task
 * has nothing to retry, and a running one would be a race — the refusal for both
 * would be correct and the button would be teaching people to ignore it.
 */
const RETRYABLE: readonly TaskDetailView['state'][] = [
  'failed',
  'blocked',
  'interrupted',
  'review_required',
  'completed',
];

function RetryTask(props: {
  projectId: string | undefined;
  runId: string;
  task: TaskDetailView;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [force, setForce] = useState(false);
  const retry = useRetry(props.projectId, props.runId);

  if (!RETRYABLE.includes(props.task.state)) return null;

  const close = (): void => {
    setForce(false);
    retry.reset();
    setOpen(false);
  };

  // A refusal the use case says is forcible, or a task that is BLOCKED — which is
  // the same rule the use case applies, read from its answer rather than kept as a
  // second copy here.
  const refusal = retry.error as { forcible?: boolean } | null;
  const canForce = props.task.state === 'blocked' || refusal?.forcible === true;

  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          setOpen(true);
        }}
        title={`Retry ${props.task.id}`}
      >
        <RotateCcw className="h-3 w-3" aria-hidden />
        Retry
      </Button>

      <Dialog
        open={open}
        onClose={close}
        title={`Retry ${props.task.id}?`}
        description="The task goes back in the queue. Run the plan again to execute it."
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              disabled={retry.isPending}
              onClick={() => {
                retry.mutate({ taskId: props.task.id, force }, { onSuccess: close });
              }}
            >
              Retry task
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {/* The three consequences, because none of them is visible from a button
              label and all three are irreversible. */}
          <ul className="flex list-disc flex-col gap-1 pl-4 text-body-lg text-muted">
            <li>
              {props.task.finishedAt === undefined
                ? 'Whatever this task produced is replaced when it runs again.'
                : 'The result on file, including its validation output, is replaced.'}
            </li>
            <li>
              Attempt {props.task.attempts} becomes attempt {props.task.attempts + 1}.
            </li>
            <li>Anything that depends on it stays where it is until this completes.</li>
          </ul>

          {canForce ? (
            <label className="flex items-start gap-2 rounded-md border border-warning/25 bg-warning-soft px-3 py-2 text-body-lg text-text">
              <input
                type="checkbox"
                checked={force}
                onChange={(changed) => {
                  setForce(changed.target.checked);
                }}
                className="mt-0.5"
              />
              <span>
                {props.task.state === 'blocked'
                  ? 'This task is BLOCKED: it stopped because of something the SDD does not answer. Retrying will not supply that answer, or it will produce a guess. Retry anyway.'
                  : 'Retry past the refusal above.'}
              </span>
            </label>
          ) : null}

          <ActionRefusal error={retry.error} title="Retry refused:" />
        </div>
      </Dialog>
    </>
  );
}
