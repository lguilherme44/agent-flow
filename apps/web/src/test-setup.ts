import '@testing-library/jest-dom/vitest';

/**
 * jsdom has no `EventSource`, and the shell opens one on mount.
 *
 * Stubbed rather than mocked away, so components render the same code path they
 * do in a browser — including the connection indicator, which is part of what
 * the tests assert.
 */
class StubEventSource {
  static readonly instances: StubEventSource[] = [];

  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;

  private readonly listeners = new Map<string, ((event: Event) => void)[]>();

  constructor(readonly url: string) {
    StubEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry !== listener),
    );
  }

  /** Test helper: deliver a named event exactly as the server would. */
  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(): void {
    this.listeners.clear();
  }
}

Object.defineProperty(globalThis, 'EventSource', {
  writable: true,
  configurable: true,
  value: StubEventSource,
});

export { StubEventSource };

/**
 * jsdom has no layout, so `matchMedia` is absent.
 *
 * Reported as matching, which puts the unit suite on the wide layout: the
 * inspector sits beside the table, as it does at the 1440 and 1280 targets. The
 * drawer below 1200 is a layout the browser decides, and it is covered where
 * layout is real — in the visual suite.
 */
Object.defineProperty(globalThis, 'matchMedia', {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

/** Recharts measures its container; jsdom reports zero and renders nothing. */
Object.defineProperty(globalThis.HTMLElement.prototype, 'getBoundingClientRect', {
  writable: true,
  configurable: true,
  value(): DOMRect {
    return {
      width: 240,
      height: 160,
      top: 0,
      left: 0,
      bottom: 160,
      right: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  },
});

globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
