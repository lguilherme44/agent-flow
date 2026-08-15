import type {
  UtilityModel,
  UtilityModelCapabilities,
  UtilityModelHealth,
  UtilityModelInput,
  UtilityModelResult,
} from '../../src/ports/index.js';
import type { UtilityModelErrorCode } from '../../src/ports/index.js';

/**
 * A scripted response, or a function producing one.
 *
 * Allowed to be async for the same reason as in FakeAgentRunner: a test that
 * needs to observe state *while* a run is in flight can only do so from inside
 * the call.
 */
export type UtilityModelScript =
  | UtilityModelResult
  | ((input: UtilityModelInput) => UtilityModelResult | Promise<UtilityModelResult>);

const DEFAULT_CAPABILITIES: UtilityModelCapabilities = {
  contextWindow: 32_768,
  structuredOutput: true,
  tools: false,
  streaming: false,
};

const DEFAULT_SUCCESS: UtilityModelResult = {
  ok: true,
  text: '',
};

/**
 * Scripted UtilityModel — the offline test double for M3-01 and later.
 *
 * Design objectives:
 * - Deterministic: no network, no timers, no randomness.
 * - Configurable: health, capabilities, and result can all be set at
 *   construction time or at runtime via setters.
 * - Observable: every input the model receives is recorded in `calls`.
 * - Simple: not a second production implementation — just enough to let the
 *   unit and architecture tests exercise the port shape.
 */
export class FakeUtilityModel implements UtilityModel {
  readonly calls: UtilityModelInput[] = [];
  private readonly scripts: Array<
    (input: UtilityModelInput) => UtilityModelResult | Promise<UtilityModelResult>
  > = [];
  private fallbackScript: (input: UtilityModelInput) => UtilityModelResult | Promise<UtilityModelResult> = () =>
    DEFAULT_SUCCESS;

  constructor(
    readonly id = 'fake-utility-model',
    private readonly caps: UtilityModelCapabilities = DEFAULT_CAPABILITIES,
    private health: UtilityModelHealth = { status: 'available' },
  ) {}

  // ─── Configuration ───────────────────────────────────────────────────────

  setHealth(health: UtilityModelHealth): this {
    this.health = health;
    return this;
  }

  /** Queues one scripted response, consumed in order. */
  push(result: UtilityModelScript): this {
    this.scripts.push(typeof result === 'function' ? result : () => result);
    return this;
  }

  pushText(text: string): this {
    return this.push({ ok: true, text });
  }

  pushStructured(text: string, structured: unknown): this {
    return this.push({ ok: true, text, structured });
  }

  pushFailure(errorCode: UtilityModelErrorCode, message = 'scripted failure'): this {
    return this.push({ ok: false, errorCode, message });
  }

  /** Sets the fallback response used when the queue is exhausted. */
  always(result: UtilityModelScript): this {
    this.fallbackScript =
      typeof result === 'function' ? result : () => result;
    return this;
  }

  // ─── UtilityModel interface ───────────────────────────────────────────────

  capabilities(): UtilityModelCapabilities {
    return this.caps;
  }

  async healthCheck(): Promise<UtilityModelHealth> {
    return this.health;
  }

  async run(input: UtilityModelInput): Promise<UtilityModelResult> {
    this.calls.push(input);
    const script = this.scripts.shift() ?? this.fallbackScript;
    return script(input);
  }

  // ─── Inspection helpers ──────────────────────────────────────────────────

  get lastCall(): UtilityModelInput | undefined {
    return this.calls.at(-1);
  }

  get callCount(): number {
    return this.calls.length;
  }
}
