import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  type McpServer,
} from '@modelcontextprotocol/server';

/**
 * A minimal MCP client for tests: JSON-RPC over the server package's in-memory transport.
 *
 * **Hand-written because the client is a separate package.** `@modelcontextprotocol/server`
 * ships the server, the stdio transport and `InMemoryTransport`, but not `Client` — that is
 * `@modelcontextprotocol/client`. Adding it only for tests would be one more package on a
 * bare machine's `npm ci`; four JSON-RPC methods and the initialize handshake are all these
 * tests use, and speaking them directly also proves the server answers the wire format a
 * real client sends rather than whatever the SDK's own client tolerates.
 */

export interface TestTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface TestToolResult {
  readonly content?: Array<{ type: string; text?: string }>;
  readonly isError?: boolean;
}

export interface TestResourceContent {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
}

export interface McpTestClient {
  listTools(): Promise<{ tools: TestTool[] }>;
  callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<TestToolResult>;
  listResources(): Promise<{ resources: Array<{ uri: string; name: string; mimeType?: string }> }>;
  readResource(request: { uri: string }): Promise<{ contents: TestResourceContent[] }>;
  close(): Promise<void>;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export async function connectTestClient(server: McpServer): Promise<McpTestClient> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, Pending>();
  let nextId = 1;

  clientSide.onmessage = (message) => {
    const reply = message as { id?: number; result?: unknown; error?: { code: number; message: string } };
    if (reply.id === undefined) return;
    const waiting = pending.get(reply.id);
    if (waiting === undefined) return;
    pending.delete(reply.id);
    if (reply.error !== undefined) {
      waiting.reject(new Error(`MCP error ${String(reply.error.code)}: ${reply.error.message}`));
    } else {
      waiting.resolve(reply.result);
    }
  };

  const request = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      void clientSide.send({ jsonrpc: '2.0', id, method, params });
    });
  };

  await server.connect(serverSide);
  await clientSide.start();
  await request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'agent-flow-test', version: '0.0.0' },
  });
  await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    listTools: () => request('tools/list'),
    callTool: ({ name, arguments: args }) => request('tools/call', { name, arguments: args ?? {} }),
    listResources: () => request('resources/list'),
    readResource: ({ uri }) => request('resources/read', { uri }),
    close: () => clientSide.close(),
  };
}
