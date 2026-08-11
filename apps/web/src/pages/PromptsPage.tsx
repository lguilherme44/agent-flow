import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Copy, FileText } from 'lucide-react';
import type { PromptContentView, PromptView } from '@contracts/index.js';
import { usePrompt, usePrompts } from '../lib/queries';
import {
  Badge,
  Empty,
  MetaCell,
  Notice,
  Panel,
  SearchInput,
  SectionHeader,
  cx,
} from '../components/ui';
import { ApiError } from '../lib/api';
import { formatWhenCompact, humanise } from '../lib/format';

/**
 * Prompts (UI-24, §83) — a read-only viewer, and only that.
 *
 * No editor, no history, no evaluations. Those are named as future work and they
 * are genuinely a different feature: editing a prompt means writing into the
 * installed package, which is shared by every project on the machine, and the
 * consequences of getting that wrong are not confined to one run.
 *
 * Two things this page says that the spec asks for and the data does not have:
 *
 * §83 asks for a version. Prompts declare none, and adding a `version:` field
 * nothing enforces and nothing consults is precisely what `PromptMetaSchema`
 * already argues is worse than absent. The digest of the file is shown instead,
 * labelled as what it is — it changes when the prompt changes, which is the
 * property a version number is wanted for, and it cannot be forgotten on the way
 * past.
 *
 * The role and stage a prompt serves are not in its front matter either — that
 * field was removed on purpose, because the implementation prompt serves three
 * executor roles and any single value it declared was a lie about two of them.
 * The server derives them from the stage definitions instead, which is the one
 * place that mapping actually lives.
 */
