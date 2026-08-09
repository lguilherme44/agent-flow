import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Executable architecture rules (plan §7.2).
 *
 * The spec states these constraints in prose. Prose does not survive six months
 * of maintenance — these do. Every rule here maps to a decision that, once
 * broken, is expensive to unwind.
 */

const ROOT = join(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) out.push(full);
    }
  };
  walk(abs);
  return out;
}

function read(file: string): { path: string; text: string } {
  return { path: relative(ROOT, file), text: readFileSync(file, 'utf8') };
}

/** Import specifiers only — comments and prose must not trip these rules. */
function importSpecifiers(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s[^;]*?from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) out.push(match[1]);
    }
  }
  return out;
}

/** Strips comments and string literals so identifier scans do not hit prose. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

describe('src/core stays pure (AD-03)', () => {
  it('imports no Node built-ins', () => {
    const offenders = sourceFiles('src/core')
      .map(read)
      .filter(({ text }) => importSpecifiers(text).some((s) => s.startsWith('node:')))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('imports no adapters', () => {
    const offenders = sourceFiles('src/core')
      .map(read)
      .filter(({ text }) => importSpecifiers(text).some((s) => s.includes('adapters/')))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});

describe('src/core knows no provider (§3, §58)', () => {
  // The single most important property of the design: swapping runners must
  // never require touching the core.
  const FORBIDDEN = ['claude', 'codex', 'anthropic', 'openai', 'gpt-', 'opus', 'sonnet'];

  it('mentions no provider, model or CLI name', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('src/core')) {
      const { path, text } = read(file);
      const haystack = codeOnly(text).toLowerCase();
      const hits = FORBIDDEN.filter((needle) => haystack.includes(needle));
      if (hits.length > 0) offenders.push(`${path}: ${hits.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('src/ports declares contracts only (AD-03)', () => {
  it('imports no adapters', () => {
    const offenders = sourceFiles('src/ports')
      .map(read)
      .filter(({ text }) => importSpecifiers(text).some((s) => s.includes('adapters/')))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});

describe('no stack-specific rules leak into the tool (§58)', () => {
  // agent-flow must not know that Flutter or NestJS exist outside of stack
  // detection, whose entire job is mapping marker files to labels.
  const FRAMEWORKS = ['flutter', 'nestjs', 'react', 'laravel', 'django', 'rails'];
  const ALLOWED = ['src/config/stack-detection.ts'];

  it('mentions no framework outside stack detection', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('src')) {
      const { path, text } = read(file);
      if (ALLOWED.includes(path)) continue;
      const haystack = codeOnly(text).toLowerCase();
      const hits = FRAMEWORKS.filter((needle) => haystack.includes(needle));
      if (hits.length > 0) offenders.push(`${path}: ${hits.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('graph logic lives in exactly one module (C-3)', () => {
  // The rev.1 plan would have grown a partial cycle check inside planning and a
  // full DAG later. One module, one implementation.
  //
  // The rule is against *reimplementing*, not against using: a module that
  // imports from core/dag.ts is doing exactly the right thing. Only a module
  // that talks about topological ordering while sourcing it from somewhere else
  // is a violation.
  const HOME = 'src/core/dag.ts';

  it('implements topological ordering only in core/dag.ts', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles('src')) {
      const { path, text } = read(file);
      if (path === HOME) continue;

      const mentionsGraphLogic = /topolog|kahn/i.test(codeOnly(text));
      if (!mentionsGraphLogic) continue;

      const importsTheRealThing = importSpecifiers(text).some((specifier) =>
        specifier.includes('core/dag'),
      );
      if (!importsTheRealThing) offenders.push(path);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the implementation where it belongs', () => {
    // Guards the rule above from passing vacuously if dag.ts were ever emptied.
    const { text } = read(join(ROOT, HOME));
    expect(text).toMatch(/topological/i);
  });
});
