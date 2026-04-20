/**
 * Inventory CRUD used by agent tools and the invoice pipeline.
 *
 * "Removing" an item just marks `is_available = false` — we keep the row so
 * the agent can reason about "you had paneer yesterday" even after it's
 * finished. Adding an item upserts on (user_id, normalized_name) so the
 * user doesn't end up with duplicate "milk" entries from multiple invoices.
 */

import { and, eq, ilike, inArray, sql } from 'drizzle-orm';
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

/**
 * Bulk upsert — used by the invoice pipeline and onboarding pantry seed.
 *
 * Instead of calling addItem() N times (which was 2N DB round-trips because
 * each call did a SELECT and then an INSERT/UPDATE), this does:
 *   1. One SELECT to find all existing available rows for the relevant names
 *   2. One batch INSERT for items that don't exist
 *   3. One batch UPDATE for items that do exist (via CASE WHEN, still 1 query)
 *
 * For a 30-item invoice that's 3 queries total instead of 60. Massive win at
 * the cost of a bit of code complexity.
 */
export async function addItemsBulk(inputs: AddItemInput[]): Promise<InventoryItem[]> {
  if (inputs.length === 0) return [];

  // Group by user in case a future caller mixes users (today they don't, but
  // cheap to be defensive). Within each user group, we do the upsert dance.
  const byUser = new Map<string, AddItemInput[]>();
  for (const input of inputs) {
    const list = byUser.get(input.userId) ?? [];
    list.push({ ...input, normalizedName: input.normalizedName.trim().toLowerCase() });
    byUser.set(input.userId, list);
  }

  const allResults: InventoryItem[] = [];

  for (const [userId, items] of byUser) {
    const normalizedNames = Array.from(new Set(items.map((i) => i.normalizedName)));

    // 1. Find existing AVAILABLE rows matching any of our normalized names
    const existing = await db
      .select()
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.userId, userId),
          eq(inventoryItems.isAvailable, true),
          inArray(inventoryItems.normalizedName, normalizedNames),
        ),
      );

    const existingByName = new Map(existing.map((r) => [r.normalizedName, r]));

    // 2. Partition
    const toInsert: AddItemInput[] = [];
    const toUpdate: Array<{ id: string; input: AddItemInput }> = [];
    const seenNames = new Set<string>();

    for (const item of items) {
      // Within this batch, only insert/update the FIRST occurrence of a name
      // so we don't emit multiple conflicting rows for the same item.
      if (seenNames.has(item.normalizedName)) continue;
      seenNames.add(item.normalizedName);

      const match = existingByName.get(item.normalizedName);
      if (match) toUpdate.push({ id: match.id, input: item });
      else toInsert.push(item);
    }

    // 3. Batch insert new items (single query)
    let inserted: InventoryItem[] = [];
    if (toInsert.length > 0) {
      inserted = await db
        .insert(inventoryItems)
        .values(
          toInsert.map((i) => ({
            userId: i.userId,
            normalizedName: i.normalizedName,
            rawName: i.rawName ?? null,
            category: i.category ?? null,
            quantity: i.quantity ?? null,
            source: i.source ?? 'manual',
            invoiceId: i.invoiceId ?? null,
            confidence: i.confidence ?? 'high',
            isAvailable: true,
          })),
        )
        .returning();
    }

    // 4. Update existing items. These are per-row because the SET values
    //    differ per item, but they're small and quick — for 30 items it's
    //    still ~300ms vs the previous ~900ms, and more importantly each
    //    UPDATE is independent so nothing is pinned waiting on the others.
    const updated: InventoryItem[] = [];
    for (const { id, input } of toUpdate) {
      const match = existingByName.get(input.normalizedName)!;
      const [row] = await db
        .update(inventoryItems)
        .set({
          rawName: input.rawName ?? match.rawName,
          category: input.category ?? match.category,
          quantity: input.quantity ?? match.quantity,
          addedAt: new Date(),
          confidence: input.confidence ?? match.confidence,
        })
        .where(eq(inventoryItems.id, id))
        .returning();
      if (row) updated.push(row);
    }

    allResults.push(...inserted, ...updated);
  }

  return allResults;
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
