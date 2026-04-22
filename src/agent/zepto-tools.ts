/**
 * Dynamic Zepto tool builder.
 *
 * At turn-build time, if the user has connected Zepto, we fetch Zepto's MCP
 * `tools/list` (cached globally for 1 hour — tools are identical across
 * users) and register each as a Vercel AI SDK tool with the schema MCP
 * returned. The LLM owns the full ordering flow: search → add-to-cart →
 * checkout. It sees the real MCP schemas, so it builds correct tool args.
 *
 * Two pieces of value-add on top of raw pass-through:
 *   1. Search results are trimmed to top-3 (with product IDs preserved) so
 *      the LLM doesn't drown in 20 products and the tool-loop doesn't blow
 *      its token budget re-sending the result on each step.
 *   2. When a search completes, we persist the trimmed result to
 *      agent_tasks. The next turn (e.g. user says "yes") can read that
 *      context back and the LLM never loses track of product IDs.
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
import {
  completeZeptoOrderTask,
  saveZeptoSearchTask,
} from '../tasks/agent-task-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('zepto-tools');

const TOOL_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_CHARS = 1500;
const SEARCH_MAX_ITEMS = 3;

/** Zepto MCP tools we skip. Not useful for our flow + adds prompt bloat. */
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

function flattenMcpContent(r: McpToolResult): string {
  if (!r.content || r.content.length === 0) return JSON.stringify(r);
  return r.content
    .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : JSON.stringify(c)))
    .join('\n');
}

function isSearchTool(name: string): boolean {
  return /search|find|lookup|query/i.test(name);
}

function isCheckoutTool(name: string): boolean {
  return /checkout|place.?order|create.?order/i.test(name);
}

/**
 * Trim a Zepto search response to the top N products. Preserves structured
 * JSON (and therefore product IDs) when the server returns JSON; falls back
 * to keeping the first N bulleted/numbered lines for prose responses.
 */
function filterSearchResult(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        if (parsed.length <= SEARCH_MAX_ITEMS) return trimmed;
        return (
          JSON.stringify(parsed.slice(0, SEARCH_MAX_ITEMS)) +
          `\n…(${parsed.length - SEARCH_MAX_ITEMS} more hidden)`
        );
      }
      if (parsed && typeof parsed === 'object') {
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
      /* fall through */
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

  return trimmed.length > DEFAULT_MAX_CHARS
    ? trimmed.slice(0, DEFAULT_MAX_CHARS) + `\n…[truncated ${trimmed.length - DEFAULT_MAX_CHARS} chars]`
    : trimmed;
}

function summarizeResult(toolName: string, r: McpToolResult): string {
  const flattened = flattenMcpContent(r);
  if (isSearchTool(toolName)) return filterSearchResult(flattened);
  return flattened.length > DEFAULT_MAX_CHARS
    ? flattened.slice(0, DEFAULT_MAX_CHARS) + `\n…[truncated ${flattened.length - DEFAULT_MAX_CHARS} chars]`
    : flattened;
}

/**
 * Register every Zepto MCP tool as a Vercel AI SDK tool. The LLM decides
 * the flow — we only side-effect on search (save context) and checkout
 * (clear context on success).
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
          return {
            error: 'Zepto account not connected or token expired — user must /connect_zepto again.',
          };
        }
        const argsPreview = JSON.stringify(args).slice(0, 800);
        log.info(`zepto_${mt.name} call`, { userId, args: argsPreview });
        try {
          const result = await callZeptoTool(userToken, mt.name, args);
          const summary = summarizeResult(mt.name, result);

          // Log the response so we can see when Zepto returns success-but-prose-error
          // payloads (e.g. "product_id unavailable") that our code can't detect
          // from isError alone.
          log.info(`zepto_${mt.name} result`, {
            userId,
            isError: !!result.isError,
            responsePreview: summary.slice(0, 800),
          });

          if (result.isError) {
            return { error: summary };
          }

          // Search side-effect: remember the filtered result so the next
          // turn has product IDs handy even though tool_results don't
          // persist in message history.
          if (isSearchTool(mt.name)) {
            try {
              await saveZeptoSearchTask({
                userId,
                searchTool: mt.name,
                searchArgs: args,
                searchResult: summary,
              });
            } catch (err) {
              log.warn('saveZeptoSearchTask failed (non-fatal)', err);
            }
          }

          // Checkout side-effect: clear the pending search so we don't
          // inject stale context into the next unrelated order.
          if (isCheckoutTool(mt.name)) {
            try {
              await completeZeptoOrderTask(userId);
            } catch (err) {
              log.warn('completeZeptoOrderTask failed (non-fatal)', err);
            }
          }

          return { result: summary };
        } catch (err) {
          log.error(`zepto_${mt.name} failed for user ${userId}`, err);
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
  }
  return out;
}
