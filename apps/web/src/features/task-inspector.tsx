import { useState } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { TaskDetailView } from '@contracts/index.js';
import { Badge, Empty, StatusDot, cx } from '../components/ui';
import { formatDuration, formatTime } from '../lib/format';
import { taskLabel, taskTone } from '../lib/status';

/**
 * Task Inspector (§73–§77).
 *
 * Four tabs, and the Context tab is the one with a rule attached: it shows the
 * task's own metadata — requirements, dependencies, acceptance criteria, which
 * runner at what effort — and never anything that could carry a secret. There is
 * no environment here, no auth state, no command line.
 */
export function TaskInspector(props: { task: TaskDetailView | undefined }): JSX.Element {
  const [tab, setTab] = useState('logs');

  if (props.task === undefined) {
    return (
      <div className="flex h-full flex-col rounded-lg border border-border bg-surface">
        <Empty title="Select a task" hint="Its logs, files, tests and context appear here." />
      </div>
    );
  }

  const task = props.task;

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-border bg-surface">
      <header className="shrink-0 border-b border-border p-3">
        <div className="flex items-center gap-2">
          <span className="tabular text-body font-medium text-muted">{task.id}</span>
          <StatusDot
            tone={taskTone(task.state)}
            label={taskLabel(task.state)}
            spin={task.state === 'running'}
          />
        </div>
        <h2 className="mt-1 text-body-lg font-semibold">{task.title}</h2>
        {task.description === '' ? null : (
          <p className="mt-1 line-clamp-3 text-label text-muted">{task.description}</p>
        )}

        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
          <Fact label="Agent" value={task.runner ?? '—'} />
          <Fact label="Model" value={task.model ?? 'not reported'} />
          <Fact label="Effort" value={task.reasoning ?? '—'} />
          <Fact label="Attempts" value={String(task.attempts)} />
          <Fact label="Started" value={formatTime(task.startedAt)} />
          <Fact label="Duration" value={formatDuration(task.durationMs)} />
        </dl>

        {/* Provenance that differs from intent is the part worth seeing. */}
        {task.fallback === undefined ? null : (
          <p className="mt-2 rounded-sm bg-warning-soft px-2 py-1 text-label text-warning">
            Ran on {task.runner} after {task.fallback.from} returned{' '}
            {task.fallback.errorCode}.
          </p>
        )}
        {task.reasoningClamped === true ? (
          <p className="mt-2 rounded-sm bg-warning-soft px-2 py-1 text-label text-warning">
            Ran below the configured effort: {task.runner} does not support it.
          </p>
        ) : null}
        {task.correctiveFor === undefined ? null : (
          <p className="mt-2 rounded-sm bg-primary-soft px-2 py-1 text-label text-text">
            Corrective task, from a {task.correctiveFor.findingType} finding in{' '}
            {task.correctiveFor.stage.replace(/-/g, ' ')}.
          </p>
        )}
      </header>

      <TabsPrimitive.Root
        value={tab}
        onValueChange={setTab}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsPrimitive.List className="flex shrink-0 gap-1 border-b border-border px-2">
          {[
            ['logs', 'Logs'],
            ['files', 'Files'],
            ['tests', 'Tests'],
            ['context', 'Context'],
          ].map(([value, label]) => (
            <TabsPrimitive.Trigger
              key={value}
              value={value as string}
              className={cx(
                'border-b-2 px-2 py-1.5 text-label',
                'data-[state=active]:border-primary data-[state=active]:text-text',
                'border-transparent text-muted hover:text-text',
              )}
            >
              {label}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>

        <TabsPrimitive.Content value="logs" className="min-h-0 flex-1 overflow-auto">
          <LogsTab task={task} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content value="files" className="min-h-0 flex-1 overflow-auto p-3">
          <FilesTab task={task} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content value="tests" className="min-h-0 flex-1 overflow-auto p-3">
          <TestsTab task={task} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content value="context" className="min-h-0 flex-1 overflow-auto p-3">
          <ContextTab task={task} />
        </TabsPrimitive.Content>
      </TabsPrimitive.Root>
    </div>
  );
}

function Fact(props: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-label text-faint">{props.label}</dt>
      <dd className="truncate text-label text-text" title={props.value}>
        {props.value}
      </dd>
    </div>
  );
}

/** Logs Tab (§74). Escape sequences are stripped server-side, on the way out. */
function LogsTab(props: { task: TaskDetailView }): JSX.Element {
  const lines = props.task.log;

  if (lines.length === 0 && props.task.notes.length === 0) {
    return <Empty title="No log for this task yet." />;
  }

  return (
    <pre className="whitespace-pre-wrap break-words p-3 font-mono text-label text-muted">
      {[...lines, ...props.task.notes.map((note) => `note: ${note}`)].join('\n')}
    </pre>
  );
}

/** Files Tab (§75). List only in this milestone; inline diff comes later. */
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
    <div className="flex flex-col gap-1">
      <p className="text-label text-faint">
        {props.task.filesChanged.length} file(s) changed
      </p>
      <ul className="flex flex-col gap-0.5">
        {props.task.filesChanged.map((file) => (
          <li key={file} className="truncate font-mono text-label text-text" title={file}>
            {file}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Tests Tab (§76).
 *
 * Shows the exit code beside the verdict, because they are not the same thing.
 * A test-first task is done correctly when its commands *fail*, and a tab that
 * only rendered "passed / failed" would call the right outcome a problem.
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
      <p className="text-label text-faint">
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
          <span className="text-label text-faint">{formatDuration(command.durationMs)}</span>
          {command.stdout === '' ? null : (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-surface-2 p-2 font-mono text-label text-muted">
              {command.stdout}
            </pre>
          )}
          {command.stderr === '' ? null : (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-danger-soft p-2 font-mono text-label text-danger">
              {command.stderr}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

/** Context Tab (§77). Task metadata only — never a secret, never an environment. */
function ContextTab(props: { task: TaskDetailView }): JSX.Element {
  const { task } = props;

  return (
    <div className="flex flex-col gap-3">
      <Section title="Requirements">
        {task.requirements.length === 0 ? (
          <p className="text-label text-muted">
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
          <p className="text-label text-muted">None.</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {task.dependencies.map((dependency) => (
              <Badge key={dependency}>{dependency}</Badge>
            ))}
          </div>
        )}
      </Section>

      <Section title="Acceptance criteria">
        <ul className="flex list-disc flex-col gap-0.5 pl-4 text-label text-muted">
          {task.acceptanceCriteria.map((criterion) => (
            <li key={criterion}>{criterion}</li>
          ))}
        </ul>
      </Section>

      <Section title="Execution">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
          <Fact label="Runner" value={task.runner ?? '—'} />
          <Fact label="Model" value={task.model ?? 'not reported'} />
          <Fact label="Effort" value={task.reasoning ?? '—'} />
          <Fact label="Risk" value={task.risk} />
        </dl>
      </Section>
    </div>
  );
}

function Section(props: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-label uppercase tracking-wide text-faint">{props.title}</h3>
      {props.children}
    </section>
  );
}
