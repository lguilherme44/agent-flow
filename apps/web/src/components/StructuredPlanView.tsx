import { useState, useMemo } from 'react';
import {
  Boxes,
  Check,
  CheckCircle2,
  Code,
  FileCode,
  ListChecks,
} from 'lucide-react';
import { Badge, Button, cx } from './ui';

export interface StructuredTask {
  id: string;
  title: string;
  description: string;
  scope?: string;
  workspace?: string;
  complexity: 'trivial' | 'normal' | 'complex';
  risk: 'low' | 'medium' | 'high';
  dependencies?: string[];
  requirements?: string[];
  files?: { likely?: string[] };
  flags?: {
    databaseChange?: boolean;
    crossModule?: boolean;
    architectureDecision?: boolean;
    externalIntegration?: boolean;
  };
  acceptanceCriteria?: string[];
  validation?: string[];
}

export interface StructuredPlan {
  feature: string;
  tasks: StructuredTask[];
}

export function StructuredPlanView(props: {
  plan?: StructuredPlan | unknown;
  rawContent?: string;
  className?: string;
  defaultRaw?: boolean;
  showToggle?: boolean;
}): JSX.Element {
  const [showRaw, setShowRaw] = useState(props.defaultRaw ?? false);

  const { parsedPlan, rawText } = useMemo(() => {
    let parsed: StructuredPlan | null = null;
    let text = props.rawContent ?? '';

    if (props.plan && typeof props.plan === 'object' && 'tasks' in props.plan) {
      parsed = props.plan as StructuredPlan;
      if (!text) {
        text = JSON.stringify(props.plan, null, 2);
      }
    } else if (props.rawContent) {
      try {
        const json = JSON.parse(props.rawContent);
        if (json && typeof json === 'object' && Array.isArray(json.tasks)) {
          parsed = json as StructuredPlan;
        }
      } catch {
        parsed = null;
      }
    }

    return { parsedPlan: parsed, rawText: text };
  }, [props.plan, props.rawContent]);

  if (!parsedPlan || showRaw) {
    return (
      <div className={cx('flex flex-col gap-3', props.className)}>
        {parsedPlan && props.showToggle !== false ? (
          <div className="flex items-center justify-between border-b border-border pb-2">
            <span className="text-micro font-medium uppercase tracking-caps text-faint">
              Raw Plan JSON
            </span>
            <Button
              size="sm"
              onClick={() => {
                setShowRaw(false);
              }}
              title="Switch to structured human-readable plan"
            >
              <ListChecks className="h-3.5 w-3.5" aria-hidden />
              View structured plan
            </Button>
          </div>
        ) : null}
        <pre className="overflow-x-auto rounded-md border border-border bg-sunken p-3 font-mono text-micro leading-relaxed text-muted">
          {rawText}
        </pre>
      </div>
    );
  }

  const tasks = parsedPlan.tasks ?? [];

  return (
    <div className={cx('flex flex-col gap-4', props.className)}>
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
        <div className="flex flex-col gap-1 min-w-0">
          <h3 className="text-body-lg font-semibold text-text">
            {parsedPlan.feature || 'Plan Overview'}
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-micro text-muted">
            <span className="font-medium text-text">{tasks.length} task{tasks.length === 1 ? '' : 's'}</span>
            <span>•</span>
            <span>Plan DAG &amp; Acceptance Criteria</span>
          </div>
        </div>

        {props.showToggle !== false ? (
          <Button
            size="sm"
            onClick={() => {
              setShowRaw(true);
            }}
            title="Inspect raw JSON format"
          >
            <Code className="h-3.5 w-3.5" aria-hidden />
            View raw JSON
          </Button>
        ) : null}
      </div>

      {/* Task list */}
      <div className="flex flex-col gap-3">
        {tasks.map((task, idx) => {
          const complexityTone =
            task.complexity === 'complex'
              ? 'danger'
              : task.complexity === 'normal'
                ? 'primary'
                : 'muted';
          const riskTone =
            task.risk === 'high'
              ? 'danger'
              : task.risk === 'medium'
                ? 'warning'
                : 'success';

          const deps = task.dependencies ?? [];
          const files = task.files?.likely ?? [];
          const criteria = task.acceptanceCriteria ?? [];
          const validations = task.validation ?? [];
          const requirements = task.requirements ?? [];
          const flags = task.flags ?? {};

          const activeFlags = Object.entries(flags)
            .filter(([, v]) => v === true)
            .map(([k]) => k.replace(/([A-Z])/g, ' $1').toLowerCase());

          return (
            <article
              key={task.id || `task-${idx}`}
              className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface-2 p-3.5 shadow-sm transition-colors"
            >
              {/* Task Header */}
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-label font-bold text-text bg-surface px-2 py-0.5 rounded border border-border">
                    {task.id}
                  </span>
                  <h4 className="text-body-lg font-semibold text-text">
                    {task.title}
                  </h4>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {task.complexity ? (
                    <Badge tone={complexityTone} caps>
                      {task.complexity}
                    </Badge>
                  ) : null}
                  {task.risk ? (
                    <Badge tone={riskTone} caps>
                      risk: {task.risk}
                    </Badge>
                  ) : null}
                  {task.scope ? (
                    <Badge tone="muted">
                      scope: {task.scope}
                    </Badge>
                  ) : null}
                  {task.workspace ? (
                    <Badge tone="muted">
                      ws: {task.workspace}
                    </Badge>
                  ) : null}
                </div>
              </div>

              {/* Task Description */}
              {task.description ? (
                <p className="text-body-lg text-muted whitespace-pre-wrap leading-relaxed">
                  {task.description}
                </p>
              ) : null}

              {/* Likely Files */}
              {files.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <span className="text-micro font-medium uppercase tracking-caps text-faint flex items-center gap-1">
                    <FileCode className="h-3 w-3" aria-hidden />
                    Target Files ({files.length})
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {files.map((file) => (
                      <code
                        key={file}
                        className="rounded bg-surface px-1.5 py-0.5 font-mono text-micro text-text border border-border"
                      >
                        {file}
                      </code>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* Acceptance Criteria */}
              {criteria.length > 0 ? (
                <div className="flex flex-col gap-1 rounded-md bg-surface p-2.5 border border-border/80">
                  <span className="text-micro font-medium uppercase tracking-caps text-faint flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3 text-success" aria-hidden />
                    Acceptance Criteria
                  </span>
                  <ul className="flex flex-col gap-1 pl-1">
                    {criteria.map((item, cIdx) => (
                      <li
                        key={cIdx}
                        className="flex items-start gap-2 text-body-lg text-text"
                      >
                        <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {/* Dependencies & Validation Commands Footer */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-border/60 text-micro">
                <div className="flex items-center gap-1.5 text-muted">
                  <Boxes className="h-3.5 w-3.5 text-faint" aria-hidden />
                  <span className="font-medium text-faint uppercase tracking-caps">Dependencies:</span>
                  {deps.length === 0 ? (
                    <span className="text-muted">None (starts immediately)</span>
                  ) : (
                    <span className="font-mono font-medium text-primary">
                      {deps.join(', ')}
                    </span>
                  )}
                </div>

                {validations.length > 0 ? (
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-faint uppercase tracking-caps">Validation:</span>
                    <div className="flex gap-1">
                      {validations.map((v) => (
                        <Badge key={v} tone="info">
                          {v}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}

                {requirements.length > 0 ? (
                  <div className="flex items-center gap-1.5 text-faint">
                    <span>Reqs:</span>
                    <span className="font-mono text-text">{requirements.join(', ')}</span>
                  </div>
                ) : null}

                {activeFlags.length > 0 ? (
                  <div className="flex items-center gap-1">
                    {activeFlags.map((flag) => (
                      <span
                        key={flag}
                        className="rounded bg-surface px-1.5 py-0.5 text-micro text-warning border border-warning/30"
                      >
                        {flag}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
