import type { ProjectConfig } from '../contracts/index.js';

export const WORKFLOW_CLASSES = ['trivial', 'simple', 'standard', 'high-risk'] as const;
export type WorkflowClass = (typeof WORKFLOW_CLASSES)[number];

export interface CeremonyBudget {
  readonly workflow: WorkflowClass;
  readonly maxPlanningCalls: number;
  readonly maxRevisionCycles: number;
  readonly maxTasks: number;
}

/**
 * Where the resulting class came from (FR-014). `carried` is a class an earlier
 * classification of this run settled and a re-plan hands back in; it is recorded apart
 * from `operator` because every re-plan used to say an operator had set it when nobody had.
 */
export type WorkflowOrigin = 'detected' | 'operator' | 'carried';

/**
 * One piece of text that took part in the decision (FR-013). The excerpt is cut from the
 * feature request, which the run already stores, so it adds no new data to any record.
 */
export interface WorkflowEvidence {
  readonly signal: string;
  readonly excerpt: string;
  readonly source: 'text' | 'file';
  /** The repository path that armed a file-fact signal. */
  readonly file?: string;
  /** Present, and `true`, for a high-risk mention a negator took out of the count. */
  readonly negated?: boolean;
}

export interface WorkflowClassificationResult {
  readonly workflow: WorkflowClass;
  readonly rationale: string;
  readonly deterministic: boolean;
  readonly confidence: number;
  readonly highRiskSignalsDetected: string[];
  readonly origin: WorkflowOrigin;
  /** The class the request decides on its own, before any override is applied. */
  readonly detected: WorkflowClass;
  /** The override that was asked for, when one was. */
  readonly requested?: WorkflowClass;
  readonly evidence: readonly WorkflowEvidence[];
}

export interface WorkflowClassificationContext {
  readonly projectDir?: string;
  readonly projectConfig?: ProjectConfig;
  readonly isStaticWeb?: boolean;
  readonly explicitOverride?: WorkflowClass;
  /** Who supplied {@link explicitOverride}. Omitted with an override present means `operator`. */
  readonly overrideOrigin?: 'operator' | 'carried';
  readonly files?: readonly string[];
}

/**
 * Keywords that unequivocally indicate high architectural, security, or data risk.
 * A request containing these signals MUST NEVER be automatically downgraded to simple or trivial.
 */
export const HIGH_RISK_SIGNALS: readonly string[] = [
  'auth',
  'authentication',
  'authorization',
  'token',
  'jwt',
  'session',
  'password',
  'credential',
  'secret',
  'permission',
  'rbac',
  'iam',
  'crypto',
  'encryption',
  'decryption',
  'payment',
  'stripe',
  'billing',
  'checkout',
  'migration',
  'database migration',
  'drop table',
  'alter table',
  'schema change',
  'destructive',
  'hard delete',
  'data wipe',
  'infra',
  'infrastructure',
  'terraform',
  'cloudformation',
];

/**
 * Keywords that unequivocally describe trivial, localized edits.
 */
export const TRIVIAL_SIGNALS: readonly string[] = [
  'typo',
  'fix typo',
  'fix spelling',
  'update readme',
  'update documentation',
  'docstring',
  'comment',
  'license text',
  'bump version string',
];

/**
 * Keywords that describe simple scoped UI/styling/isolated tasks.
 */
export const SIMPLE_SIGNALS: readonly string[] = [
  'dark mode',
  'theme',
  'css',
  'style',
  'color',
  'spacing',
  'button style',
  'landing page',
  'header text',
  'favicon',
  'static web',
  'copy change',
  'tooltip text',
  'badge color',
  'font size',
  'layout padding',
];

/**
 * Names of this product's cross-module code (FR-012). A styling word next to one of these
 * is not a scoped UI change. Measured on this repository's own F7a run (field report
 * A-14): a request touching state, run-actions, the scheduler and prompts also named the
 * Deck's screen, was classified `simple` as a "styling/isolated UI request", and was
 * planned with no impact stage, no SDD and at most three tasks for four items.
 * These are this repository's vocabulary; on another repository they rarely fire, which
 * leaves the previous behaviour (R-4).
 */
