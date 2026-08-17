import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  RunnerCapabilities,
  RunnerHealth,
} from '../../src/ports/index.js';
import type { RunnerErrorCode } from '../../src/contracts/index.js';

/**
 * A scripted response, or a function producing one.
 *
 * Allowed to be async because the real port is: a test that needs to observe
 * state *while* a stage is in flight — ordering, partial writes — can only do
 * so from inside the call, and every such observation is a file read.
 */
export type AgentScript = (input: AgentRunInput) => AgentRunResult | Promise<AgentRunResult>;

const DEFAULT_CAPABILITIES: RunnerCapabilities = {
  supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
  supportsReadOnly: true,
  supportsNonInteractive: true,
  supportsWorkingDirectory: true,
  structuredOutputStrategy: 'native',
  nonInteractiveToolGrants: { fileEdit: true, commandExecution: true },
};

/**
 * Scripted AgentRunner — the boundary that makes the whole pipeline testable
 * offline (R-13). Every stage, the scheduler and the fallback decorator are
 * exercised through this rather than a real CLI.
 */
export class FakeAgentRunner implements AgentRunner {
  readonly calls: AgentRunInput[] = [];
  private readonly scripts: AgentScript[] = [];
  private fallbackScript: AgentScript = () => ({ ok: true, text: '', durationMs: 1 });

  constructor(
    readonly id = 'fake',
    private readonly caps: RunnerCapabilities = DEFAULT_CAPABILITIES,
    private health: RunnerHealth = {
      installed: true,
      executable: true,
      auth: 'configured',
    },
  ) {}

  capabilities(): RunnerCapabilities {
    return this.caps;
  }

  async healthCheck(): Promise<RunnerHealth> {
    return this.health;
  }

  setHealth(health: RunnerHealth): this {
    this.health = health;
    return this;
  }

  /** Queues one response, consumed in order. */
  push(result: AgentRunResult | AgentScript): this {
    this.scripts.push(typeof result === 'function' ? result : () => result);
    return this;
  }

  pushText(text: string): this {
    return this.push({ ok: true, text, durationMs: 1 });
  }

  pushJson(json: unknown): this {
    return this.push({ ok: true, text: JSON.stringify(json), json, durationMs: 1 });
  }

  pushFailure(errorCode: RunnerErrorCode, raw = 'scripted failure'): this {
    return this.push({ ok: false, errorCode, raw, durationMs: 1 });
  }

  always(result: AgentRunResult | AgentScript): this {
    this.fallbackScript = typeof result === 'function' ? result : () => result;
    return this;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.calls.push(input);
    return (this.scripts.shift() ?? this.fallbackScript)(input);
  }

  get lastCall(): AgentRunInput | undefined {
    return this.calls.at(-1);
  }
}