export function PromptsPage(): JSX.Element {
  const prompts = usePrompts();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');

  const all = prompts.data ?? [];
  const visible = useMemo(() => filterPrompts(all, query), [all, query]);

  // The first prompt, once there is one. A viewer that opens empty makes the
  // reader do a click whose only possible outcome is the one they wanted.
  useEffect(() => {
    if (selected === undefined && visible.length > 0) setSelected(visible[0]?.name);
  }, [selected, visible]);

  const detail = usePrompt(selected);

  if (prompts.isError) {
    return (
      <Empty
        title="The prompts could not be listed."
        hint={prompts.error instanceof Error ? prompts.error.message : undefined}
      />
    );
  }

  if (prompts.data === undefined) {
    return <Empty title={prompts.isLoading ? 'Reading prompts…' : 'Nothing to show.'} />;
  }

  if (all.length === 0) {
    return (
      <Empty
        title="No prompts found."
        hint="This installation shipped without a prompts directory, which the planning pipeline needs. Reinstall agent-flow."
      />
    );
  }

  return (
    // Master and detail, sized like the run detail's table and inspector: the list
    // is a fixed column and the content takes the rest, because the content is
    // what somebody came to read.
    <div className="grid h-full min-h-0 grid-cols-[248px_minmax(0,1fr)] gap-3">
      <Panel
        divided
        header={
          <div className="flex flex-col gap-2 px-3 pb-3 pt-3">
            <h2 className="text-section font-semibold text-text">Prompts</h2>
            <SearchInput
              label="Search prompts"
              value={query}
              placeholder="name, role or stage"
              onChange={setQuery}
            />
          </div>
        }
      >
        {visible.length === 0 ? (
          <Empty title="Nothing matches." />
        ) : (
          <ul className="min-h-0 flex-1 overflow-auto">
            {visible.map((prompt) => (
              <li key={prompt.name}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(prompt.name);
                  }}
                  aria-current={prompt.name === selected ? 'true' : undefined}
                  className={cx(
                    'relative flex w-full flex-col gap-0.5 border-b border-border/70 px-3 py-2 text-left',
                    prompt.name === selected ? 'bg-primary-soft' : 'hover:bg-surface-2',
                  )}
                >
                  {prompt.name === selected ? (
                    <span
                      className="absolute inset-y-2 left-0 w-0.5 rounded-r bg-primary-bright"
                      aria-hidden
                    />
                  ) : null}
                  <span className="flex items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
                    <span className="truncate text-label font-medium text-text">
                      {prompt.name}
                    </span>
                    {prompt.error === undefined ? null : (
                      <AlertTriangle
                        className="h-3 w-3 shrink-0 text-danger"
                        aria-label="unreadable front matter"
                      />
                    )}
                  </span>
                  <span
                    className="truncate text-micro text-faint"
                    // Three executor roles do not fit a 248px list, and they are
                    // the honest answer for this prompt — so the line abbreviates
                    // with the full list behind it.
                    title={prompt.roles.join(', ')}
                  >
                    {prompt.roles.length === 0 ? 'no role' : prompt.roles.join(', ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <PromptDetail
        prompt={detail.data}
        summary={all.find((entry) => entry.name === selected)}
        isLoading={detail.isLoading}
        error={detail.isError ? detail.error : undefined}
      />
    </div>
  );
}

function PromptDetail(props: {
  prompt: PromptContentView | undefined;
  summary: PromptView | undefined;
  isLoading: boolean;
  error: unknown;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const meta = props.prompt ?? props.summary;

  if (meta === undefined) {
    return (
      <Panel>
        <Empty title={props.isLoading ? 'Loading…' : 'Select a prompt'} />
      </Panel>
    );
  }

  const content = props.prompt?.content;

  const copy = (): void => {
    if (content === undefined) return;
    void navigator.clipboard?.writeText(content).then(
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
    <Panel
      divided
      header={
        <div className="flex flex-col gap-2.5 px-4 pb-3 pt-3.5">
          <SectionHeader title={meta.name} className="px-0 py-0">
            <div className="flex items-center gap-2">
              <Badge tone={meta.permissions === 'write' ? 'warning' : 'muted'} caps>
                {meta.permissions}
              </Badge>
              <button
                type="button"
                onClick={copy}
                disabled={content === undefined}
                className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-2 px-2 py-1 text-micro text-muted hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Copy className="h-3 w-3" aria-hidden />
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </SectionHeader>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 xl:grid-cols-4">
            {/* Not "version": prompts declare none, and the digest is the honest
                stand-in. Labelled as a digest so nobody reads it as a number
                somebody maintains. */}
            <MetaCell
              label="Digest"
              value={<span className="font-mono">{meta.digest}</span>}
            />
            <MetaCell
              label="Source"
              title={meta.source}
              value={<span className="font-mono">{meta.source}</span>}
            />
            <MetaCell label="Output" value={meta.outputFormat} />
            <MetaCell label="Updated" value={formatWhenCompact(meta.updatedAt)} />
          </dl>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 xl:grid-cols-4">
            <MetaCell
              label="Roles"
              title={meta.roles.join(', ')}
              value={meta.roles.length === 0 ? '—' : meta.roles.join(', ')}
            />
            <MetaCell
              label="Stages"
              title={meta.stages.join(', ')}
              value={
                meta.stages.length === 0
                  ? 'per task, not a stage'
                  : meta.stages.map((stage) => humanise(stage)).join(', ')
              }
            />
            <MetaCell
              label="Required vars"
              // Four of them on the real architecture-impact prompt, which the
              // fixtures did not have and a live run did.
              title={meta.requiredVars.join(', ')}
              value={meta.requiredVars.length === 0 ? 'none' : meta.requiredVars.join(', ')}
            />
            <MetaCell
              label="Structured output"
              value={meta.nativeStructuredOutput ? 'native required' : 'prompted is enough'}
            />
          </dl>

          {meta.error === undefined ? null : (
            <p className="flex gap-2 rounded-md border border-danger/25 bg-danger-soft px-2.5 py-2 text-label text-danger">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              {meta.error}
            </p>
          )}
        </div>
      }
    >
      {/* The prompt itself, on the sunken surface the terminal uses. Nothing else
          in the app is below the page ground, so this reads as source text rather
          than as prose the UI wrote. */}
      <div className="min-h-0 flex-1 overflow-auto bg-sunken p-3.5">
        {props.error !== undefined ? (
          // A prompt the installation does not ship and a prompt the server could
          // not read are different problems with different fixes (§95).
          <Notice
            tone="danger"
            title={
              props.error instanceof ApiError && props.error.status === 404
                ? `This installation ships no prompt called ${meta.name}.`
                : `${meta.name} could not be read.`
            }
            detail={props.error instanceof Error ? props.error.message : undefined}
            consequence={
              props.error instanceof ApiError && props.error.status === 404
                ? 'Any role that runs it would fail at the stage that needs it — Agents & Models says which roles those are.'
                : 'Prompts are read from the installation directory, so this is about the install rather than about any run.'
            }
            action="Reinstall agent-flow, or check the prompts directory it was started from."
          />
        ) : content === undefined ? (
          <Empty title={props.isLoading ? 'Loading…' : 'Not available.'} />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-micro leading-relaxed text-muted">
            {content}
            {props.prompt?.truncated === true ? '\n\n… truncated' : ''}
          </pre>
        )}
      </div>
    </Panel>
  );
}

/**
 * Search covers the name, the roles and the stages (§83).
 *
 * Role matters most: "which prompt does the planner use" is the question somebody
 * has when they are looking at a plan they do not like, and answering it by
 * opening eight files is what the search box is for.
 */
export function filterPrompts(prompts: readonly PromptView[], query: string): PromptView[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...prompts];

  return prompts.filter(
    (prompt) =>
      prompt.name.toLowerCase().includes(needle) ||
      prompt.roles.some((role) => role.toLowerCase().includes(needle)) ||
      prompt.stages.some((stage) => stage.toLowerCase().includes(needle)),
  );
}