export const CROSS_MODULE_SIGNALS: readonly string[] = [
  'run-actions',
  'scheduler',
  'state.json',
  'state-store',
  'state.schema',
];

/**
 * Words that, within the two words before a high-risk mention in the same sentence, take
 * it out of the count (FR-010). `no` and `nem` are left out on purpose: Portuguese `no` is
 * "in the" ("no token JWT"), and `nem` joins a second item to a negation that already
 * covered the first ("não trafega token nem session") rather than negating on its own.
 */
const NEGATORS: ReadonlySet<string> = new Set([
  'não',
  'sem',
  'nenhum',
  'nenhuma',
  'nunca',
  'not',
  'never',
  'without',
]);

/** How many words before a mention the negation window reaches. */
const NEGATION_WINDOW = 2;

/**
 * A word, for counting the negation window only: a maximal run of Unicode letters, digits
 * and `_`. Signal matching does not use it, so "auth-token" still matches `token`.
 */
const WORD = /[\p{L}\p{Nd}_]+/gu;

/**
 * A sentence break: `.`, `!`, `?` or `;` followed by whitespace or the end, or any line
 * break. The whitespace requirement is what keeps the `.` in `run-actions.ts` from
 * splitting a sentence. The Unicode line and paragraph separators are line breaks too.
 */
const SENTENCE_BREAK = /[.!?;](?=\s|$)|[\r\n\p{Zl}\p{Zp}]/gu;

/** The longest excerpt recorded, ellipses included (FR-013). */
const EXCERPT_MAX = 80;
const ELLIPSIS = '…';

/**
 * Returns the exact ceremony budget approved for a workflow class.
 */
export function getCeremonyBudget(workflow: WorkflowClass): CeremonyBudget {
  switch (workflow) {
    case 'trivial':
      return {
        workflow: 'trivial',
        maxPlanningCalls: 1,
        maxRevisionCycles: 0,
        maxTasks: 1,
      };
    case 'simple':
      return {
        workflow: 'simple',
        maxPlanningCalls: 2,
        maxRevisionCycles: 1,
        maxTasks: 3,
      };
    case 'standard':
      return {
        workflow: 'standard',
        maxPlanningCalls: 5,
        maxRevisionCycles: 2,
        maxTasks: 8,
      };
    case 'high-risk':
      return {
        workflow: 'high-risk',
        maxPlanningCalls: 5,
        maxRevisionCycles: 3,
        maxTasks: 8,
      };
  }
}

/**
 * The class one step up, for `revise --escalate` (FR-014). `undefined` for `high-risk`,
 * which has nowhere to go: returning `high-risk` again would let an escalation succeed
 * without changing anything, and the caller refuses instead.
 *
 * Read from {@link WORKFLOW_CLASSES} rather than restated, so the order has one owner.
 */
export function nextWorkflowClass(workflow: WorkflowClass): WorkflowClass | undefined {
  return WORKFLOW_CLASSES[WORKFLOW_CLASSES.indexOf(workflow) + 1];
}

/** One place in the request where a signal matched. */
interface Occurrence {
  readonly start: number;
  readonly end: number;
  readonly negated: boolean;
}

/** Where each sentence break sits, computed once per request. */
interface SentenceBreak {
  readonly index: number;
  readonly end: number;
}

function regexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The pattern for a signal: a **word**, case-insensitive, with any run of whitespace
 * between its words (FR-011). Every signal family and the file-fact mention words go
 * through this one matcher.
 *
 * `includes` was the original test and it was wrong in a way that only shows up in prose:
 * `table` is a substring of `unselectable`, `acceptable`, `suitable` and `portable`, so a
 * sentence about a file picker tripped the schema-migration detector. Measured on a real
 * request — "makes a HEIC photo unselectable on devices that shoot HEIC by default" — which
 * elevated the run to HIGH-RISK and, on a single-provider setup, refused it outright.
 *
 * Two matchers for one question was that defect; there is one. Escaping is a no-op for the
 * letter-and-space signals, and makes the `.` in `state.json` literal.
 */
