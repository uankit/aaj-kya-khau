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
import {
  saveZeptoSearchTask,
  type ZeptoProductOption,
  type ZeptoToolRef,
} from '../tasks/agent-task-store.js';
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

function firstJsonFromMcpResult(r: McpToolResult): unknown | null {
  const candidates: string[] = [];
  if (r.content) {
    for (const block of r.content) {
      if (block.type === 'text' && typeof block.text === 'string') candidates.push(block.text);
      else candidates.push(JSON.stringify(block));
    }
  }
  candidates.push(JSON.stringify(r));

  for (const raw of candidates) {
    const text = raw.trim();
    if (!text) continue;
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        return JSON.parse(text);
      } catch {
        // try next candidate
      }
    }
  }
  return null;
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

function looksLikeProduct(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const keys = new Set(
    Object.keys(value as Record<string, unknown>).map((key) =>
      key.toLowerCase().replace(/[^a-z0-9]/g, ''),
    ),
  );
  return [
    'id',
    'name',
    'title',
    'productid',
    'variantid',
    'productvariantid',
    'storeproductid',
    'skuid',
    'price',
    'sellingprice',
    'mrp',
    'displayname',
    'itemname',
  ].some((key) => keys.has(key));
}

function productListFromArray(value: unknown[]): unknown[] | null {
  const products = value.filter(looksLikeProduct);
  if (products.length > 0) return products;

  for (const item of value) {
    const nested = listFromParsedJson(item);
    if (nested) return nested;
  }

  return null;
}

function listFromParsedJson(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return productListFromArray(parsed);
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  // MCP content blocks often look like { type, text, _meta }. The actual
  // Zepto product payload, when present, lives under _meta; the text is only
  // display prose and cannot safely power add-to-cart.
  const meta = obj._meta ?? obj.meta ?? obj.metadata;
  if (meta && typeof meta === 'object') {
    const nested = listFromParsedJson(meta);
    if (nested) return nested;
  }

  for (const key of ['products', 'items', 'results', 'data', 'productList', 'catalog'] as const) {
    const value = obj[key];
    if (Array.isArray(value)) {
      const products = productListFromArray(value);
      if (products) return products;
    }
    if (value && typeof value === 'object') {
      const nested = listFromParsedJson(value);
      if (nested) return nested;
    }
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const nested = listFromParsedJson(value);
      if (nested) return nested;
    }
  }
  return null;
}

function stringFieldDeep(raw: unknown, keys: string[]): string | undefined {
  const normalized = new Set(keys.map((k) => k.toLowerCase().replace(/[^a-z0-9]/g, '')));
  const seen = new Set<unknown>();
  const stack: unknown[] = [raw];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);

    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      const nk = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normalized.has(nk)) {
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (typeof value === 'number') return String(value);
      }
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return undefined;
}

function optionFromRaw(raw: unknown, idx: number): ZeptoProductOption {
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    return {
      optionNumber: idx + 1,
      title:
        stringFieldDeep(obj, ['name', 'title', 'productName', 'displayName', 'itemName']) ??
        `Option ${idx + 1}`,
      subtitle: stringFieldDeep(obj, ['packSize', 'unit', 'quantity', 'variant', 'weight']),
      price: stringFieldDeep(obj, ['price', 'sellingPrice', 'mrp', 'finalPrice', 'amount']),
      eta: stringFieldDeep(obj, ['eta', 'deliveryEta', 'deliveryTime', 'timeToDeliver']),
      raw,
    };
  }
  return { optionNumber: idx + 1, title: String(raw), raw };
}

function parseProductOptionsFromResult(result: McpToolResult, summary: string): ZeptoProductOption[] {
  const parsed = firstJsonFromMcpResult(result);
  const list = listFromParsedJson(parsed);
  if (list) return list.slice(0, SEARCH_MAX_ITEMS).map(optionFromRaw);
  return parseProductOptionsFromText(summary);
}

function parseProductOptionsFromText(raw: string): ZeptoProductOption[] {
  const trimmed = raw.trim().replace(/\n…\(.+$/, '').replace(/\n…\[truncated .+$/, '');
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const list = listFromParsedJson(parsed);
      if (list) return list.slice(0, SEARCH_MAX_ITEMS).map(optionFromRaw);
    } catch {
      /* fall through */
    }
  }

  const lines = trimmed.split('\n');
  const itemLineRe = /^\s*(?:[•*\-–—]|\d+[.)])\s+(.+)/;
  const items = lines
    .map((line) => line.match(itemLineRe)?.[1]?.trim())
    .filter((line): line is string => !!line)
    .slice(0, SEARCH_MAX_ITEMS);

  return items.map((line, idx) => ({
    optionNumber: idx + 1,
    title: line,
    raw: line,
  }));
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

function isSearchTool(toolName: string): boolean {
  return /search|find|lookup|query/i.test(toolName);
}

function isCartTool(toolName: string): boolean {
  return /cart|basket/i.test(toolName) && /add|create|update|stage/i.test(toolName);
}

function isCheckoutTool(toolName: string): boolean {
  return /checkout|place.?order|create.?order/i.test(toolName);
}

function toolRef(tool: McpTool | undefined): ZeptoToolRef | undefined {
  if (!tool) return undefined;
  return { name: tool.name, inputSchema: tool.inputSchema };
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
    if (!isSearchTool(mt.name)) continue;

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
          const summary = summarizeResult(mt.name, result);
          if (result.isError) {
            return { error: summary };
          }

          const addToCartTool = mcpTools.find((t) => isCartTool(t.name));
          const checkoutTool = mcpTools.find((t) => isCheckoutTool(t.name));
          const productOptions = parseProductOptionsFromResult(result, summary);
          log.info('Zepto search stored workflow options', {
            userId,
            searchTool: mt.name,
            optionCount: productOptions.length,
            addTool: addToCartTool?.name,
            checkoutTool: checkoutTool?.name,
          });
          await saveZeptoSearchTask({
            userId,
            searchTool: mt.name,
            searchArgs: args,
            searchResult: summary,
            productOptions,
            addToCartTool: toolRef(addToCartTool),
            checkoutTool: toolRef(checkoutTool),
          });

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
