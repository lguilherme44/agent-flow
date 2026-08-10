import { createHash } from 'node:crypto';
import type { PromptContentView, PromptView } from '../contracts/index.js';
import { PromptLoader } from '../app/prompt-loader.js';
import { ROLES_BY_PROMPT, STAGES_BY_PROMPT } from '../app/role-routes.js';
import type { FileSystem } from '../ports/index.js';

/**
 * The shipped prompts, as read-only assets (§83, UI-24).
 *
 * Two rules shape this file.
 *
 * **No path arrives from the client.** The set of prompts is whatever `.md` files
 * this installation ships, discovered by listing the prompts directory the loader
 * already resolves from its own module location. A request names one of those, and
 * a name that is not in the set is a 404 — so there is no traversal to attempt,
 * and no need to get normalisation right on three platforms.
 *
 * **No version is invented.** Prompts declare no version in their front matter,
 * and adding one would be metadata nothing enforces and nothing consults, which
 * `PromptMetaSchema` already argues is worse than absent. The digest of the file's
 * bytes is reported instead: it changes when the prompt changes, which is the one
 * thing a version number is actually wanted for, and it cannot be forgotten on the
 * way past.
 */

/** How much prompt text the API will hand over. Generous; prompts are small. */
export const MAX_PROMPT_BYTES = 256 * 1024;

/** Names the browser may ask for. Anything else is not a prompt of ours. */
const PROMPT_FILE = /^([a-z][a-z0-9-]{0,63})\.md$/;

export interface PromptReaderOptions {
  readonly fs: FileSystem;
  /** Where the shipped prompts live, resolved by the caller. */
  readonly promptsDir: string;
}

export class PromptReader {
  private readonly loader: PromptLoader;

  constructor(private readonly options: PromptReaderOptions) {
    this.loader = new PromptLoader({ fs: options.fs, promptsDir: options.promptsDir });
  }

  async list(): Promise<PromptView[]> {
    const names = await this.names();

    const views: PromptView[] = [];
    for (const name of names) {
      const view = await this.describe(name);
      if (view !== null) views.push(view);
    }

    return views;
  }

  async read(name: string): Promise<PromptContentView | null> {
    const view = await this.describe(name);
    if (view === null) return null;

    const raw = await this.options.fs.readFile(this.pathOf(name));
    const truncated = Buffer.byteLength(raw, 'utf8') > MAX_PROMPT_BYTES;

    return {
      ...view,
      content: truncated ? raw.slice(0, MAX_PROMPT_BYTES) : raw,
      truncated,
    };
  }

  /** The prompt names this installation ships, sorted. */
  private async names(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await this.options.fs.readDir(this.options.promptsDir);
    } catch {
      // A packaging problem, not a request problem: an empty list is what the
      // page should show, and it says "no prompts found" rather than failing.
      return [];
    }

    return entries
      .map((entry) => PROMPT_FILE.exec(entry)?.[1])
      .filter((name): name is string => name !== undefined)
      .sort();
  }

  private async describe(name: string): Promise<PromptView | null> {
    // Checked against the discovered set rather than against the filesystem, so
    // a name that passed the schema but is not one of ours cannot reach a path.
    if (!(await this.names()).includes(name)) return null;

    const path = this.pathOf(name);
    const stat = await this.options.fs.stat(path);
    if (stat === null || stat.isDirectory) return null;

    const raw = await this.options.fs.readFile(path);

    const base = {
      name,
      // Relative, so the response says which prompt this is without saying where
      // the tool happens to be installed.
      source: `prompts/${name}.md`,
      sizeBytes: stat.size,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      digest: createHash('sha256').update(raw).digest('hex').slice(0, 12),
      roles: [...(ROLES_BY_PROMPT[name] ?? [])],
      stages: [...(STAGES_BY_PROMPT[name] ?? [])],
    };

    try {
      const prompt = await this.loader.load(name);
      return {
        ...base,
        permissions: prompt.meta.permissions,
        outputFormat: prompt.meta.outputFormat,
        requiredVars: [...prompt.meta.requiredVars],
        nativeStructuredOutput: prompt.meta.nativeStructuredOutput,
      };
    } catch (error) {
      // A prompt whose front matter will not parse still belongs on the page —
      // beside the reason, which is the only place anybody would look for it.
      return {
        ...base,
        permissions: 'unknown',
        outputFormat: 'unknown',
        requiredVars: [],
        nativeStructuredOutput: false,
        error: error instanceof Error ? error.message : 'the front matter could not be read',
      };
    }
  }

  private pathOf(name: string): string {
    return `${this.options.promptsDir}/${name}.md`;
  }
}
