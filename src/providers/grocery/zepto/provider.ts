/**
 * ZeptoProvider — Zepto MCP implementation of GroceryProvider.
 *
 * This file is the ONLY place in the codebase that knows about Zepto's
 * specific tool names, arg shapes, and response parsing quirks. Domain code
 * (workflows, agent tools) consumes the typed GroceryProvider interface and
 * is provider-agnostic.
 *
 * Response parsing is defensive on purpose. Zepto's MCP returns a mix of
 * `structuredContent`, per-block `_meta`, and human-readable text. We try
 * each shape in turn and log the raw payload when nothing matches so future
 * fixes can be evidence-based rather than speculative.
 */

import { createLogger } from '../../../utils/logger.js';
import { type McpToolResult } from './client.js';
import {
  ZeptoSessionNotConnectedError,
  ZeptoWarmUpError,
  callZeptoToolWarm,
} from './session.js';
import {
  type Address,
  type GroceryProvider,
  GroceryProviderError,
  GroceryProviderNotConnectedError,
  type OrderSummary,
  type PastOrderItem,
  type PaymentMethod,
  type PaymentMethodInfo,
  type PaymentStatus,
  type ProductOption,
} from '../types.js';

const log = createLogger('zepto-provider');

// ─────────────────────────────────────────────────────────────────────────
// Low-level call helper — wraps callZeptoToolWarm with consistent error
// translation into our typed exceptions.
// ─────────────────────────────────────────────────────────────────────────

