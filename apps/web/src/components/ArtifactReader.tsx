import { useState, useMemo, type ReactNode } from 'react';
import {
  Check,
  Copy,
  FileCode,
  FileText,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { cx } from './ui';

export interface ArtifactReaderProps {
  readonly content: string;
  readonly name?: string | undefined;
  readonly label?: string | undefined;
  readonly isExpanded?: boolean | undefined;
  readonly onToggleExpand?: (() => void) | undefined;
  readonly truncated?: boolean | undefined;
}

/**
 * Highlights and recognizes important architectural section titles.
 */
function isKeySection(title: string): { isKey: boolean; tone: 'warning' | 'info' | 'danger' | 'success' } {
  const lower = title.toLowerCase();
  if (lower.includes('risk') || lower.includes('security') || lower.includes('vulnerability')) {
    return { isKey: true, tone: 'danger' };
  }
  if (lower.includes('question') || lower.includes('open question') || lower.includes('decision')) {
    return { isKey: true, tone: 'warning' };
  }
  if (lower.includes('finding') || lower.includes('acceptance criteria') || lower.includes('validation')) {
    return { isKey: true, tone: 'info' };
  }
  if (lower.includes('architecture') || lower.includes('impact') || lower.includes('tradeoff')) {
    return { isKey: true, tone: 'success' };
  }
  return { isKey: false, tone: 'info' };
}

/**
 * Code block with copy button and syntax tag.
 */
function CodeBlock(props: { code: string; language?: string | undefined }): JSX.Element {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(props.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div className="group relative my-3 rounded-md border border-border bg-surface-2 overflow-hidden">
      <div className="flex h-7 items-center justify-between border-b border-border bg-surface px-3 text-micro text-faint">
        <span className="font-mono lowercase">{props.language || 'text'}</span>
        <button
          type="button"
          onClick={onCopy}
          aria-label="Copy code to clipboard"
          className="flex items-center gap-1 text-muted transition-colors hover:text-text"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-success" />
              <span className="text-success">Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-micro leading-relaxed text-text">
        <code>{props.code}</code>
      </pre>
    </div>
  );
}

/**
 * Parses inline formatting: `code`, **bold**, *italic*.
 */
function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(
        <code
          key={match.index}
          className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-micro text-primary-bright"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(
        <strong key={match.index} className="font-semibold text-text">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      parts.push(
        <em key={match.index} className="italic text-text">
          {token.slice(1, -1)}
        </em>,
      );
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

/**
 * Lightweight, fast and robust Markdown renderer for technical artifacts.
 */
export function MarkdownContent(props: { content: string }): JSX.Element {
  const lines = useMemo(() => props.content.split(/\r?\n/), [props.content]);

  const rendered = useMemo(() => {
    const elements: ReactNode[] = [];
    let inCodeBlock = false;
    let codeLanguage = '';
    let codeLines: string[] = [];
    let inList = false;
    let listItems: ReactNode[] = [];
    let listOrdered = false;

    const flushList = () => {
      if (!inList) return;
      if (listOrdered) {
        elements.push(
          <ol key={`ol-${elements.length}`} className="my-2 ml-5 list-decimal space-y-1 text-label text-muted">
            {listItems}
          </ol>,
        );
      } else {
        elements.push(
          <ul key={`ul-${elements.length}`} className="my-2 ml-5 list-disc space-y-1 text-label text-muted">
            {listItems}
          </ul>,
        );
      }
      inList = false;
      listItems = [];
    };

    const flushCode = () => {
      if (!inCodeBlock) return;
      elements.push(
        <CodeBlock
          key={`code-${elements.length}`}
          code={codeLines.join('\n')}
          language={codeLanguage}
        />,
      );
      inCodeBlock = false;
      codeLanguage = '';
      codeLines = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;

      // Fenced code block start/end
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          flushCode();
        } else {
          flushList();
          inCodeBlock = true;
          codeLanguage = line.slice(3).trim();
          codeLines = [];
        }
        continue;
      }

      if (inCodeBlock) {
        codeLines.push(line);
        continue;
      }

      // Empty line
      if (!line.trim()) {
        flushList();
        continue;
      }

      // Headings (#, ##, ###, ####)
      const h1Match = line.match(/^#\s+(.+)$/);
      if (h1Match && h1Match[1] !== undefined) {
        flushList();
        const title = h1Match[1];
        const { isKey, tone } = isKeySection(title);
        elements.push(
          <div key={`h1-${i}`} className="mt-6 mb-3 border-b border-border pb-2">
            <h1 className="text-xl font-bold tracking-tight text-text flex items-center gap-2">
              {renderInline(title)}
              {isKey && (
                <span
                  className={cx(
                    'rounded-sm px-1.5 py-0.5 text-micro uppercase tracking-caps font-semibold',
                    tone === 'danger' && 'bg-danger-soft text-danger border border-danger/30',
                    tone === 'warning' && 'bg-warning-soft text-warning border border-warning/30',
                    tone === 'info' && 'bg-primary-soft text-text border border-primary-border',
                    tone === 'success' && 'bg-success-soft text-success border border-success/30',
                  )}
                >
                  Key Section
                </span>
              )}
            </h1>
          </div>,
        );
        continue;
      }

      const h2Match = line.match(/^##\s+(.+)$/);
      if (h2Match && h2Match[1] !== undefined) {
        flushList();
        const title = h2Match[1];
        const { isKey, tone } = isKeySection(title);
        elements.push(
          <div key={`h2-${i}`} className="mt-5 mb-2">
            <h2 className="text-lg font-semibold tracking-tight text-text flex items-center gap-2">
              {renderInline(title)}
              {isKey && (
                <span
                  className={cx(
                    'rounded-sm px-1.5 py-0.5 text-micro uppercase tracking-caps font-semibold',
                    tone === 'danger' && 'bg-danger-soft text-danger',
                    tone === 'warning' && 'bg-warning-soft text-warning',
                    tone === 'info' && 'bg-primary-soft text-text',
                    tone === 'success' && 'bg-success-soft text-success',
                  )}
                >
                  Key Section
                </span>
              )}
            </h2>
          </div>,
        );
        continue;
      }

      const h3Match = line.match(/^###\s+(.+)$/);
      if (h3Match && h3Match[1] !== undefined) {
        flushList();
        const title = h3Match[1];
        elements.push(
          <h3 key={`h3-${i}`} className="mt-4 mb-1.5 text-body-lg font-semibold text-text">
            {renderInline(title)}
          </h3>,
        );
        continue;
      }

      const h4Match = line.match(/^####\s+(.+)$/);
      if (h4Match && h4Match[1] !== undefined) {
        flushList();
        elements.push(
          <h4 key={`h4-${i}`} className="mt-3 mb-1 text-label font-medium text-text">
            {renderInline(h4Match[1])}
          </h4>,
        );
        continue;
      }

      // Blockquotes & Alerts (> [!NOTE] etc)
      if (line.startsWith('>')) {
        flushList();
        const quoteContent = line.replace(/^>\s?/, '');
        elements.push(
          <blockquote
            key={`quote-${i}`}
            className="my-2 border-l-2 border-primary-border bg-surface-2 px-3 py-1.5 text-label text-muted rounded-r"
          >
            {renderInline(quoteContent)}
          </blockquote>,
        );
        continue;
      }

      // Bullet lists (- or *)
      const bulletMatch = line.match(/^[-*]\s+(.+)$/);
      if (bulletMatch && bulletMatch[1] !== undefined) {
        if (!inList || listOrdered) {
          flushList();
          inList = true;
          listOrdered = false;
        }
        listItems.push(<li key={`li-${i}`}>{renderInline(bulletMatch[1])}</li>);
        continue;
      }

      // Numbered lists (1. 2. etc)
      const numMatch = line.match(/^\d+\.\s+(.+)$/);
      if (numMatch && numMatch[1] !== undefined) {
        if (!inList || !listOrdered) {
          flushList();
          inList = true;
          listOrdered = true;
        }
        listItems.push(<li key={`nli-${i}`}>{renderInline(numMatch[1])}</li>);
        continue;
      }

      // Regular paragraph
      flushList();
      elements.push(
        <p key={`p-${i}`} className="my-1.5 text-label leading-relaxed text-muted">
          {renderInline(line)}
        </p>,
      );
    }

    flushList();
    flushCode();

    return elements;
  }, [lines]);

  return <div className="space-y-1">{rendered}</div>;
}

/**
 * ArtifactReader component with Raw/Rendered toggle and Expanded view option.
 */
export function ArtifactReader(props: ArtifactReaderProps): JSX.Element {
  const [viewMode, setViewMode] = useState<'rendered' | 'raw'>('rendered');
  const [copied, setCopied] = useState(false);

  const onCopyAll = async () => {
    try {
      await navigator.clipboard.writeText(props.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Reader Toolbar */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface px-3">
        <div className="flex items-center gap-2">
          <div className="flex rounded border border-border bg-surface-2 p-0.5" role="group" aria-label="View mode">
            <button
              type="button"
              aria-pressed={viewMode === 'rendered'}
              onClick={() => setViewMode('rendered')}
              className={cx(
                'flex items-center gap-1 rounded px-2 py-0.5 text-micro transition-colors',
                viewMode === 'rendered'
                  ? 'bg-surface font-medium text-text shadow-sm'
                  : 'text-faint hover:text-text',
              )}
            >
              <FileText className="h-3 w-3" aria-hidden />
              <span>Rendered</span>
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'raw'}
              onClick={() => setViewMode('raw')}
              className={cx(
                'flex items-center gap-1 rounded px-2 py-0.5 text-micro transition-colors',
                viewMode === 'raw'
                  ? 'bg-surface font-medium text-text shadow-sm'
                  : 'text-faint hover:text-text',
              )}
            >
              <FileCode className="h-3 w-3" aria-hidden />
              <span>Raw</span>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCopyAll}
            title="Copy entire document content"
            className="flex h-6 items-center gap-1 rounded border border-border bg-surface-2 px-2 text-micro text-muted hover:border-border-strong hover:text-text"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-success" />
                <span className="text-success">Copied</span>
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                <span>Copy content</span>
              </>
            )}
          </button>

          {props.onToggleExpand ? (
            <button
              type="button"
              onClick={props.onToggleExpand}
              aria-label={props.isExpanded ? 'Collapse reader' : 'Expand reader'}
              title={props.isExpanded ? 'Collapse reader' : 'Expand reader'}
              className="flex h-6 items-center gap-1 rounded border border-border bg-surface-2 px-2 text-micro text-muted hover:border-border-strong hover:text-text"
            >
              {props.isExpanded ? (
                <>
                  <Minimize2 className="h-3 w-3" />
                  <span className="hidden sm:inline">Collapse</span>
                </>
              ) : (
                <>
                  <Maximize2 className="h-3 w-3" />
                  <span className="hidden sm:inline">Expand</span>
                </>
              )}
            </button>
          ) : null}
        </div>
      </div>

      {/* Reader Content Area */}
      <div className="min-h-0 flex-1 overflow-auto bg-sunken p-4">
        <div className="mx-auto max-w-4xl">
          {viewMode === 'rendered' ? (
            <div className="prose prose-invert max-w-none text-text">
              <MarkdownContent content={props.content} />
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-micro leading-relaxed text-muted bg-surface-2 p-4 rounded-md border border-border">
              {props.content}
            </pre>
          )}

          {props.truncated ? (
            <p className="mt-4 border-t border-border pt-2 text-center text-micro text-warning">
              … content was truncated by the server limit
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
