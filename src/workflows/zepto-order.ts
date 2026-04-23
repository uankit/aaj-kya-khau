/**
 * Zepto order workflow — deterministic state machine for the ordering flow.
 *
 * The LLM-owns-the-full-flow approach was unreliable for real-money actions:
 * wrong deviceId (hallucinated from history), wrong sequencing (skipping
 * address selection), variable arg shapes. Every failure cost the user a
 * turn and us tokens.
 *
 * This module replaces that with an explicit state machine. Each phase is
 * a pure function over state + user input. The LLM is used ONLY for:
 *   1. Intent classification + order-query extraction (upstream in agent.ts)
 *   2. Phrasing the outgoing reply text (optional — we default to
 *      deterministic templates and the replies still sound natural)
 *
 * State persists in agent_tasks so the workflow survives across Telegram
 * turns. Every phase transition logs entry + exit + errors with structured
 * attribution for easy post-mortem.
 *
 * Phases:
 *   new → ensure_address → search → await_choice → await_confirm
 *     → placing → completed
 *                ↓
 *              failed / cancelled
 */

import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { agentTasks, users, type AgentTask } from '../db/schema.js';
import { getValidZeptoAccessToken } from '../services/mcp/zepto-account.js';
import {
  callZeptoTool,
  type McpToolResult,
} from '../services/mcp/zepto-client.js';
import { createLogger } from '../utils/logger.js';
import { escapeHtml } from '../utils/html.js';

const log = createLogger('zepto-workflow');

// ─────────────────────────────────────────────────────────────────────────
// State + types
// ─────────────────────────────────────────────────────────────────────────

export type Phase =
  | 'new'
  | 'ensure_address'
  | 'search'
  | 'await_choice'
  | 'await_confirm'
  | 'placing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ProductOption {
  optionNumber: number;
  name: string;
  packSize: string;
  pricePaise: number;
  productVariantId: string;
  storeProductId: string;
  cartProductId: string | null;
}

export interface Address {
  id: string;
  label: string;
}

export interface PhaseTrace {
  phase: Phase;
  action: string;
  at: string;
  ms?: number;
}

export interface PhaseError {
  phase: Phase;
  code: string;
  message: string;
  at: string;
}

export interface ZeptoOrderState {
  kind: 'zepto_order_v2';
  phase: Phase;
  query?: string;
  address?: Address;
  products?: ProductOption[];
  selected?: ProductOption;
  cartKey?: string;
  order?: { id?: string; rawResult?: string; placedAt: string };
  errors: PhaseError[];
  trace: PhaseTrace[];
  updatedAt: string;
}

export interface WorkflowReply {
  text: string;
  /** If true, the caller should end the workflow after responding. */
  finished?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────

const WORKFLOW_TTL_MS = 30 * 60 * 1000;
const ACTIVE_STATUSES = ['active', 'waiting_user'] as const;

function expiresAt(): Date {
  return new Date(Date.now() + WORKFLOW_TTL_MS);
}

function isWorkflowState(s: unknown): s is ZeptoOrderState {
  return typeof s === 'object' && s !== null
    && (s as { kind?: unknown }).kind === 'zepto_order_v2';
}

async function loadState(userId: string): Promise<{ task: AgentTask; state: ZeptoOrderState } | null> {
  const [task] = await db
    .select()
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.userId, userId),
        eq(agentTasks.type, 'zepto_order'),
        inArray(agentTasks.status, [...ACTIVE_STATUSES]),
        gt(agentTasks.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(agentTasks.updatedAt))
    .limit(1);
  if (!task || !isWorkflowState(task.state)) return null;
  return { task, state: task.state };
}

async function saveState(
  userId: string,
  state: ZeptoOrderState,
  existing?: AgentTask,
): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const mappedStatus = state.phase === 'completed' || state.phase === 'cancelled' || state.phase === 'failed'
    ? state.phase === 'completed' ? 'completed' : state.phase === 'cancelled' ? 'cancelled' : 'failed'
    : 'waiting_user';

  if (existing) {
    await db
      .update(agentTasks)
      .set({
        status: mappedStatus,
        state,
        expiresAt: mappedStatus === 'waiting_user' ? expiresAt() : existing.expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(agentTasks.id, existing.id));
    return;
  }
  await db.insert(agentTasks).values({
    userId,
    type: 'zepto_order',
    status: mappedStatus,
    state,
    expiresAt: expiresAt(),
  });
}