function signalPattern(signal: string): RegExp {
  return new RegExp(`\\b${regexLiteral(signal).replace(/\s+/g, '\\s+')}\\b`, 'gi');
}

function sentenceBreaks(text: string): readonly SentenceBreak[] {
  return [...text.matchAll(SENTENCE_BREAK)].map((match) => {
    const index = match.index ?? 0;
    return { index, end: index + match[0].length };
  });
}

/**
 * The bounds of the sentence holding `[start, end)`. A break inside the match itself — a
 * multi-word signal whose `\s+` spans a line break — belongs to neither side.
 */
function sentenceAround(
  breaks: readonly SentenceBreak[],
  start: number,
  end: number,
  length: number,
): { readonly from: number; readonly to: number } {
  let from = 0;
  let to = length;
  for (const brk of breaks) {
    if (brk.end <= start) from = Math.max(from, brk.end);
    else if (brk.index >= end) to = Math.min(to, brk.index);
  }
  return { from, to };
}

/**
 * Whether one of the two words before a mention, in its sentence, is a negator (FR-010).
 *
 * The prefix is NFC-normalised before it is split so a decomposed "não" (`a` + combining
 * tilde) is one word, as the composed spelling is; the split would otherwise break it at
 * the combining mark, which is not a letter.
 */
function isNegated(sentencePrefix: string): boolean {
  const words = sentencePrefix.normalize('NFC').match(WORD) ?? [];
  return words.slice(-NEGATION_WINDOW).some((word) => NEGATORS.has(word.toLowerCase()));
}

function occurrencesOf(
  text: string,
  breaks: readonly SentenceBreak[],
  signal: string,
): readonly Occurrence[] {
  return [...text.matchAll(signalPattern(signal))].map((match) => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const { from } = sentenceAround(breaks, start, end, text.length);
    return { start, end, negated: isNegated(text.slice(from, start)) };
  });
}

/** Drops a half of a surrogate pair left at either edge by a cut. */
function withoutSplitPairs(text: string): string {
  return text.replace(/^[\uDC00-\uDFFF]/, '').replace(/[\uD800-\uDBFF]$/, '');
}

/**
 * The sentence around an occurrence, whitespace collapsed, at most {@link EXCERPT_MAX}
 * characters centred on the match, with an ellipsis on each side that was cut (FR-013).
 */
function excerptOf(text: string, breaks: readonly SentenceBreak[], occurrence: Occurrence): string {
  const { from, to } = sentenceAround(breaks, occurrence.start, occurrence.end, text.length);
  const collapse = (part: string): string => part.replace(/\s+/g, ' ');
  const before = collapse(text.slice(from, occurrence.start)).trimStart();
  const match = collapse(text.slice(occurrence.start, occurrence.end));
  const sentence = before + match + collapse(text.slice(occurrence.end, to)).trimEnd();
  if (sentence.length <= EXCERPT_MAX) return sentence;

  const lead = Math.floor((EXCERPT_MAX - match.length) / 2);
  let cutFrom = Math.min(Math.max(before.length - lead, 0), sentence.length - EXCERPT_MAX);
  let cutTo = cutFrom + EXCERPT_MAX;
  const cutLeft = cutFrom > 0;
  const cutRight = cutTo < sentence.length;
  // Each ellipsis takes one of the eighty characters, so the total never exceeds the cap.
  if (cutLeft) cutFrom += 1;
  if (cutRight) cutTo -= 1;
  const body = withoutSplitPairs(sentence.slice(cutFrom, cutTo)).trim();
  return (cutLeft ? ELLIPSIS : '') + body + (cutRight ? ELLIPSIS : '');
}

/**
 * Whether a repository path **names** one of these concerns, rather than merely containing
 * its letters somewhere.
 *
 * A path counts when a directory segment is the term, when the file's own name (without
 * extension) is the term, or when a segment begins `term.` — which is how `auth.config.ts`
 * declares itself. Raw `includes` counted far more than that: `migration_partner/`, a
 * *product* directory in a Flutter app (the user migrated from one storefront to another),
 * satisfied the schema-migration path test permanently, so every feature in that repository
 * carried half of a high-risk signal that nothing could clear.
 */
