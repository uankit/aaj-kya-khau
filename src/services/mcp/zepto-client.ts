/**
 * Minimal MCP client for Zepto's MCP server.
 *
 * MCP (Model Context Protocol) over HTTP is JSON-RPC 2.0. Zepto exposes a
 * single endpoint `https://mcp.zepto.co.in/mcp` that accepts POSTed JSON-RPC
 * requests. We implement just the two methods the agent needs:
 *
 *   - tools/list  → enumerate available tools
 *   - tools/call  → invoke a named tool with arguments
 *
 * Deliberately NOT using @modelcontextprotocol/sdk: their client is built
 * for stdio/SSE transports, adds session state, and pulls in a lot of deps
 * we don't need for a pure request/response flow.
 */

const MCP_ENDPOINT = 'https://mcp.zepto.co.in/mcp';
const REQUEST_TIMEOUT_MS = 25_000;

/** Shape of a tool as returned by `tools/list`. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  [k: string]: unknown;
}

class ZeptoMcpError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'ZeptoMcpError';
  }
}

let rpcId = 0;

async function rpc<T>(accessToken: string, method: string, params?: unknown): Promise<T> {
  const body = {
    jsonrpc: '2.0',
    id: ++rpcId,
    method,
    ...(params !== undefined ? { params } : {}),
  };

  const res = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ZeptoMcpError(
      `Zepto MCP ${method} failed: ${res.status} ${text.slice(0, 200)}`,
      res.status,
    );
  }

  // MCP can respond with either plain JSON or SSE (`text/event-stream`). For a
  // simple single-response call the JSON form is what Zepto returns.
  const contentType = res.headers.get('content-type') ?? '';
  let data: { result?: T; error?: { code: number; message: string } };
  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) throw new ZeptoMcpError(`Zepto MCP ${method}: empty SSE response`);
    data = JSON.parse(dataLine.slice(5).trim());
  } else {
    data = (await res.json()) as typeof data;
  }

  if (data.error) {
    throw new ZeptoMcpError(`Zepto MCP ${method}: ${data.error.message}`);
  }
  if (data.result === undefined) {
    throw new ZeptoMcpError(`Zepto MCP ${method}: no result`);
  }
  return data.result;
}

/** List all tools the Zepto MCP exposes to this token. */
export async function listZeptoTools(accessToken: string): Promise<McpTool[]> {
  const result = await rpc<{ tools: McpTool[] }>(accessToken, 'tools/list');
  return result.tools ?? [];
}

/** Call a named Zepto MCP tool with arguments. */
export async function callZeptoTool(
  accessToken: string,
  name: string,
  args: unknown,
): Promise<McpToolResult> {
  return rpc<McpToolResult>(accessToken, 'tools/call', {
    name,
    arguments: args ?? {},
  });
}

export function isMcpUnauthorized(err: unknown): boolean {
  return err instanceof ZeptoMcpError && err.status === 401;
}
