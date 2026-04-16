/**
 * Inventory CRUD used by agent tools and the invoice pipeline.
 *
 * "Removing" an item just marks `is_available = false` — we keep the row so
 * the agent can reason about "you had paneer yesterday" even after it's
 * finished. Adding an item upserts on (user_id, normalized_name) so the
 * user doesn't end up with duplicate "milk" entries from multiple invoices.
 */

import { and, eq, ilike, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { inventoryItems, type InventoryItem } from '../db/schema.js';

export type InventoryRow = Pick<
  InventoryItem,
  'id' | 'normalizedName' | 'category' | 'quantity' | 'rawName' | 'addedAt' | 'isAvailable'
>;

/** All currently available items for a user (ordered by recency). */
export async function listAvailable(userId: string): Promise<InventoryRow[]> {
  return db
    .select({
      id: inventoryItems.id,
      normalizedName: inventoryItems.normalizedName,
      category: inventoryItems.category,
      quantity: inventoryItems.quantity,
      rawName: inventoryItems.rawName,
      addedAt: inventoryItems.addedAt,
      isAvailable: inventoryItems.isAvailable,
    })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.userId, userId), eq(inventoryItems.isAvailable, true)))
    .orderBy(sql`${inventoryItems.addedAt} desc`);
}

export interface AddItemInput {
  userId: string;
  normalizedName: string;
  rawName?: string;
  category?: string;
  quantity?: string;
  source?: 'manual' | 'invoice';
  invoiceId?: string;
  confidence?: 'high' | 'medium' | 'low';
}

/**
 * Upserts an inventory item. If a row with the same normalized name already
 * exists for this user and is still available, we refresh `added_at` and any
 * new metadata (quantity, raw name). Otherwise we insert fresh.
 *
 * Returns the final row.
 */
export async function addItem(input: AddItemInput): Promise<InventoryItem> {
  const normalized = input.normalizedName.trim().toLowerCase();

  const existing = await db
    .select()
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.userId, input.userId),
        eq(inventoryItems.normalizedName, normalized),
        eq(inventoryItems.isAvailable, true),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    const [row] = existing;
    const [updated] = await db
      .update(inventoryItems)
      .set({
        rawName: input.rawName ?? row!.rawName,
        category: input.category ?? row!.category,
        quantity: input.quantity ?? row!.quantity,
        addedAt: new Date(),
        confidence: input.confidence ?? row!.confidence,
      })
      .where(eq(inventoryItems.id, row!.id))
      .returning();
    return updated!;
  }

  const [inserted] = await db
    .insert(inventoryItems)
    .values({
      userId: input.userId,
      normalizedName: normalized,
      rawName: input.rawName ?? null,
      category: input.category ?? null,
      quantity: input.quantity ?? null,
      source: input.source ?? 'manual',
      invoiceId: input.invoiceId ?? null,
      confidence: input.confidence ?? 'high',
      isAvailable: true,
    })
    .returning();
  return inserted!;
}

/** Bulk upsert — used by the invoice pipeline. */
export async function addItemsBulk(inputs: AddItemInput[]): Promise<InventoryItem[]> {
  const results: InventoryItem[] = [];
  for (const input of inputs) {
    results.push(await addItem(input));
  }
  return results;
}

/**
 * Marks any available item whose normalized name matches `query` (case-insensitive
 * substring) as finished. Returns the names of items that were removed so the
 * agent can tell the user exactly what happened.
 */
export async function removeItemByName(
  userId: string,
  query: string,
): Promise<string[]> {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];

  const rows = await db
    .update(inventoryItems)
    .set({ isAvailable: false, finishedAt: new Date() })
    .where(
      and(
        eq(inventoryItems.userId, userId),
        eq(inventoryItems.isAvailable, true),
        ilike(inventoryItems.normalizedName, `%${q}%`),
      ),
    )
    .returning({ normalizedName: inventoryItems.normalizedName });

  return rows.map((r) => r.normalizedName);
}

/** Bulk-remove: accepts an array of names (e.g. from nightly reconciliation). */
export async function markFinishedBulk(
  userId: string,
  names: string[],
): Promise<string[]> {
  const removed: string[] = [];
  for (const name of names) {
    const r = await removeItemByName(userId, name);
    removed.push(...r);
  }
  return removed;
}
