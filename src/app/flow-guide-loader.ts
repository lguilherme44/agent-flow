import { findFlowGuide, flowGuideKeys, type FlowGuide } from '../core/flow-guides.js';
import type { FileSystem } from '../ports/index.js';

/**
 * Reads a guide's text from the shipped `guides/` directory.
 *
 * Takes the `FileSystem` port rather than reading the disk itself, for the reason
 * `PromptLoader` does: the CLI and the MCP server hand it the real one, and a test hands it
 * an in-memory one.
 */

export interface FlowGuideLoaderDeps {
  readonly fs: FileSystem;
  /** Where the shipped guides live, resolved by the caller (`resolveGuidesDir`). */
  readonly guidesDir: string;
}

export interface FlowGuideError {
  /**
   * `unknown_guide` is the caller's mistake; `guide_missing` is the installation's — the
   * registry names a guide the package did not ship. Separate because the second is never
   * fixed by asking for a different key.
   */
  readonly code: 'unknown_guide' | 'guide_missing';
  readonly message: string;
  readonly validKeys: string[];
}

export type FlowGuideOutcome =
  | { readonly ok: true; readonly value: FlowGuide }
  | { readonly ok: false; readonly error: FlowGuideError };

export async function loadFlowGuide(
  deps: FlowGuideLoaderDeps,
  key: string,
): Promise<FlowGuideOutcome> {
  const validKeys = flowGuideKeys();
  const entry = findFlowGuide(key);

  if (entry === undefined) {
    return {
      ok: false,
      error: {
        code: 'unknown_guide',
        message: `Unknown guide "${key}". Valid guides: ${validKeys.join(', ')}`,
        validKeys,
      },
    };
  }

  const path = `${deps.guidesDir}/${entry.file}`;
  if (!(await deps.fs.exists(path))) {
    return {
      ok: false,
      error: {
        code: 'guide_missing',
        message: `Guide "${key}" is registered but not installed (looked for ${path}).`,
        validKeys,
      },
    };
  }

  const { file: _file, ...fields } = entry;
  return { ok: true, value: { ...fields, text: await deps.fs.readFile(path) } };
}