function blankState(): ZeptoOrderState {
  return {
    kind: 'zepto_order_v2',
    phase: 'new',
    errors: [],
    trace: [],
    updatedAt: new Date().toISOString(),
  };
}

function recordTrace(state: ZeptoOrderState, phase: Phase, action: string, ms?: number): void {
  state.trace.push({ phase, action, at: new Date().toISOString(), ms });
  // Keep trace bounded
  if (state.trace.length > 40) state.trace.splice(0, state.trace.length - 40);
}

function recordError(state: ZeptoOrderState, phase: Phase, code: string, message: string): void {
  state.errors.push({ phase, code, message: message.slice(0, 500), at: new Date().toISOString() });
  log.warn(`[phase=${phase}] error ${code}: ${message}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Typed MCP wrappers. Each one knows exactly which Zepto tool to call,
// what args to send, and how to parse the response.
// ─────────────────────────────────────────────────────────────────────────

const CART_DEVICE_ID_PREFIX = 'aaj-kya-khaun-';

function deviceIdFor(userId: string): string {
  return `${CART_DEVICE_ID_PREFIX}${userId}`;
}

async function mcp<T>(
  userId: string,
  toolName: string,
  args: unknown,
): Promise<{ ok: true; result: McpToolResult; structured: T | null } | { ok: false; error: string }> {
  const token = await getValidZeptoAccessToken(userId);
  if (!token) return { ok: false, error: 'Zepto not connected (no valid token). User should /connect_zepto again.' };

  const started = Date.now();
  log.info(`mcp call: ${toolName}`, { userId, args });
  try {
    let result = await callZeptoTool(token, toolName, args);

    // Self-heal: Zepto's MCP requires a one-time registration handshake
    // (get_user_details → update_user_name) before any other tool works.
    // Brand-new OAuth tokens hit this on their very first call. Detect the
    // server's error message, run the handshake, retry once.
    if (result.isError && /registration required/i.test(flattenText(result))) {
      log.info(`mcp ${toolName}: server says registration required — auto-registering`, { userId });
      const reg = await registerZeptoSession(userId, token);
      if (!reg.ok) {
        log.warn(`Zepto auto-registration failed`, { userId, error: reg.error });
        return { ok: false, error: `Zepto registration failed: ${reg.error}` };
      }
      log.info(`Zepto registration complete — retrying ${toolName}`, { userId });
      result = await callZeptoTool(token, toolName, args);
    }

    const ms = Date.now() - started;

    if (result.isError) {
      const body = flattenText(result);
      log.warn(`mcp ${toolName} returned isError:true`, { userId, ms, body: body.slice(0, 600) });
      return { ok: false, error: body.slice(0, 500) };
    }

    const structured = extractStructured<T>(result);
    log.info(`mcp ${toolName} ok`, { userId, ms, hasStructured: structured !== null });
    return { ok: true, result, structured };
  } catch (err) {
    const ms = Date.now() - started;
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`mcp ${toolName} threw after ${ms}ms`, err);
    return { ok: false, error: msg };
  }
}

/**
 * One-time Zepto MCP registration handshake. Zepto's server requires this
 * exact call order on first use of a newly-issued OAuth token:
 *   1. get_user_details — probably returns the bound profile stub
 *   2. update_user_name — commits a display name, completes registration
 * Only after these succeed do other tools (list_saved_addresses, search,
 * cart, checkout) become callable on that session.
 */
async function registerZeptoSession(
  userId: string,
  token: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const details = await callZeptoTool(token, 'get_user_details', {});
    if (details.isError) {
      return { ok: false, error: `get_user_details: ${flattenText(details).slice(0, 200)}` };
    }
  } catch (err) {
    return { ok: false, error: `get_user_details threw: ${err instanceof Error ? err.message : String(err)}` };
  }

  const [row] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  const name = row?.name?.trim() || 'User';

  try {
    const updated = await callZeptoTool(token, 'update_user_name', { name });
    if (updated.isError) {
      return { ok: false, error: `update_user_name: ${flattenText(updated).slice(0, 200)}` };
    }
  } catch (err) {
    return { ok: false, error: `update_user_name threw: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { ok: true };
}

function flattenText(r: McpToolResult): string {
  if (!r.content) return '';
  return r.content
    .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .join('\n');
}

function extractStructured<T>(r: McpToolResult): T | null {
  const top = (r as { structuredContent?: unknown }).structuredContent;
  if (top !== undefined && top !== null) return top as T;
  if (r.content) {
    for (const block of r.content) {
      const meta = (block as { _meta?: unknown })._meta;
      if (meta && typeof meta === 'object') return meta as T;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase: ENSURE_ADDRESS
// ─────────────────────────────────────────────────────────────────────────

interface SavedAddressListResp {
  addresses?: Array<{ id: string; label?: string; isDefault?: boolean; addressLine?: string }>;
}

async function ensureAddress(userId: string, state: ZeptoOrderState): Promise<{ ok: boolean; reply?: string }> {
  if (state.address?.id) return { ok: true };

  const listed = await mcp<SavedAddressListResp>(userId, 'list_saved_addresses', {});
  if (!listed.ok) {
    recordError(state, 'ensure_address', 'list_failed', listed.error);
    return { ok: false, reply: `Couldn't load your saved Zepto addresses — ${escapeHtml(listed.error)}` };
  }

  const addresses = listed.structured?.addresses ?? [];
  if (addresses.length === 0) {
    recordError(state, 'ensure_address', 'no_address', 'User has no saved addresses');
    return {
      ok: false,
      reply: 'You have no saved delivery address on Zepto. Open the Zepto app and add one, then try again 🙏',
    };
  }

  const chosen = addresses.find((a) => a.isDefault) ?? addresses[0]!;
  const selected = await mcp(userId, 'select_saved_address', { addressId: chosen.id });
  if (!selected.ok) {
    recordError(state, 'ensure_address', 'select_failed', selected.error);
    return { ok: false, reply: `Couldn't select your address on Zepto — ${escapeHtml(selected.error)}` };
  }

  state.address = {
    id: chosen.id,
    label: chosen.label ?? chosen.addressLine ?? 'Your saved Zepto address',
  };
  recordTrace(state, 'ensure_address', `selected address ${chosen.id}`);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────
// Phase: SEARCH
// ─────────────────────────────────────────────────────────────────────────

interface SearchResp {
  products?: Array<{
    id?: string;
    productVariantId?: string;
    storeProductId?: string;
    cartProductId?: string | null;
    name?: string;
    price?: number;
    packSize?: string;
    variantId?: string;
  }>;
}

const MAX_OPTIONS = 3;

async function runSearch(userId: string, state: ZeptoOrderState, query: string): Promise<{ ok: boolean; reply?: string }> {
  state.query = query;
  const searched = await mcp<SearchResp>(userId, 'search_products', { query });
  if (!searched.ok) {
    recordError(state, 'search', 'search_failed', searched.error);
    return { ok: false, reply: `Zepto search failed: ${escapeHtml(searched.error)}` };
  }

  const products = searched.structured?.products ?? [];
  if (products.length === 0) {
    recordError(state, 'search', 'empty_results', `No products for "${query}"`);
    return {
      ok: false,
      reply: `Zepto returned no products for <b>${escapeHtml(query)}</b>. If this is something common like bread, your delivery address might not be serviced — check the Zepto app.`,
    };
  }

  const options: ProductOption[] = products.slice(0, MAX_OPTIONS).map((p, idx) => ({
    optionNumber: idx + 1,
    name: p.name ?? 'Unknown product',
    packSize: p.packSize ?? '',
    pricePaise: typeof p.price === 'number' ? p.price : 0,
    productVariantId: p.productVariantId ?? p.id ?? p.variantId ?? '',
    storeProductId: p.storeProductId ?? '',
    cartProductId: p.cartProductId ?? null,
  }));

  // Drop options missing IDs — they're not orderable
  const orderable = options.filter((o) => o.productVariantId && o.storeProductId);
  if (orderable.length === 0) {
    recordError(state, 'search', 'no_ids', 'All products missing productVariantId / storeProductId');
    return {
      ok: false,
      reply: `Found some options but Zepto didn't return the IDs needed to order. Might be a temporary Zepto issue — try again in a moment.`,
    };
  }

  state.products = orderable;
  recordTrace(state, 'search', `${orderable.length} options for "${query}"`);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────
// Phase: PLACE_ORDER (update_cart + create_order)
// ─────────────────────────────────────────────────────────────────────────

interface CartResp {
  cartKey?: string;
  items?: unknown[];
  totalItems?: number;
}

interface CreateOrderResp {
  orderId?: string;
  id?: string;
}

async function placeOrder(userId: string, state: ZeptoOrderState): Promise<{ ok: boolean; reply?: string }> {
  const product = state.selected;
  if (!product) {
    recordError(state, 'placing', 'no_selection', 'placeOrder called with no selected product');
    return { ok: false, reply: "Something went wrong — I don't have a selected product to order." };
  }

  // 1. update_cart
  const cartArgs = {
    deviceId: deviceIdFor(userId),
    cartItems: [
      {
        productVariantId: product.productVariantId,
        storeProductId: product.storeProductId,
        quantity: 1,
      },
    ],
    replaceCart: true,
  };
  const cart = await mcp<CartResp>(userId, 'update_cart', cartArgs);
  if (!cart.ok) {
    recordError(state, 'placing', 'cart_failed', cart.error);
    return { ok: false, reply: `Couldn't add to cart on Zepto: ${escapeHtml(cart.error)}` };
  }
  state.cartKey = cart.structured?.cartKey;
  recordTrace(state, 'placing', `cart staged (cartKey=${state.cartKey ?? 'n/a'})`);

  // 2. create_order — COD. Pass cartKey and address if available; Zepto
  // will use its defaults for anything we omit.
  const orderArgs: Record<string, unknown> = {
    paymentMethod: 'COD',
    confirmOrder: true,
  };
  if (state.cartKey) orderArgs.cartKey = state.cartKey;
  if (state.address?.id) orderArgs.addressId = state.address.id;

  const order = await mcp<CreateOrderResp>(userId, 'create_order', orderArgs);
  if (!order.ok) {
    recordError(state, 'placing', 'order_failed', order.error);
    return { ok: false, reply: `Zepto couldn't place the order: ${escapeHtml(order.error)}` };
  }

  const orderId = order.structured?.orderId ?? order.structured?.id ?? undefined;
  state.order = {
    id: orderId,
    rawResult: flattenText(order.result).slice(0, 500),
    placedAt: new Date().toISOString(),
  };
  recordTrace(state, 'placing', `order placed (id=${orderId ?? 'n/a'})`);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────
// User-reply parsing
// ─────────────────────────────────────────────────────────────────────────

const CONFIRM_RE = /^(yes|yep|yeah|y|confirm|go ahead|order it|place it|do it|haan|haan ji|ha|han|hmm yes|sure|ok|okay|chalo|kar do|mangwa do|manga do)\b/i;
const CANCEL_RE = /^(no|nope|nah|cancel|stop|don'?t|leave it|rehne do|mat karo|nahi|nah mat|abort)\b/i;

function parseChoice(text: string, optionCount: number): number | null {
  const m = text.trim().match(/^(?:option\s*)?(\d+)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (n >= 1 && n <= optionCount) return n;
  return null;
}

function parseConfirm(text: string): 'yes' | 'no' | null {
  const t = text.trim();
  if (CONFIRM_RE.test(t)) return 'yes';
  if (CANCEL_RE.test(t)) return 'no';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Reply formatters
// ─────────────────────────────────────────────────────────────────────────

function rupees(paise: number): string {
  return `₹${(paise / 100).toFixed(paise % 100 === 0 ? 0 : 2)}`;
}

function formatOption(p: ProductOption): string {
  const parts = [`<b>${escapeHtml(p.name)}</b>`];
  if (p.packSize) parts.push(escapeHtml(p.packSize));
  if (p.pricePaise > 0) parts.push(`<b>${rupees(p.pricePaise)}</b>`);
  return parts.join(' · ');
}

function presentOptionsReply(state: ZeptoOrderState): string {
  const products = state.products!;
  const lines = products.map((p) => `${p.optionNumber}. ${formatOption(p)}`);
  const addr = state.address?.label ? ` (delivering to ${escapeHtml(state.address.label)})` : '';
  if (products.length === 1) {
    return `Found one match${addr}:\n\n${lines[0]}\n\nReply <b>yes</b> to place this COD order, or <b>no</b> to cancel.`;
  }
  return `Found ${products.length} options${addr}:\n\n${lines.join('\n')}\n\nReply with <b>1</b>, <b>2</b>, or <b>3</b> to pick. Reply <b>cancel</b> to abort.`;
}

function confirmIntentReply(state: ZeptoOrderState): string {
  const p = state.selected!;
  return `Ordering <b>${escapeHtml(p.name)}</b> · ${escapeHtml(p.packSize)} · <b>${rupees(p.pricePaise)}</b> · <b>COD</b>.\n\nPlace the order? Reply <b>yes</b> to confirm, <b>no</b> to cancel.`;
}

function completedReply(state: ZeptoOrderState): string {
  const p = state.selected!;
  const idLine = state.order?.id ? `\nOrder id: <code>${escapeHtml(state.order.id)}</code>` : '';
  return `✅ Order placed for <b>${escapeHtml(p.name)}</b> · ${rupees(p.pricePaise)} COD.${idLine}\n\nTell me when it arrives and I'll update your pantry 🍽️`;
}

// ─────────────────────────────────────────────────────────────────────────
// Orchestrator — single entry point called from agent.ts
// ─────────────────────────────────────────────────────────────────────────

export interface OrderTurnInput {
  userId: string;
  message: string;
  /** Order query extracted from the message by intent classifier (optional). */
  orderQuery?: string;
}

/**
 * Run one turn of the Zepto order workflow. Called by agent.ts whenever
 * the classifier labels a message as 'order' intent.
 *
 * The workflow holds all state transitions and MCP calls. Caller just
 * gets a reply string to send the user.
 */
export async function runOrderTurn(input: OrderTurnInput): Promise<WorkflowReply> {
  const { userId, message } = input;

  // User explicit cancel at any point kills the flow.
  if (parseConfirm(message) === 'no' && message.trim().length <= 15) {
    const existing = await loadState(userId);
    if (existing) {
      existing.state.phase = 'cancelled';
      recordTrace(existing.state, 'cancelled', 'user cancelled');
      await saveState(userId, existing.state, existing.task);
    }
    return { text: 'Cancelled. No order placed 👍', finished: true };
  }

  const loaded = await loadState(userId);
  const starting = !loaded || loaded.state.phase === 'completed' || loaded.state.phase === 'failed' || loaded.state.phase === 'cancelled';

  // Fresh workflow: need a query. Either the caller gave us one, or the
  // user's message IS the query (intent classifier has already decided).
  let state: ZeptoOrderState = starting ? blankState() : loaded.state;
  const existingTask = loaded?.task;

  log.info(`turn start phase=${state.phase}`, { userId, starting, message: message.slice(0, 80) });

  try {
    // Phase: NEW → ENSURE_ADDRESS
    if (state.phase === 'new') {
      state.phase = 'ensure_address';
      recordTrace(state, 'ensure_address', 'starting');
    }

    // Phase: ENSURE_ADDRESS
    if (state.phase === 'ensure_address') {
      const r = await ensureAddress(userId, state);
      if (!r.ok) {
        state.phase = 'failed';
        await saveState(userId, state, existingTask);
        return { text: r.reply ?? 'Address step failed.', finished: true };
      }
      state.phase = 'search';
    }

    // Phase: SEARCH — needs a query. Use the extracted orderQuery if we
    // have one (fresh flow); otherwise use the raw message (rare path).
    if (state.phase === 'search') {
      const query = input.orderQuery?.trim() || message.trim();
      if (!query) {
        state.phase = 'failed';
        recordError(state, 'search', 'no_query', 'No search query could be extracted');
        await saveState(userId, state, existingTask);
        return { text: 'What are you trying to order? Give me a product name.', finished: true };
      }
      const r = await runSearch(userId, state, query);
      if (!r.ok) {
        state.phase = 'failed';
        await saveState(userId, state, existingTask);
        return { text: r.reply ?? 'Search failed.', finished: true };
      }
      // If only 1 option, skip choice phase — jump directly to confirm
      if (state.products!.length === 1) {
        state.selected = state.products![0]!;
        state.phase = 'await_confirm';
        recordTrace(state, 'await_confirm', 'auto-selected single result');
        await saveState(userId, state, existingTask);
        return { text: presentOptionsReply(state) };
      }
      state.phase = 'await_choice';
      await saveState(userId, state, existingTask);
      return { text: presentOptionsReply(state) };
    }

    // Phase: AWAIT_CHOICE — user picks 1/2/3
    if (state.phase === 'await_choice') {
      const products = state.products ?? [];
      const choice = parseChoice(message, products.length);
      if (!choice) {
        // Heuristic: if user said something new (long message), treat as new
        // search. Otherwise ask for a valid number.
        const looksLikeNewQuery = message.trim().split(/\s+/).length >= 2 && !/^option/i.test(message);
        if (looksLikeNewQuery && input.orderQuery) {
          state.phase = 'search';
          state.products = undefined;
          recordTrace(state, 'search', 'user typed new query mid-choice');
          const r = await runSearch(userId, state, input.orderQuery);
          if (!r.ok) {
            state.phase = 'failed';
            await saveState(userId, state, existingTask);
            return { text: r.reply ?? 'Search failed.', finished: true };
          }
          if (state.products!.length === 1) {
            state.selected = state.products![0]!;
            state.phase = 'await_confirm';
          } else {
            state.phase = 'await_choice';
          }
          await saveState(userId, state, existingTask);
          return { text: presentOptionsReply(state) };
        }
        return { text: `Reply with <b>1</b>, <b>2</b>, or <b>3</b> — or say <b>cancel</b>.` };
      }
      state.selected = products.find((p) => p.optionNumber === choice)!;
      state.phase = 'await_confirm';
      recordTrace(state, 'await_confirm', `user picked option ${choice}`);
      await saveState(userId, state, existingTask);
      return { text: confirmIntentReply(state) };
    }

    // Phase: AWAIT_CONFIRM — user says yes/no
    if (state.phase === 'await_confirm') {
      const decision = parseConfirm(message);
      if (decision === null) {
        return { text: `Just reply <b>yes</b> to confirm or <b>no</b> to cancel.` };
      }
      if (decision === 'no') {
        state.phase = 'cancelled';
        recordTrace(state, 'cancelled', 'user declined');
        await saveState(userId, state, existingTask);
        return { text: 'Cancelled. No order placed 👍', finished: true };
      }
      // yes → PLACING
      state.phase = 'placing';
      const r = await placeOrder(userId, state);
      if (!r.ok) {
        state.phase = 'failed';
        await saveState(userId, state, existingTask);
        return { text: r.reply ?? 'Order placement failed.', finished: true };
      }
      state.phase = 'completed';
      await saveState(userId, state, existingTask);
      return { text: completedReply(state), finished: true };
    }

    // Defensive: completed / failed / cancelled should have been handled by `starting`
    log.warn(`turn fell through in phase=${state.phase}`, { userId });
    return { text: "Let me know what you'd like to order." };
  } catch (err) {
    log.error('Unhandled workflow error', err);
    state.phase = 'failed';
    recordError(state, state.phase, 'unhandled', err instanceof Error ? err.message : String(err));
    try { await saveState(userId, state, existingTask); } catch (_) { /* ignore */ }
    return { text: 'Something went sideways on my end while placing the order. Give it a minute and try again 🙏', finished: true };
  }
}

/** Expose the trace for diagnostic commands. */
export async function getActiveOrderWorkflow(userId: string): Promise<ZeptoOrderState | null> {
  const loaded = await loadState(userId);
  return loaded?.state ?? null;
}