function pathNamesConcern(file: string, terms: readonly string[]): boolean {
  const segments = file.toLowerCase().split(/[\\/]+/).filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  const basename = last.replace(/\.[^.]+$/, '');
  return terms.some(
    (term) =>
      segments.includes(term) ||
      basename === term ||
      segments.some((segment) => segment.startsWith(`${term}.`)),
  );
}

/**
 * A high-risk concern a repository path can arm, and the words in the request that must
 * go with it. Both halves are narrow on purpose: the path must NAME the concern and the
 * request must MENTION it as a word. Either half left loose produces a signal the operator
 * cannot clear by rewriting the request — and since an explicit override cannot downgrade a
 * detected signal, a false positive here is not a warning, it is a refusal.
 */
interface FileFact {
  readonly signal: string;
  readonly names: (file: string) => boolean;
  readonly words: readonly string[];
}

const FILE_FACTS: readonly FileFact[] = [
  {
    signal: 'auth',
    names: (file) => pathNamesConcern(file, ['auth', 'authentication', 'authorization']),
    words: ['login', 'session', 'user', 'auth'],
  },
  {
    signal: 'migration',
    // `migrations/` (the directory) and `*.sql` are what a schema migration looks like.
    // A directory merely *containing* the letters "migration" is not one.
    names: (file) => pathNamesConcern(file, ['migrations', 'schema']) || file.toLowerCase().endsWith('.sql'),
    words: ['db', 'table', 'database', 'schema'],
  },
  {
    signal: 'payment',
    names: (file) => pathNamesConcern(file, ['payment', 'payments', 'stripe', 'billing']),
    words: ['pay', 'card', 'invoice', 'billing'],
  },
];

/** What the request decides on its own, before an override is looked at. */
interface Detection {
  readonly workflow: WorkflowClass;
  readonly rationale: string;
  readonly confidence: number;
  readonly highRisk: string[];
  readonly evidence: readonly WorkflowEvidence[];
  /** The counted evidence, quoted, for a rationale that has to explain the detected class. */
  readonly quoted: string;
}

function quote(label: string, excerpt: string): string {
  return `${label} "${excerpt}"`;
}

