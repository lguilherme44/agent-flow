import {
  RunEventSchema,
  CONTEXT_TELEMETRY_EVENT_TYPE,
  type ContextTelemetryObservation,
  type ContextTelemetryView,
} from '../contracts/index.js';
import {
  aggregateContextTelemetry,
  normalizeContextTelemetryObservation,
} from '../core/context-telemetry.js';
import { runPaths } from '../app/paths.js';
import type { FileSystem } from '../ports/index.js';

export const MAX_CONTEXT_TELEMETRY_EVENT_SCAN = 256;
export const MAX_CONTEXT_TELEMETRY_EVENT_LINE_CHARACTERS = 65_536;
export const CONTEXT_TELEMETRY_BASIS = 'estimated_operational_not_billing' as const;

export type ContextTelemetryReadView = ContextTelemetryView;

export interface ContextTelemetryReaderOptions {
  readonly fs: FileSystem;
  readonly projectDir: string;
}

/** Read-only, bounded projection of context observations from `events.jsonl`. */
export class ContextTelemetryReader {
  constructor(private readonly options: ContextTelemetryReaderOptions) {}

  async read(runId: string): Promise<ContextTelemetryReadView | undefined> {
    if (!/^AF-\d{4}-\d{3}$/.test(runId)) return undefined;
    const path = runPaths(this.options.projectDir, runId).events;
    try {
      if (!(await this.options.fs.exists(path))) return undefined;
      const raw = await this.options.fs.readFile(path);
      const scan = boundedAuditLines(raw, MAX_CONTEXT_TELEMETRY_EVENT_SCAN);
      const events: unknown[] = [];
      for (const line of scan.lines) {
        if (line === undefined) {
          events.push(undefined);
          continue;
        }
        try {
          events.push(JSON.parse(line));
        } catch {
          events.push(undefined);
        }
      }
      return contextTelemetryFromEvents(events, scan.truncated);
    } catch {
      return undefined;
    }
  }
}

/**
 * Pure hostile-input-safe read-model projection. Duplicate observations are
 * retained because two identical calls are two audit facts, not one fact twice.
 */
export function contextTelemetryFromEvents(
  input: unknown,
  alreadyTruncated = false,
): ContextTelemetryReadView | undefined {
  try {
    const scan = snapshotArray(input, MAX_CONTEXT_TELEMETRY_EVENT_SCAN);
    const observations: ContextTelemetryObservation[] = [];

    for (const candidate of scan.items) {
      try {
        const observation = observationOf(candidate);
        if (observation !== undefined) observations.push(observation);
      } catch {
        // A hostile legacy DTO invalidates only its own audit fact.
      }
    }
    const truncated = alreadyTruncated || scan.truncated;
    if (observations.length === 0 && !truncated) return undefined;

    const aggregate =
      observations.length === 0 ? undefined : aggregateContextTelemetry(observations);
    if (observations.length > 0 && aggregate === undefined) return undefined;

    return Object.freeze({
      basis: CONTEXT_TELEMETRY_BASIS,
      scope: Object.freeze({
        eventsScanned: scan.items.length,
        eventLimit: MAX_CONTEXT_TELEMETRY_EVENT_SCAN,
        observations: observations.length,
        truncated,
      }),
      observations: Object.freeze([...observations]),
      ...(aggregate === undefined ? {} : { aggregate }),
    });
  } catch {
    return undefined;
  }
}

function observationOf(input: unknown): ContextTelemetryObservation | undefined {
  const event = exactDataRecord(input, ['at', 'type', 'detail']);
  if (event === undefined || event.type !== CONTEXT_TELEMETRY_EVENT_TYPE) return undefined;

  const parsedEvent = RunEventSchema.safeParse(event);
  if (!parsedEvent.success) return undefined;

  const detail = exactDataRecord(event.detail, ['observation']);
  if (detail === undefined) return undefined;
  return normalizeContextTelemetryObservation(detail.observation);
}

function exactDataRecord(
  input: unknown,
  allowedKeys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (!isPlainRecord(input)) return undefined;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== allowedKeys.length) return undefined;
  const allowed = new Set(allowedKeys);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor)) return undefined;
    result[key] = descriptor.value;
  }
  for (const key of allowedKeys) if (!Object.hasOwn(result, key)) return undefined;
  return Object.freeze(result);
}

function snapshotArray(
  input: unknown,
  limit: number,
): { readonly items: readonly unknown[]; readonly truncated: boolean } {
  if (!Array.isArray(input)) throw new Error('event array required');
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
  if (!lengthDescriptor || !('value' in lengthDescriptor)) throw new Error('invalid event array');
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('invalid event count');

  const count = Math.min(length, limit);
  const items: unknown[] = [];
  for (let index = 0; index < count; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !('value' in descriptor)) {
      items.push(undefined);
      continue;
    }
    items.push(descriptor.value);
  }
  return { items: Object.freeze(items), truncated: length > limit };
}

function boundedAuditLines(
  raw: string,
  limit: number,
): { readonly lines: readonly (string | undefined)[]; readonly truncated: boolean } {
  const lines: (string | undefined)[] = [];
  let start = 0;
  let truncated = false;
  while (start < raw.length) {
    const newline = raw.indexOf('\n', start);
    const end = newline === -1 ? raw.length : newline;
    const rawLength = end - start;
    if (rawLength > 0) {
      if (lines.length === limit) {
        truncated = true;
        break;
      }
      if (rawLength > MAX_CONTEXT_TELEMETRY_EVENT_LINE_CHARACTERS) {
        lines.push(undefined);
      } else {
        const line = raw.slice(start, end).trim();
        if (line.length > 0) lines.push(line);
      }
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  return { lines: Object.freeze(lines), truncated };
}

function isPlainRecord(input: unknown): input is object {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}