async function call(userId: string, toolName: string, args: unknown): Promise<McpToolResult> {
  try {
    const { result } = await callZeptoToolWarm(userId, toolName, args);
    if (result.isError) {
      const body = flattenText(result).slice(0, 500);
      throw new GroceryProviderError(`zepto ${toolName}: ${body}`, 'zepto', `${toolName}_error`);
    }
    return result;
  } catch (err) {
    if (err instanceof ZeptoSessionNotConnectedError) {
      throw new GroceryProviderNotConnectedError('zepto');
    }
    if (err instanceof ZeptoWarmUpError) {
      throw new GroceryProviderError(err.message, 'zepto', 'warmup_failed');
    }
    if (err instanceof GroceryProviderError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new GroceryProviderError(`zepto ${toolName}: ${msg}`, 'zepto', `${toolName}_threw`);
  }
}

function flattenText(r: McpToolResult): string {
  if (!r.content) return '';
  return r.content
    .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .join('\n');
}

/** Try `structuredContent`, then per-block `_meta`. Returns null if neither. */
function structured<T>(r: McpToolResult): T | null {
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

/** Throw a parse-failure error that includes the raw text snippet. */
function parseFailure(toolName: string, r: McpToolResult): never {
  const snippet = flattenText(r).slice(0, 300);
  log.warn(`zepto ${toolName} response did not match expected shape`, { snippet });
  throw new GroceryProviderError(
    `zepto ${toolName} returned an unexpected response shape`,
    'zepto',
    `${toolName}_parse_failed`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Per-method response shapes (best-effort, refined over time)
// ─────────────────────────────────────────────────────────────────────────

interface RawProduct {
  id?: string;
  productVariantId?: string;
  variantId?: string;
  storeProductId?: string;
  cartProductId?: string | null;
  name?: string;
  price?: number;
  mrp?: number;
  packSize?: string;
  imageUrl?: string;
  availableQuantity?: number | null;
  isAvailable?: boolean;
}

function toProductOption(p: RawProduct): ProductOption | null {
  const productVariantId = p.productVariantId ?? p.id ?? p.variantId ?? '';
  const storeProductId = p.storeProductId ?? '';
  if (!productVariantId || !storeProductId) return null;
  const available = p.isAvailable ?? (p.availableQuantity == null ? true : p.availableQuantity > 0);
  return {
    productVariantId,
    storeProductId,
    cartProductId: p.cartProductId ?? null,
    name: p.name ?? 'Unknown product',
    packSize: p.packSize ?? '',
    pricePaise: typeof p.price === 'number' ? p.price : 0,
    mrpPaise: typeof p.mrp === 'number' ? p.mrp : undefined,
    imageUrl: p.imageUrl,
    available,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────

const CART_DEVICE_ID_PREFIX = 'aaj-kya-khaun-';
const deviceIdFor = (userId: string): string => `${CART_DEVICE_ID_PREFIX}${userId}`;

export const zeptoProvider: GroceryProvider = {
  name: 'zepto',

  async searchMany(userId, queries) {
    if (queries.length === 0) return [];
    const result = await call(userId, 'search_multiple_products', { queries });
    // Zepto's actual shape: structuredContent.sections[].{ query, products }
    type Resp = {
      sections?: Array<{ query: string; products?: RawProduct[] }>;
      groups?: Array<{ query: string; products?: RawProduct[] }>;
    };
    const s = structured<Resp>(result);
    const list = s?.sections ?? s?.groups;
    if (list) {
      return list.map((g) => ({
        query: g.query,
        products: (g.products ?? [])
          .map(toProductOption)
          .filter((x): x is ProductOption => x !== null),
      }));
    }
    // Fallback — single combined products array; collapse into one group per query.
    type Flat = { products?: RawProduct[] };
    const flat = structured<Flat>(result);
    if (flat?.products) {
      const products = flat.products
        .map(toProductOption)
        .filter((x): x is ProductOption => x !== null);
      return queries.map((q) => ({ query: q, products }));
    }
    parseFailure('search_multiple_products', result);
  },

  async listAddresses(userId) {
    const result = await call(userId, 'list_saved_addresses', {});
    type Resp = {
      addresses?: Array<{
        id: string;
        label?: string;
        addressLine?: string;
        formattedAddress?: string;
        isDefault?: boolean;
        latitude?: number;
        longitude?: number;
      }>;
    };
    const s = structured<Resp>(result);
    if (!s?.addresses) parseFailure('list_saved_addresses', result);
    return s.addresses.map<Address>((a) => ({
      id: a.id,
      label: a.label ?? a.addressLine ?? a.formattedAddress ?? 'Saved address',
      formatted: a.formattedAddress,
      isDefault: a.isDefault,
      latitude: a.latitude,
      longitude: a.longitude,
    }));
  },

  async selectAddress(userId, addressId) {
    // select_saved_address auto-sets the store context per Zepto's tool docs.
    const result = await call(userId, 'select_saved_address', { addressId });
    type Resp = { storeId?: string; store?: { id?: string; storeId?: string } };
    const s = structured<Resp>(result);
    const storeId = s?.storeId ?? s?.store?.id ?? s?.store?.storeId;
    if (!storeId) {
      // Fallback: explicit select_store call. Some Zepto deployments don't
      // expose storeId in the select_saved_address response even though the
      // store IS bound server-side. We still return a best-guess context.
      log.info('select_saved_address did not return storeId; trusting server-side bind', { userId, addressId });
      return { storeId: 'unknown', addressId };
    }
    return { storeId, addressId };
  },

  async pastOrderItems(userId) {
    const result = await call(userId, 'get_past_order_items', {});
    type Resp = {
      items?: Array<{ name: string; productVariantId: string; frequency: number }>;
      products?: Array<{ name: string; productVariantId: string; frequency: number }>;
    };
    const s = structured<Resp>(result);
    const list = s?.items ?? s?.products;
    if (list) {
      return list.map<PastOrderItem>((it) => ({
        name: it.name,
        productVariantId: it.productVariantId,
        frequency: it.frequency,
      }));
    }
    // Fallback: Zepto returns this tool as plain text on text/event-stream.
    // Format:
    //   Found N unique products from past orders:
    //   1. <name> (ordered in <K> orders)
    //   2. ...
    //   Product Variant IDs:
    //   [1] pvid: <uuid>
    //   [2] pvid: <uuid>
    return parsePastOrderItemsText(flattenText(result));
  },

  async upsertCart(userId, lines, opts) {
    const result = await call(userId, 'update_cart', {
      deviceId: deviceIdFor(userId),
      cartItems: lines.map((l) => ({
        productVariantId: l.productVariantId,
        storeProductId: l.storeProductId,
        quantity: l.quantity,
        ...(l.name !== undefined && { name: l.name }),
        ...(l.pricePaise !== undefined && { price: l.pricePaise }),
      })),
      replaceCart: opts?.replace ?? true,
    });
    type Resp = { cartKey?: string; items?: unknown[]; totalItems?: number };
    const s = structured<Resp>(result);
    return {
      cartKey: s?.cartKey,
      lines,
      totalItems: s?.totalItems ?? lines.reduce((acc, l) => acc + l.quantity, 0),
    };
  },

  async getPaymentMethods(userId) {
    const result = await call(userId, 'get_payment_methods', {});
    type Raw = { method?: string; available?: boolean; label?: string };
    type Resp = { paymentMethods?: Raw[]; methods?: Raw[] };
    const s = structured<Resp>(result);
    const list = s?.paymentMethods ?? s?.methods ?? [];
    const norm: Record<string, PaymentMethod> = {
      cod: 'cod',
      cash: 'cod',
      cash_on_delivery: 'cod',
      online: 'online',
      online_payment: 'online',
      wallet: 'wallet',
      zepto_cash: 'wallet',
      upi_reserve: 'upi_reserve',
      upi_reserve_pay: 'upi_reserve',
    };
    return list
      .map<PaymentMethodInfo | null>((m) => {
        const key = (m.method ?? '').toLowerCase().replace(/\s+/g, '_');
        const method = norm[key];
        if (!method) return null;
        return { method, available: m.available ?? true, label: m.label ?? key };
      })
      .filter((m): m is PaymentMethodInfo => m !== null);
  },

  async previewOrder(userId, opts) {
    const args: Record<string, unknown> = { confirmOrder: false, userAddressId: opts.addressId };
    const tool = orderToolForMethod(opts.paymentMethod);
    const result = await call(userId, tool, args);
    // Zepto's preview shape (observed):
    //   { isPreview, items[], toPayAmount, deliveryFee, packagingFee?,
    //     subTotal?, taxes?, discount?, etaInMinutes?, ... }
    // subTotal often arrives null; we derive it from the line items.
    type Resp = {
      cartKey?: string;
      subTotal?: number | null;
      deliveryFee?: number | null;
      packagingFee?: number | null;
      taxes?: number | null;
      toPayAmount?: number | null;
      etaInMinutes?: number | null;
      deliverable?: boolean;
      items?: Array<{ price?: number | null; quantity?: number | null }>;
      dropZoneRequired?: boolean;
      dropZoneConfig?: { slots?: Array<{ value: string }> };
    };
    const s = structured<Resp>(result);
    if (!s) parseFailure(`${tool}_preview`, result);
    const requiresDropZone = s.dropZoneRequired
      ? { availableSlots: (s.dropZoneConfig?.slots ?? []).map((x) => x.value) }
      : undefined;
    const deliveryFee = s.deliveryFee ?? 0;
    const handlingFee = s.packagingFee ?? 0;
    const taxes = s.taxes ?? 0;
    const total = s.toPayAmount ?? 0;
    const subtotal =
      s.subTotal ??
      (s.items
        ? s.items.reduce(
            (acc, it) => acc + (it.price ?? 0) * (it.quantity ?? 1),
            0,
          )
        : Math.max(0, total - deliveryFee - handlingFee - taxes));
    return {
      cartKey: s.cartKey,
      subtotalPaise: subtotal,
      deliveryFeePaise: deliveryFee,
      handlingFeePaise: handlingFee,
      totalPaise: total,
      etaMinutes: s.etaInMinutes ?? undefined,
      // Treat missing `deliverable` as true — older Zepto responses didn't
      // include the field. Only an explicit false blocks placement.
      deliverable: s.deliverable !== false,
      requiresDropZone,
    };
  },

  async placeOrder(userId, opts) {
    const tool = orderToolForMethod(opts.paymentMethod);
    const args: Record<string, unknown> = {
      confirmOrder: true,
      userAddressId: opts.addressId,
      riderTip: opts.riderTipPaise ?? 0,
    };
    if (opts.paymentMethod !== 'wallet') {
      args.useZeptoCash = opts.useZeptoCash ?? false;
    }
    const result = await call(userId, tool, args);
    type Resp = { orderId?: string; id?: string; paymentLink?: string; paymentUrl?: string };
    const s = structured<Resp>(result);
    const orderId = s?.orderId ?? s?.id;
    if (!orderId) parseFailure(`${tool}_place`, result);
    const paymentLink = s?.paymentLink ?? s?.paymentUrl;
    return {
      orderId,
      paymentLink,
      pollPayment: opts.paymentMethod === 'online' || opts.paymentMethod === 'upi_reserve',
      raw: flattenText(result).slice(0, 500),
    };
  },

  async checkPaymentStatus(userId, orderId) {
    const result = await call(userId, 'check_payment_status', { orderId, poll: false });
    type Resp = { status?: string; paymentStatus?: string };
    const s = structured<Resp>(result);
    const raw = (s?.status ?? s?.paymentStatus ?? '').toUpperCase();
    if (raw.includes('SUCCESS')) return 'success';
    if (raw.includes('FAIL')) return 'failed';
    if (raw.includes('CANCEL')) return 'cancelled';
    return 'pending';
  },

  async listOrders(userId, limit = 10) {
    const result = await call(userId, 'list_order_history', { limit });
    type Raw = { orderId?: string; id?: string; placedAt?: string; createdAt?: string; total?: number; status?: string };
    type Resp = { orders?: Raw[] };
    const s = structured<Resp>(result);
    if (!s?.orders) parseFailure('list_order_history', result);
    return s.orders
      .map<OrderSummary | null>((o) => {
        const orderId = o.orderId ?? o.id;
        if (!orderId) return null;
        return {
          orderId,
          placedAt: o.placedAt ?? o.createdAt ?? new Date().toISOString(),
          totalPaise: o.total ?? 0,
          status: o.status ?? 'unknown',
        };
      })
      .filter((o): o is OrderSummary => o !== null);
  },

  async getOrder(userId, orderId) {
    const result = await call(userId, 'get_order_detail', { orderId });
    type RawItem = { name?: string; quantity?: number; price?: number };
    type Resp = {
      orderId?: string;
      id?: string;
      placedAt?: string;
      createdAt?: string;
      total?: number;
      status?: string;
      items?: RawItem[];
      deliveryAddress?: string;
    };
    const s = structured<Resp>(result);
    if (!s) parseFailure('get_order_detail', result);
    return {
      orderId: s.orderId ?? s.id ?? orderId,
      placedAt: s.placedAt ?? s.createdAt ?? new Date().toISOString(),
      totalPaise: s.total ?? 0,
      status: s.status ?? 'unknown',
      items: (s.items ?? []).map((it) => ({
        name: it.name ?? 'Unknown',
        quantity: it.quantity ?? 1,
        pricePaise: it.price ?? 0,
      })),
      deliveryAddress: s.deliveryAddress,
    };
  },
};

function orderToolForMethod(method: PaymentMethod): string {
  switch (method) {
    case 'cod':
      return 'create_order';
    case 'online':
      return 'create_online_payment_order';
    case 'wallet':
      return 'create_wallet_order';
    case 'upi_reserve':
      return 'create_upi_reserve_pay_order';
  }
}

// Re-export status type so callers don't need a second import.
export type { PaymentStatus };

/**
 * Parse the plain-text get_past_order_items payload Zepto returns.
 * Zips the numbered product list with the [N] pvid: <uuid> section.
 * Items missing a pvid match are skipped silently.
 */
export function parsePastOrderItemsText(text: string): PastOrderItem[] {
  // 1. Capture name + frequency: "1. <name> (ordered in 3 orders)"
  const nameRe = /^\s*(\d+)\.\s+(.+?)\s+\(ordered in (\d+)\s+orders?\)\s*$/gm;
  const nameByIdx: Record<number, { name: string; frequency: number }> = {};
  for (const m of text.matchAll(nameRe)) {
    const idx = Number(m[1]);
    nameByIdx[idx] = { name: m[2]!.trim(), frequency: Number(m[3]) };
  }

  // 2. Capture pvid by index: "[1] pvid: 4b3f8659-..."
  const pvidRe = /\[(\d+)\]\s+pvid:\s+([a-f0-9-]+)/gi;
  const pvidByIdx: Record<number, string> = {};
  for (const m of text.matchAll(pvidRe)) {
    pvidByIdx[Number(m[1])] = m[2]!;
  }

  // 3. Zip; sort by frequency desc to match the structured contract.
  const out: PastOrderItem[] = [];
  for (const idxStr of Object.keys(nameByIdx)) {
    const idx = Number(idxStr);
    const meta = nameByIdx[idx]!;
    const pvid = pvidByIdx[idx];
    if (!pvid) continue;
    out.push({ name: meta.name, productVariantId: pvid, frequency: meta.frequency });
  }
  out.sort((a, b) => b.frequency - a.frequency);
  return out;
}