function detectWorkflow(featureRequest: string, context: WorkflowClassificationContext): Detection {
  const normalized = featureRequest.toLowerCase();
  const breaks = sentenceBreaks(featureRequest);
  const scan = (signal: string): readonly Occurrence[] => occurrencesOf(featureRequest, breaks, signal);
  const cut = (occurrence: Occurrence): string => excerptOf(featureRequest, breaks, occurrence);

  const evidence: WorkflowEvidence[] = [];
  const highRisk: string[] = [];
  const highRiskQuotes: string[] = [];
  // One negated entry per distinct mention: a request listing ten migration files would
  // otherwise repeat the same excerpt once per file.
  const negatedSeen = new Set<string>();
  const recordNegated = (entry: WorkflowEvidence): void => {
    const key = JSON.stringify([entry.source, entry.signal, entry.excerpt]);
    if (negatedSeen.has(key)) return;
    negatedSeen.add(key);
    evidence.push({ ...entry, negated: true });
  };

  // High-risk text signals. Every occurrence is scanned: the signal counts when any one of
  // them is not negated, so "não é o token antigo, é o token novo" still counts.
  for (const signal of HIGH_RISK_SIGNALS) {
    const found = scan(signal);
    const counted = found.find((occurrence) => !occurrence.negated);
    if (counted) {
      const excerpt = cut(counted);
      highRisk.push(signal);
      highRiskQuotes.push(quote(signal, excerpt));
      evidence.push({ signal, excerpt, source: 'text' });
    }
    for (const occurrence of found.filter((o) => o.negated)) {
      recordNegated({ signal, excerpt: cut(occurrence), source: 'text' });
    }
  }

  // High-risk signals from deterministic repository file facts. The mention scan does not
  // depend on the file, so it runs once per concern however many paths name it.
  if (context.files && context.files.length > 0) {
    const mentions = new Map<string, readonly Occurrence[]>();
    const mentionsOf = (fact: FileFact): readonly Occurrence[] => {
      const cached = mentions.get(fact.signal);
      if (cached) return cached;
      const found = fact.words.flatMap((word) => scan(word));
      mentions.set(fact.signal, found);
      return found;
    };
    for (const file of context.files) {
      for (const fact of FILE_FACTS) {
        if (!fact.names(file) || highRisk.some((s) => s.startsWith(fact.signal))) continue;
        const found = mentionsOf(fact);
        const counted = found.find((occurrence) => !occurrence.negated);
        if (counted) {
          const label = `${fact.signal} (file: ${file})`;
          const excerpt = cut(counted);
          highRisk.push(label);
          highRiskQuotes.push(quote(label, excerpt));
          evidence.push({ signal: fact.signal, excerpt, source: 'file', file });
          continue;
        }
        for (const occurrence of found) {
          recordNegated({ signal: fact.signal, excerpt: cut(occurrence), source: 'file', file });
        }
      }
    }
  }

  // High-risk rule: any counted high-risk signal elevates to HIGH-RISK.
  if (highRisk.length > 0) {
    const quoted = highRiskQuotes.join(', ');
    return {
      workflow: 'high-risk',
      rationale: `High-risk security/data/infrastructure signals detected: ${quoted}.`,
      confidence: 1.0,
      highRisk,
      evidence,
      quoted,
    };
  }

  // The first signal of a family that matches, in the family's own order. Trivial, simple
  // and cross-module signals are not negation-aware (FR-010): negation there would change
  // outcomes nobody asked to change.
  const firstOf = (signals: readonly string[]): WorkflowEvidence | undefined => {
    for (const signal of signals) {
      const [occurrence] = scan(signal);
      if (occurrence) return { signal, excerpt: cut(occurrence), source: 'text' };
    }
    return undefined;
  };

  // Trivial rule: obvious typo/doc request with low complexity.
  const trivial = firstOf(TRIVIAL_SIGNALS);
  if (trivial && normalized.length < 150) {
    const quoted = quote(trivial.signal, trivial.excerpt);
    return {
      workflow: 'trivial',
      rationale: `Deterministic classification: trivial documentation, comment, or typographical fix (${quoted}).`,
      confidence: 0.95,
      highRisk: [],
      evidence: [...evidence, trivial],
      quoted,
    };
  }

  // Simple rule: static-web project, or a styling/isolated UI request that names no
  // cross-module code (FR-012). The static-web rule is unchanged: the guard is on what
  // the styling words alone may decide.
  const isStaticWeb =
    context.isStaticWeb === true ||
    context.projectConfig?.project?.type === 'static-web';
  const styling = firstOf(SIMPLE_SIGNALS);
  const crossModule = styling && !isStaticWeb ? firstOf(CROSS_MODULE_SIGNALS) : undefined;

  if (styling && crossModule) {
    const stylingQuote = quote(styling.signal, styling.excerpt);
    const crossModuleQuote = quote(crossModule.signal, crossModule.excerpt);
    return {
      workflow: 'standard',
      rationale:
        `Standard feature workflow: the styling request (${stylingQuote}) also names ` +
        `cross-module code (${crossModuleQuote}), so it is not classified as a scoped UI change.`,
      confidence: 0.85,
      highRisk: [],
      evidence: [...evidence, styling, crossModule],
      quoted: `${stylingQuote}, ${crossModuleQuote}`,
    };
  }

  if (isStaticWeb || styling) {
    const quoted = styling ? quote(styling.signal, styling.excerpt) : '';
    return {
      workflow: 'simple',
      rationale:
        `Deterministic classification: scoped feature without cross-module architectural risks` +
        (isStaticWeb ? ' (static-web project)' : '') +
        (styling ? ` (styling/isolated UI request: ${quoted})` : '') +
        '.',
      confidence: 0.9,
      highRisk: [],
      evidence: styling ? [...evidence, styling] : evidence,
      quoted,
    };
  }

  // Default: STANDARD (never use simple as ambiguous fallback). No signal decided it, so
  // there is nothing to quote and the sentence is the one it always was.
  return {
    workflow: 'standard',
    rationale: 'Standard feature workflow requiring complete architectural discovery and SDD contract.',
    confidence: 0.85,
    highRisk: [],
    evidence,
    quoted: '',
  };
}

