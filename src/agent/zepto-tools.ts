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

let toolsCache: { fetchedAt: number; tools: McpTool[] } | null = null;

async function getCachedZeptoTools(accessToken: string): Promise<McpTool[]> {
  if (toolsCache && Date.now() - toolsCache.fetchedAt < TOOL_CACHE_TTL_MS) {
    return toolsCache.tools;
  }
  const tools = await listZeptoTools(accessToken);
  toolsCache = { fetchedAt: Date.now(), tools };
  log.info(`Loaded ${tools.length} Zepto MCP tools`);
  return tools;
}

/** Pretty-print an MCP tool result for the LLM. */
function summarizeResult(r: McpToolResult): string {
  if (!r.content || r.content.length === 0) {
    return JSON.stringify(r).slice(0, 4000);
  }
  const texts = r.content
    .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : JSON.stringify(c)))
    .join('\n');
  return texts.slice(0, 6000);
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
            return { error: summarizeResult(result) };
          }
          return { result: summarizeResult(result) };
        } catch (err) {
          log.error(`zepto_${mt.name} failed for user ${userId}`, err);
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
  }
  return out;
}
