/**
 * Grocery provider interface — the abstraction every shopping integration
 * (Zepto, Blinkit, Instamart) implements. Domain code (workflows, agent
 * tools, pantry seeding) talks to this interface only; provider impls own
 * the protocol-specific details (MCP tool names, response parsing, error
 * shapes).
 *
 * Designed multi-item from the start: searchMany takes an array, upsertCart
 * takes an array of lines. Single-item flows are a degenerate case.
 *
 * All money values are integer paise (₹1 = 100 paise) to avoid float drift.
 */

export type ProviderName = 'zepto'; // future: 'blinkit' | 'instamart'

// ─────────────────────────────────────────────────────────────────────────
// Domain types
// ─────────────────────────────────────────────────────────────────────────

export interface ProductOption {
  productVariantId: string;
  storeProductId: string;
  cartProductId: string | null;
  name: string;
  packSize: string;
  pricePaise: number;
  /** MRP if available — useful for showing discount. */
  mrpPaise?: number;
  imageUrl?: string;
  available: boolean;
}

export interface SearchGroup {
  query: string;
  products: ProductOption[];
}

export interface Address {
  id: string;
  /** Short, user-facing label: "Home — DLF Phase 3" */
  label: string;
  isDefault?: boolean;
  /** Full formatted address if the provider returned one. */
  formatted?: string;
  latitude?: number;
  longitude?: number;
}

export interface StoreContext {
  storeId: string;
  addressId: string;
}

export interface PastOrderItem {
  name: string;
  productVariantId: string;
  /** Number of distinct past orders this product appeared in. */
  frequency: number;
}

export interface CartLine {
  productVariantId: string;
  storeProductId: string;
  quantity: number;
  /** Optional display fields — providers may persist them for richer cart views. */
  name?: string;
  pricePaise?: number;
}

export interface Cart {
  cartKey?: string;
  lines: CartLine[];
  totalItems: number;
}

export interface OrderPreview {
  cartKey?: string;
  subtotalPaise: number;
  deliveryFeePaise: number;
  handlingFeePaise: number;
  /** Sum of all charges including taxes. Source of truth for the user-shown total. */
  totalPaise: number;
  etaMinutes?: number;
  /**
   * Whether the provider says this address+cart is deliverable right now.
   * If false the workflow should NOT proceed to placement — it surfaces a
   * "store unserviceable" message instead.
   */
  deliverable: boolean;
  /** If the provider needs an extra step (e.g. drop zone selection), surfaced here. */
  requiresDropZone?: { availableSlots: string[] };
}

export type PaymentMethod = 'cod' | 'online' | 'wallet' | 'upi_reserve';

export interface PaymentMethodInfo {
  method: PaymentMethod;
  available: boolean;
  /** Provider-specific label, e.g. "Zepto Cash (₹120 balance)". */
  label: string;
}

export interface PlaceOrderOpts {
  cartKey?: string;
  addressId: string;
  paymentMethod: PaymentMethod;
  riderTipPaise?: number;
  useZeptoCash?: boolean;
}

export interface PlacedOrder {
  orderId: string;
  /** For online/upi_reserve flows — user must complete payment at this URL. */
  paymentLink?: string;
  /** Whether the caller should poll check_payment_status. */
  pollPayment?: boolean;
  raw?: string;
}

export type PaymentStatus = 'pending' | 'success' | 'failed' | 'cancelled';

export interface OrderSummary {
  orderId: string;
  placedAt: string;
  totalPaise: number;
  status: string;
}

export interface OrderDetail extends OrderSummary {
  items: Array<{ name: string; quantity: number; pricePaise: number }>;
  deliveryAddress?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────

export class GroceryProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: ProviderName,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'GroceryProviderError';
  }
}

export class GroceryProviderNotConnectedError extends GroceryProviderError {
  constructor(provider: ProviderName) {
    super(`${provider} not connected for this user.`, provider, 'not_connected');
    this.name = 'GroceryProviderNotConnectedError';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// The interface
// ─────────────────────────────────────────────────────────────────────────

export interface GroceryProvider {
  readonly name: ProviderName;

  // Search
  searchMany(userId: string, queries: string[]): Promise<SearchGroup[]>;

  // Addresses & store context
  listAddresses(userId: string): Promise<Address[]>;
  selectAddress(userId: string, addressId: string): Promise<StoreContext>;

  // Past orders — the pantry-seed source
  pastOrderItems(userId: string): Promise<PastOrderItem[]>;

  // Cart
  upsertCart(userId: string, lines: CartLine[], opts?: { replace?: boolean }): Promise<Cart>;

  // Order preview & placement
  getPaymentMethods(userId: string): Promise<PaymentMethodInfo[]>;
  previewOrder(userId: string, opts: { addressId: string; paymentMethod: PaymentMethod }): Promise<OrderPreview>;
  placeOrder(userId: string, opts: PlaceOrderOpts): Promise<PlacedOrder>;
  checkPaymentStatus(userId: string, orderId: string): Promise<PaymentStatus>;

  // Order history
  listOrders(userId: string, limit?: number): Promise<OrderSummary[]>;
  getOrder(userId: string, orderId: string): Promise<OrderDetail>;
}