/**
 * Classifies a feature request into a workflow class using deterministic facts first.
 * High-risk signals monotonically elevate the workflow and prevent unsafe downgrades.
 *
 * `detected` is computed before the override is applied, so the record shows what the
 * request says on its own next to what was asked for (FR-014).
 */
export function classifyWorkflow(
  featureRequest: string,
  context: WorkflowClassificationContext = {},
): WorkflowClassificationResult {
  const detection = detectWorkflow(featureRequest, context);
  const requested = context.explicitOverride;

  if (!requested) {
    return {
      workflow: detection.workflow,
      rationale: detection.rationale,
      deterministic: true,
      confidence: detection.confidence,
      highRiskSignalsDetected: detection.highRisk,
      origin: 'detected',
      detected: detection.workflow,
      evidence: detection.evidence,
    };
  }

  const origin: WorkflowOrigin = context.overrideOrigin ?? 'operator';
  // A carried class is one an earlier classification settled; its rationale must not
  // claim an operator set it, because every re-plan used to say so when nobody had.
  const settled = {
    deterministic: true,
    confidence: 1.0,
    highRiskSignalsDetected: detection.highRisk,
    origin,
    detected: detection.workflow,
    requested,
    evidence: detection.evidence,
  };

  // Safety Invariant: cannot downgrade a high-risk request to trivial, simple, or standard.
  // It holds for a carried class exactly as for an operator's.
  if (detection.highRisk.length > 0 && requested !== 'high-risk') {
    return {
      ...settled,
      workflow: 'high-risk',
      rationale:
        (origin === 'operator'
          ? `Explicit override "${requested}" refused`
          : `Carried-over workflow "${requested}" raised`) +
        `: high-risk security/data/infrastructure signals detected (${detection.quoted}). ` +
        `High-risk operations cannot be downgraded to ${requested}.`,
    };
  }

  const alone =
    `the request alone classifies as "${detection.workflow}"` +
    (detection.quoted ? ` (${detection.quoted})` : '');
  return {
    ...settled,
    workflow: requested,
    rationale:
      origin === 'operator'
        ? `Explicit workflow override set by operator to "${requested}"; ${alone}.`
        : `Workflow "${requested}" carried over from the earlier classification; ${alone}.`,
  };
}

/**
 * Finding closure status produced by planner during revision cycles.
 */
export type FindingClosureStatus =
  | 'RESOLVED'
  | 'SUPERSEDED'
  | 'PROPOSE_ACCEPT_WITH_RATIONALE';

export interface FindingClosureItem {
  readonly findingIndex: number;
  readonly status: FindingClosureStatus;
  readonly rationale?: string;
}

/**
 * Verifies whether a workflow has exceeded its ceremony budget stop condition.
 */
export function evaluateStopCondition(
  workflow: WorkflowClass,
  revisionCount: number,
  hasFindings: boolean,
): { shouldStop: boolean; reason?: string } {
  const budget = getCeremonyBudget(workflow);

  if (workflow === 'trivial' && revisionCount > 0) {
    return {
      shouldStop: true,
      reason: 'TRIVIAL workflow does not support automated revision cycles (budget = 0).',
    };
  }

  if (workflow === 'simple' && revisionCount >= budget.maxRevisionCycles && hasFindings) {
    return {
      shouldStop: true,
      reason:
        'STOP_AND_ASK_HUMAN: SIMPLE workflow reached its maximum allowed revision cycle (1 cycle). ' +
        'Residual findings require human decision or workflow elevation.',
    };
  }

  if (revisionCount >= budget.maxRevisionCycles && hasFindings) {
    return {
      shouldStop: true,
      reason:
        `STOP_AND_ASK_HUMAN: ${workflow.toUpperCase()} workflow reached ceremony budget limit ` +
        `(${budget.maxRevisionCycles} revision cycles).`,
    };
  }

  return { shouldStop: false };
}
