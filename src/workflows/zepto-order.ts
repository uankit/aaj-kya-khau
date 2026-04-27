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
import { agentTasks, type AgentTask } from '../db/schema.js';
import { type McpToolResult } from '../providers/grocery/zepto/client.js';
import {
  ZeptoSessionNotConnectedError,
  ZeptoWarmUpError,
  callZeptoToolWarm,
  listWarmZeptoTools,
} from '../providers/grocery/zepto/session.js';
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
  /** Zepto store ID bound to the selected address. Search/cart are gated on
   * select_store having been called for the current session; this caches
   * the store ID so we don't re-resolve it per turn. */
  storeId?: string;
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
  const started = Date.now();
  log.info(`mcp call: ${toolName}`, { userId, args });
  try {
    // Session warm-up is owned by the zepto-session layer — by the time we
    // see `result`, any "Registration required" gating has already been
    // handled transparently, or thrown a ZeptoWarmUpError.
    const { result } = await callZeptoToolWarm(userId, toolName, args);
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
    if (err instanceof ZeptoSessionNotConnectedError) {
      return { ok: false, error: err.message };
    }
    if (err instanceof ZeptoWarmUpError) {
      log.warn(`mcp ${toolName}: warm-up failed`, { userId, ms, error: err.message });
      return { ok: false, error: `Zepto session setup failed — ${err.message}` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`mcp ${toolName} threw after ${ms}ms`, err);
    return { ok: false, error: msg };
  }
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
//
// Owns the full shopping-prerequisites chain. Zepto layers preconditions:
// session warmed → delivery address selected → store selected. We pay them
// all here, up front, so downstream phases (search / cart / order) can
// assume a ready-to-shop state. Each precondition is cached in state so
// the chain short-circuits on subsequent turns.
// ─────────────────────────────────────────────────────────────────────────

interface SavedAddressListResp {
  addresses?: Array<{ id: string; label?: string; isDefault?: boolean; addressLine?: string }>;
}

interface LocationServiceabilityResp {
  isServiceable?: boolean;
  storeId?: string;
  store?: { id?: string; storeId?: string };
}

interface SelectStoreResp {
  storeId?: string;
  store?: { id?: string; storeId?: string };
}

async function ensureAddress(userId: string, state: ZeptoOrderState): Promise<{ ok: boolean; reply?: string }> {
  if (state.address?.id && state.storeId) return { ok: true };

  // Step 1: pick & select a saved address (if not already cached).
  if (!state.address?.id) {
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
  }

  // Step 2: select a store for that address.
  // Zepto gates search / cart / order on select_store having been called
  // for the current MCP session, even when the selected saved address
  // already has a known store on their side.
  const storeResult = await selectStoreForAddress(userId, state.address!.id);
  if (!storeResult.ok) {
    recordError(state, 'ensure_address', 'store_select_failed', storeResult.error);
    return {
      ok: false,
      reply: `Couldn't set a Zepto store for your delivery address — ${escapeHtml(storeResult.error)}`,
    };
  }
  state.storeId = storeResult.storeId ?? 'unknown';
  recordTrace(state, 'ensure_address', `selected store ${state.storeId}`);
  return { ok: true };
}

/**
 * Resolve and select the Zepto store that serves the given address.
 *
 * Strategy — we don't have the definitive schema of `select_store` or
 * `get_location_serviceability`, so try the two most plausible shapes and
 * fall back cleanly. On total failure we dump those tools' schemas so the
 * next iteration can pass the right args.
 */
async function selectStoreForAddress(
  userId: string,
  addressId: string,
): Promise<{ ok: true; storeId?: string } | { ok: false; error: string }> {
  // Attempt A: some Zepto deployments let select_store derive the store
  // from the currently-selected address (no arg / { addressId }).
  const direct = await mcp<SelectStoreResp>(userId, 'select_store', { addressId });
  if (direct.ok) {
    const storeId =
      direct.structured?.storeId ?? direct.structured?.store?.id ?? direct.structured?.store?.storeId;
    log.info(`select_store direct ok (storeId=${storeId ?? 'unknown'})`, { userId });
    return { ok: true, storeId };
  }

  // Attempt B: resolve store ID via location serviceability, then
  // explicitly select_store({ storeId }).
  const serv = await mcp<LocationServiceabilityResp>(userId, 'get_location_serviceability', {
    addressId,
  });
  if (!serv.ok) {
    await dumpStoreToolSchemas(userId, {
      directError: direct.error,
      servError: serv.error,
    });
    return {
      ok: false,
      error: `select_store({addressId}) → ${direct.error}; get_location_serviceability → ${serv.error}`,
    };
  }

  const storeId =
    serv.structured?.storeId ?? serv.structured?.store?.id ?? serv.structured?.store?.storeId;
  if (!storeId) {
    await dumpStoreToolSchemas(userId, {
      directError: direct.error,
      servError: 'no storeId in serviceability response',
    });
    return {
      ok: false,
      error: `get_location_serviceability returned but no storeId was found in response`,
    };
  }

  const byId = await mcp<SelectStoreResp>(userId, 'select_store', { storeId });
  if (!byId.ok) {
    await dumpStoreToolSchemas(userId, {
      directError: direct.error,
      servError: `select_store({storeId}) → ${byId.error}`,
    });
    return { ok: false, error: `select_store({storeId=${storeId}}) → ${byId.error}` };
  }

  log.info(`select_store via serviceability ok (storeId=${storeId})`, { userId });
  return { ok: true, storeId };
}

/**
 * One-shot diagnostic: dump the inputSchema + description of store-related
 * Zepto tools when our arg-shape guesses fail. Keeps the next fix cycle
 * evidence-based rather than guessing further.
 */
async function dumpStoreToolSchemas(
  userId: string,
  context: { directError: string; servError: string },
): Promise<void> {
  try {
    const all = await listWarmZeptoTools(userId);
    const relevant = all.filter((t) => /store|location|servic|shop|zone/i.test(t.name));
    log.warn('DEBUG store-related tool schemas (select_store path exhausted)', {
      userId,
      context,
      schemas: relevant.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  } catch (err) {
    log.warn('DEBUG tools/list for store diagnosis failed', err);
  }
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
