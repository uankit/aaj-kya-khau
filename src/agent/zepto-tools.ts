/**
 * Dynamic Zepto tool builder.
 *
 * At turn-build time, if the user has a Zepto account connected, we:
 *   1. Fetch Zepto's MCP `tools/list` (cached globally for 1 hour — tools are
 *      identical across users).
 *   2. Convert each MCP tool into a Vercel AI SDK `tool()` definition, using
 *      the tool's JSON schema directly (via the `jsonSchema()` helper so we
 *      don't have to hand-write Zod schemas for every Zepto endpoint).
 *   3. Wrap each execute() so it fetches a FRESH token at call time (handles
 *      refresh) and calls the MCP.
 *
 * If Zepto's MCP is unreachable, we log + skip — the agent still works,
 * just without Zepto tools that turn.
 */

import { jsonSchema, tool, type Tool } from 'ai';
import {
  getValidZeptoAccessToken,
  hasZeptoConnected,
} from '../services/mcp/zepto-account.js';
import {
  callZeptoTool,
  listZeptoTools,
  type McpTool,
  type McpToolResult,
} from '../services/mcp/zepto-client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('zepto-tools');

const TOOL_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Zepto MCP tools we intentionally skip. Reasons per entry:
 *   - get_user_preferences: Zepto's search is already server-side personalized,
 *     and calling this adds a full RPC round-trip + a tool-result payload that
 *     gets re-sent with every subsequent step in the turn. Dropping saves
 *     ~1k tokens per ordering turn.
 */
const EXCLUDED_TOOLS: ReadonlySet<string> = new Set(['get_user_preferences']);

let toolsCache: { fetchedAt: number; tools: McpTool[] } | null = null;

async function getCachedZeptoTools(accessToken: string): Promise<McpTool[]> {
  if (toolsCache && Date.now() - toolsCache.fetchedAt < TOOL_CACHE_TTL_MS) {
    return toolsCache.tools;
  }
  const all = await listZeptoTools(accessToken);
  const tools = all.filter((t) => !EXCLUDED_TOOLS.has(t.name));
  toolsCache = { fetchedAt: Date.now(), tools };
  log.info(
    `Loaded ${tools.length} Zepto MCP tools (filtered ${all.length - tools.length})`,
  );
  return tools;
}

const DEFAULT_MAX_CHARS = 1500;
const SEARCH_MAX_ITEMS = 3;

/** Flatten MCP content blocks into a single string (text or JSON fallback). */
function flattenMcpContent(r: McpToolResult): string {
  if (!r.content || r.content.length === 0) return JSON.stringify(r);
  return r.content
    .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : JSON.stringify(c)))
    .join('\n');
}

/**
 * Filter a Zepto search response down to the top N most-relevant products.
 *
 * Zepto's product catalog search can return 10-20 items. The LLM only needs
 * 3 to present to the user, and the AI SDK re-sends the full tool result
 * with every subsequent tool step in the same turn — so trimming here cuts
 * token usage multiplicatively.
 *
 * We handle two common response shapes:
 *  - Bulleted / numbered prose list in content[].text  → keep first N items
 *  - JSON array or { products: [...] }                 → slice to first N
 *
 * On unrecognized shapes we fall back to a plain character cap.
 */
function filterSearchResult(raw: string): string {
  const trimmed = raw.trim();

  // JSON path
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        if (parsed.length <= SEARCH_MAX_ITEMS) return trimmed;
        const kept = parsed.slice(0, SEARCH_MAX_ITEMS);
        return (
          JSON.stringify(kept) + `\n…(${parsed.length - SEARCH_MAX_ITEMS} more options hidden)`
        );
      }
      if (parsed && typeof parsed === 'object') {
        // Look for common "list" keys
        for (const key of ['products', 'items', 'results', 'data'] as const) {
          const val = (parsed as Record<string, unknown>)[key];
          if (Array.isArray(val) && val.length > SEARCH_MAX_ITEMS) {
            const reduced = { ...parsed, [key]: val.slice(0, SEARCH_MAX_ITEMS) };
            return (
              JSON.stringify(reduced) +
              `\n…(${val.length - SEARCH_MAX_ITEMS} more ${key} hidden)`
            );
          }
        }
      }
    } catch {
      /* fall through to line-based heuristic */
    }
  }

  // Bulleted / numbered list heuristic
  const lines = trimmed.split('\n');
  const itemLineRe = /^\s*(?:[•*\-–—]|\d+[.)])\s+/;
  const itemIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (itemLineRe.test(lines[i]!)) itemIdxs.push(i);
  }
  if (itemIdxs.length > SEARCH_MAX_ITEMS) {
    const firstItem = itemIdxs[0]!;
    const lastKeptStart = itemIdxs[SEARCH_MAX_ITEMS]!;
    const preamble = lines.slice(0, firstItem).join('\n').trim();
    const keptItems = lines.slice(firstItem, lastKeptStart).join('\n').trim();
    const dropped = itemIdxs.length - SEARCH_MAX_ITEMS;
    return [preamble, keptItems, `…(${dropped} more options hidden)`].filter(Boolean).join('\n');
  }

  // Unstructured — just cap length
  return trimmed.length > DEFAULT_MAX_CHARS
    ? trimmed.slice(0, DEFAULT_MAX_CHARS) + `\n…[truncated ${trimmed.length - DEFAULT_MAX_CHARS} chars]`
    : trimmed;
}

/**
 * Summarize any Zepto MCP tool result for the LLM.
 *
 * Strategy:
 *  - If the tool is a search, parse + filter to top-N (aggressive trim).
 *  - Otherwise: flatten to text and apply a conservative character cap.
 * Never blows past ~1500 chars to keep multi-step tool-loop token budgets
 * predictable.
 */
function summarizeResult(toolName: string, r: McpToolResult): string {
  const flattened = flattenMcpContent(r);
  const isSearch = /search|find|lookup|query/i.test(toolName);
  if (isSearch) return filterSearchResult(flattened);
  return flattened.length > DEFAULT_MAX_CHARS
    ? flattened.slice(0, DEFAULT_MAX_CHARS) + `\n…[truncated ${flattened.length - DEFAULT_MAX_CHARS} chars]`
    : flattened;
}

/**
 * Returns an object of tool definitions keyed by `zepto_<mcpToolName>`.
 * Returns {} if the user hasn't connected Zepto or if the MCP is unreachable.
 */
export async function buildZeptoTools(userId: string): Promise<Record<string, Tool>> {
  if (!(await hasZeptoConnected(userId))) return {};

  const token = await getValidZeptoAccessToken(userId);
  if (!token) return {};

  let mcpTools: McpTool[];
  try {
    mcpTools = await getCachedZeptoTools(token);
  } catch (err) {
    log.warn('Failed to load Zepto MCP tools; skipping this turn', err);
    return {};
  }

  const out: Record<string, Tool> = {};
  for (const mt of mcpTools) {
    const agentName = `zepto_${mt.name}`;
    out[agentName] = tool({
      description: mt.description ?? `Zepto MCP tool: ${mt.name}`,
      parameters: jsonSchema(mt.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (args) => {
        const userToken = await getValidZeptoAccessToken(userId);
        if (!userToken) {
          return { error: 'Zepto account not connected or token expired — user must /connect_zepto again.' };
        }
        try {
          const result = await callZeptoTool(userToken, mt.name, args);
          if (result.isError) {
            return { error: summarizeResult(mt.name, result) };
          }
          return { result: summarizeResult(mt.name, result) };
        } catch (err) {
          log.error(`zepto_${mt.name} failed for user ${userId}`, err);
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
  }
  return out;
}
