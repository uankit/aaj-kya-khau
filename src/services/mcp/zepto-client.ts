/**
 * Minimal MCP client for Zepto's MCP server.
 *
 * MCP (Model Context Protocol) over HTTP is JSON-RPC 2.0 with the
 * Streamable HTTP transport. Zepto's server is STATEFUL: every conversation
 * requires an `initialize` handshake, and the server responds with an
 * `Mcp-Session-Id` header that must be echoed on subsequent requests.
 *
 * Wire shape (per session):
 *   1. POST /mcp (initialize)            → response: Mcp-Session-Id header
 *   2. POST /mcp (notifications/initialized)  → no response needed
 *   3. POST /mcp (tools/list, tools/call, …) with Mcp-Session-Id header
 *
 * Sessions are cached per access token. If the server rejects a session
 * (e.g. expired), we re-initialize and retry once.
 */

const MCP_ENDPOINT = 'https://mcp.zepto.co.in/mcp';
const REQUEST_TIMEOUT_MS = 25_000;
const MCP_PROTOCOL_VERSION = '2025-06-18';
const SESSION_TTL_MS = 30 * 60 * 1000;

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

interface SessionEntry {
  sessionId: string;
  initializedAt: number;
}
const sessionCache = new Map<string, SessionEntry>();

function parseResponseBody<T>(
  contentType: string,
  rawText: string,
): { result?: T; error?: { code: number; message: string } } {
  if (contentType.includes('text/event-stream')) {
    // Parse the last `data:` line of the SSE response
    const dataLines = rawText
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    const last = dataLines[dataLines.length - 1];
    if (!last) throw new ZeptoMcpError('Empty SSE response');
    return JSON.parse(last);
  }
  return JSON.parse(rawText);
}

async function initializeSession(accessToken: string): Promise<string> {
  const initBody = {
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'aaj-kya-khaun', version: '0.1.0' },
    },
  };

  const res = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(initBody),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ZeptoMcpError(
      `Zepto MCP initialize failed: ${res.status} ${text.slice(0, 200)}`,
      res.status,
    );
  }

  const sessionId = res.headers.get('mcp-session-id');
  if (!sessionId) {
    throw new ZeptoMcpError('Zepto MCP initialize: server returned no Mcp-Session-Id');
  }

  // Fire-and-forget the initialized notification (no response expected).
  void fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => {
    /* notification delivery is best-effort */
  });

  return sessionId;
}

async function ensureSession(accessToken: string): Promise<string> {
  const entry = sessionCache.get(accessToken);
  if (entry && Date.now() - entry.initializedAt < SESSION_TTL_MS) {
    return entry.sessionId;
  }
  const sessionId = await initializeSession(accessToken);
  sessionCache.set(accessToken, { sessionId, initializedAt: Date.now() });
  return sessionId;
}

function invalidateSession(accessToken: string): void {
  sessionCache.delete(accessToken);
}

async function rpcOnce<T>(
  accessToken: string,
  sessionId: string,
  method: string,
  params?: unknown,
): Promise<T> {
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
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const rawText = await res.text();

  if (!res.ok) {
    // Surface the status so the caller can decide whether to re-init the session
    throw new ZeptoMcpError(
      `Zepto MCP ${method} failed: ${res.status} ${rawText.slice(0, 200)}`,
      res.status,
    );
  }

  const contentType = res.headers.get('content-type') ?? '';
  const data = parseResponseBody<T>(contentType, rawText);

  if (data.error) {
    throw new ZeptoMcpError(`Zepto MCP ${method}: ${data.error.message}`);
  }
  if (data.result === undefined) {
    throw new ZeptoMcpError(`Zepto MCP ${method}: no result`);
  }
  return data.result;
}

/**
 * Call an MCP method. Transparently handles session init + one retry if the
 * server rejects the cached session (expired / evicted server-side).
 */
async function rpc<T>(accessToken: string, method: string, params?: unknown): Promise<T> {
  let sessionId = await ensureSession(accessToken);
  try {
    return await rpcOnce<T>(accessToken, sessionId, method, params);
  } catch (err) {
    if (
      err instanceof ZeptoMcpError &&
      (err.status === 400 || err.status === 404) &&
      /session/i.test(err.message)
    ) {
      // Server rejected our session — re-init once and retry
      invalidateSession(accessToken);
      sessionId = await ensureSession(accessToken);
      return await rpcOnce<T>(accessToken, sessionId, method, params);
    }
    throw err;
  }
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
