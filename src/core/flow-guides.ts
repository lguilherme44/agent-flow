/**
 * The operator guides: how to drive agent-flow, one flow per guide (Etapa 1, Passo 2).
 *
 * **One registry, several channels.** The CLI prints these (`agent-flow instructions`);
 * `agent-flow mcp` serves the same entries as the `flow_instructions` tool and as resources.
 * Each channel is an adapter over this list, so a guide added here reaches all of them and
 * no channel can carry a guide the others lack — which is why this is pure data in the core
 * rather than a table inside the CLI.
 *
 * The text is not here. It lives in `guides/<key>.md` beside `prompts/`, shipped in the
 * package, so a guide is edited as prose and reviewed as prose; `app/flow-guide-loader.ts`
 * reads it. This module only says which guides exist and how each one is addressed.
 */

/** How an MCP client addresses a guide: `agent-flow://flows/<key>`. */
const FLOW_GUIDE_URI_PREFIX = 'agent-flow://flows/';

export interface FlowGuideEntry {
  /** What a caller types: `agent-flow instructions <key>`. */
  readonly key: string;
  /** The resource address, derived from the key and never spelled separately. */
  readonly uri: string;
  /** A title, for listings that show one. */
  readonly name: string;
  /** One line: when to read this guide. */
  readonly description: string;
  /** The file under `guides/`, derived from the key. */
  readonly file: string;
}

/** A guide with its text, as every channel hands it out. */
export interface FlowGuide {
  readonly key: string;
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly text: string;
}

export function flowGuideUri(key: string): string {
  return `${FLOW_GUIDE_URI_PREFIX}${key}`;
}

function entry(key: string, name: string, description: string): FlowGuideEntry {
  return { key, uri: flowGuideUri(key), name, description, file: `${key}.md` };
}

/** In reading order: the overview first, then the flows in the order a run meets them. */
export const FLOW_GUIDES: readonly FlowGuideEntry[] = [
  entry(
    'overview',
    'Overview',
    'Start here: what agent-flow is, the pipeline, what only the human decides, which guide to read next',
  ),
  entry(
    'feature',
    'Feature',
    'From a story link to a running run: check the project, start planning, follow progress to the plan gate',
  ),
  entry(
    'gate',
    'Plan gate',
    'Present the plan to the human and record approve, revise or reject in their own words',
  ),
  entry(
    'blocked',
    'Blocked task',
    'A task is BLOCKED or failed: read why, ask the human, then answer, retry or revalidate',
  ),
  entry(
    'recover',
    'Recover',
    'Pause, resume or cancel; a planning stage failed; a task left review_required or interrupted',
  ),
  // Split from `recover` when the e2e observation arrived: the two would not fit one screen
  // (60 lines, `flow-guide-loader.test.ts`), and NOT DONE is its own moment in a run.
  entry(
    'done',
    'NOT DONE',
    'The run is NOT DONE: what each unmet condition means, e2e NOT_RUN and the human observation, review --fix',
  ),
  entry(
    'device-proof',
    'Device proof',
    'e2e cannot reach a device and the backend contract is not deployed: prove it on the device behind a local proxy',
  ),
];

/** What `agent-flow instructions` prints when no guide is named. */
export const DEFAULT_FLOW_GUIDE = 'overview';

export function flowGuideKeys(): string[] {
  return FLOW_GUIDES.map((guide) => guide.key);
}

/** Exact match only: a near miss is an unknown key, not the closest guide. */
export function findFlowGuide(key: string): FlowGuideEntry | undefined {
  return FLOW_GUIDES.find((guide) => guide.key === key);
}
