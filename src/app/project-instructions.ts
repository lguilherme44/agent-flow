import type { FileSystem } from '../ports/index.js';

/** Marks the block `init` owns inside an existing AGENTS.md. */
export const AGENTS_BEGIN = '<!-- agent-flow:begin -->';
export const AGENTS_END = '<!-- agent-flow:end -->';

/**
 * Everything `init` writes into a new AGENTS.md above its own block.
 *
 * Exported because `readProjectInstructions` has to recognise it: an AGENTS.md that is
 * still exactly this carries no rule of the repository's, and treating it as the
 * repository's instructions is how a 227-line CLAUDE.md went unread.
 */
export const AGENTS_MD_SCAFFOLD: readonly string[] = [
  '# Project Instructions',
  '',
  'Standing rules for anyone — human or agent — working in this repository.',
  'Everything outside the agent-flow block below is yours to write.',
  '',
  '## Architecture',
  '',
  '- Describe the boundaries that must not be crossed.',
  '',
  '## Tests',
  '',
  '- Say when a change requires a test.',
  '',
];

/**
 * The repository's own rules, as every stage receives them.
 *
 * AGENTS.md first, as it always was. **CLAUDE.md when AGENTS.md has nothing of the
 * repository's in it** — absent, or still the scaffold `init` writes. Measured 23/09/2026 on
 * a Python service: its rules (tests run in a container; the integration conftest TRUNCATEs
 * the database it points at) live in a 227-line CLAUDE.md, `init` wrote a 21-line scaffold,
 * and every stage received the scaffold. The rules existed and no stage could see them.
 *
 * Not both at once: a repository that wrote an AGENTS.md chose it, and pasting CLAUDE.md
 * beside it would double what the two share and hand a stage two voices on the same rule.
 * The block `init` owns — the validation commands — is kept either way, because it is
 * agent-flow's contribution and the fallback text does not carry it.
 */

export type InstructionsSource = 'AGENTS.md' | 'CLAUDE.md' | 'none';

export interface ProjectInstructions {
  readonly source: InstructionsSource;
  readonly text: string;
}

const NONE = 'No AGENTS.md in this repository.';

export async function readProjectInstructions(fs: FileSystem, dir: string): Promise<ProjectInstructions> {
  const agents = await readIfPresent(fs, `${dir}/AGENTS.md`);
  if (agents !== undefined && !isScaffoldOnly(agents)) return { source: 'AGENTS.md', text: agents };

  const claude = await readIfPresent(fs, `${dir}/CLAUDE.md`);
  if (claude !== undefined) {
    const block = agents === undefined ? undefined : agentFlowBlock(agents);
    return {
      source: 'CLAUDE.md',
      text: [
        '<!-- Read from CLAUDE.md: this repository has no AGENTS.md of its own. -->',
        claude.trimEnd(),
        ...(block === undefined ? [] : ['', block]),
        '',
      ].join('\n'),
    };
  }

  return agents === undefined ? { source: 'none', text: NONE } : { source: 'AGENTS.md', text: agents };
}

/** Whether `text` is the `init` scaffold and the agent-flow block, and nothing a person wrote. */
function isScaffoldOnly(text: string): boolean {
  const block = agentFlowBlock(text);
  const outside = block === undefined ? text : text.replace(block, '');
  return normalise(outside) === normalise(AGENTS_MD_SCAFFOLD.join('\n'));
}

function agentFlowBlock(text: string): string | undefined {
  const start = text.indexOf(AGENTS_BEGIN);
  const end = text.indexOf(AGENTS_END);
  return start === -1 || end < start ? undefined : text.slice(start, end + AGENTS_END.length);
}

/** Whitespace and line endings do not make a scaffold someone's rules. */
function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

async function readIfPresent(fs: FileSystem, path: string): Promise<string | undefined> {
  return (await fs.exists(path)) ? fs.readFile(path) : undefined;
}
