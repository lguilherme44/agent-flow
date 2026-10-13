import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { loadFlowGuide, type FlowGuideLoaderDeps } from '../app/flow-guide-loader.js';
import { resolveGuidesDir } from '../app/prompt-paths.js';
import { DEFAULT_FLOW_GUIDE, FLOW_GUIDES } from '../core/flow-guides.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';

/**
 * `agent-flow instructions [guide]` — the operator guides, printed.
 *
 * A renderer over the registry in `core/flow-guides.ts`: it picks a guide, asks the loader
 * for its text and prints it. Read-only, and excluded from the hub's `postAction` for that
 * reason (see `index.ts`).
 */

export interface InstructionsOptions {
  readonly list?: boolean;
}

export interface InstructionsDeps extends FlowGuideLoaderDeps {
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
}

function defaultDeps(): InstructionsDeps {
  return {
    fs: new NodeFileSystem(),
    guidesDir: resolveGuidesDir(),
    write: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
  };
}

export async function runInstructionsCommand(
  key: string | undefined,
  options: InstructionsOptions,
  deps: InstructionsDeps = defaultDeps(),
): Promise<ExitCodeValue> {
  if (options.list === true) {
    deps.write(FLOW_GUIDES.map((guide) => `${guide.key} — ${guide.description}\n`).join(''));
    return ExitCode.OK;
  }

  const outcome = await loadFlowGuide(deps, key ?? DEFAULT_FLOW_GUIDE);
  if (!outcome.ok) {
    deps.writeError(`${outcome.error.message}\n`);
    // An unknown key is a mistake in the request, and so is a guide the installation lacks:
    // neither is fixed by trying again, which is what separates CONFIG from EXECUTION.
    return ExitCode.CONFIG_ERROR;
  }

  let text = `${outcome.value.text.trimEnd()}\n`;
  if (key === undefined) {
    // The overview names the other guides in prose; this line is the exact keys, so a
    // caller that only read the first screen still knows what it can ask for.
    const others = FLOW_GUIDES.filter((guide) => guide.key !== DEFAULT_FLOW_GUIDE).map((g) => g.key);
    text += `\nOther guides: ${others.join(', ')} — run \`agent-flow instructions <guide>\`\n`;
  }
  deps.write(text);
  return ExitCode.OK;
}
