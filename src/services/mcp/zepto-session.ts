/**
 * Warm, ready-to-use Zepto MCP sessions.
 *
 * Zepto's MCP has a quirk: every freshly-initialized session is gated behind
 * a two-call activation ritual — `get_user_details` + `update_user_name` —
 * that MUST complete on the same session before any shopping tool
 * (`list_saved_addresses`, `search_products`, cart, checkout) will work. The
 * gate is session-scoped, not account-scoped: even users who've been
 * registered for years hit it on every fresh session. Account-level
 * registration is a separate concern that `update_user_name` also handles
 * for brand-new accounts.
 *
 * This module owns that complexity. Callers use `callZeptoToolWarm`
 * exactly like the underlying `callZeptoTool`; the warm-up happens
 * transparently the first time a given token's session is used, and gets
 * re-run if the underlying MCP session is evicted.
 *
 * Two invariants this enforces:
 *   1. For a REGISTERED user, we pass their existing Zepto name back into
 *      `update_user_name`. Data no-op. Never fabricate or overwrite.
 *   2. For an UNREGISTERED user, we pass a best-effort "full name" derived
 *      from our onboarding DB (see `buildZeptoFullName`). This does
 *      complete account registration on Zepto's side.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { users } from '../../db/schema.js';
import { createLogger } from '../../utils/logger.js';
import { getValidZeptoAccessToken } from './zepto-account.js';
import {
  callZeptoTool,
  onZeptoSessionEvicted,
  type McpToolResult,
} from './zepto-client.js';

const log = createLogger('zepto-session');

/** Tokens whose MCP session has been through the activation ritual. */
const warmedTokens = new Set<string>();

/** When the low-level client evicts a session, drop our warm-up record too. */
onZeptoSessionEvicted((token) => {
  if (warmedTokens.delete(token)) {
    log.info('warm-up cleared after session eviction');
  }
});

export class ZeptoSessionNotConnectedError extends Error {
  constructor() {
    super('Zepto not connected (no valid token). User should /connect_zepto again.');
    this.name = 'ZeptoSessionNotConnectedError';
  }
}

export class ZeptoWarmUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZeptoWarmUpError';
  }
}

/**
 * Call a Zepto MCP tool on a warmed session. If the token's session hasn't
 * been warmed up yet, runs the activation ritual first. The returned token
 * is exposed so callers (e.g. the workflow) can reuse the same decryption
 * without going back to the DB.
 */
export async function callZeptoToolWarm(
  userId: string,
  toolName: string,
  args: unknown,
): Promise<{ token: string; result: McpToolResult }> {
  const token = await getValidZeptoAccessToken(userId);
  if (!token) throw new ZeptoSessionNotConnectedError();

  if (!warmedTokens.has(token)) {
    await warmUp(userId, token);
  }

  const result = await callZeptoTool(token, toolName, args);
  return { token, result };
}

// ─────────────────────────────────────────────────────────────────────────
// Warm-up ritual
// ─────────────────────────────────────────────────────────────────────────

async function warmUp(userId: string, token: string): Promise<void> {
  // Step 1: get_user_details. Parse current name + isRegistered flag.
  let details: McpToolResult;
  try {
    details = await callZeptoTool(token, 'get_user_details', {});
  } catch (err) {
    throw new ZeptoWarmUpError(
      `get_user_details threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (details.isError) {
    throw new ZeptoWarmUpError(`get_user_details: ${flattenText(details).slice(0, 200)}`);
  }

  const detailsText = flattenText(details);
  const isRegistered = /Registered:\s*Yes/i.test(detailsText);
  const currentName = parseNameFromDetails(detailsText);

  // Step 2: pick the name to send. For registered users we echo their
  // existing Zepto name — it's a data no-op but provides the activation
  // signal Zepto requires per session.
  let nameToSend: string;
  if (isRegistered && currentName) {
    nameToSend = currentName;
  } else {
    const [row] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    nameToSend = buildZeptoFullName(row?.name);
  }

  log.info(
    `warming up session (isRegistered=${isRegistered}, sending name="${nameToSend}")`,
    { userId },
  );

  // Step 3: update_user_name. Dual arg keys — `fullName` is the confirmed
  // real key; `name` kept as cheap defence against future schema changes.
  let updated: McpToolResult;
  try {
    updated = await callZeptoTool(token, 'update_user_name', {
      fullName: nameToSend,
      name: nameToSend,
    });
  } catch (err) {
    throw new ZeptoWarmUpError(
      `update_user_name threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (updated.isError) {
    throw new ZeptoWarmUpError(`update_user_name: ${flattenText(updated).slice(0, 200)}`);
  }

  warmedTokens.add(token);
  log.info('warm-up complete', { userId });
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Extract "Name: <value>" from get_user_details' text payload. Zepto's
 * current response format is multi-line plain text:
 *   User Profile
 *   ------------
 *   Name: Ruchi Matharu
 *   Registered: Yes
 *   ...
 * Returns null if absent or blank.
 */
function parseNameFromDetails(text: string): string | null {
  const m = text.match(/Name:\s*(.+?)\s*$/m);
  if (!m) return null;
  const name = m[1]?.trim();
  return name && name.length > 0 ? name : null;
}

/**
 * Turn whatever we have in `users.name` into a "full name" Zepto will accept
 * for first-time account registration. Zepto's validator rejects blank and
 * single-word names. We never want to block ordering to ask for a last
 * name, so: empty → "Friend User"; single-word → append " User".
 *
 * Only used for UNREGISTERED users — for registered users we echo their
 * existing Zepto name instead.
 */
export function buildZeptoFullName(raw: string | null | undefined): string {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return 'Friend User';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return `${parts[0]} User`;
  return parts.join(' ');
}

function flattenText(r: McpToolResult): string {
  if (!r.content) return '';
  return r.content
    .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .join('\n');
}
