/**
 * Pantry seeding from Zepto's past-order history.
 *
 * Triggered on first successful Zepto OAuth connect. Calls the provider's
 * pastOrderItems() (which surfaces Zepto's `get_past_order_items` —
 * deduped products from the user's last ~30 orders, sorted by frequency)
 * and inserts the result into the user's inventory with frequency-aware
 * quantity heuristics.
 *
 *   freq ≥ 5  → kept stocked, 1 unit
 *   freq 2-4  → semi-regular, 0.5 unit
 *   freq 1    → likely one-off, skip
 *
 * Runs idempotent-ish: addItemsBulk upserts on (userId, normalizedName)
 * so re-running is safe but won't refresh quantities downward.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { users } from '../../db/schema.js';
import { addItemsBulk, type AddItemInput } from '../../services/inventory.js';
import {
  getGroceryProvider,
  GroceryProviderNotConnectedError,
} from '../../providers/grocery/index.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('pantry-seed');

export interface SeedResult {
  attemptedCount: number;
  insertedCount: number;
  skippedCount: number;
}

export async function seedPantryFromZepto(userId: string): Promise<SeedResult> {
  await setSeedStatus(userId, 'running');

  let provider;
  try {
    provider = await getGroceryProvider(userId);
  } catch (err) {
    if (err instanceof GroceryProviderNotConnectedError) {
      log.info('seed skipped: zepto not connected', { userId });
      await setSeedStatus(userId, 'idle');
      return { attemptedCount: 0, insertedCount: 0, skippedCount: 0 };
    }
    await setSeedStatus(userId, 'failed');
    throw err;
  }

  try {
    const items = await provider.pastOrderItems(userId);
    log.info(`seed candidates from zepto`, { userId, count: items.length });

    const inputs: AddItemInput[] = [];
    let skipped = 0;
    for (const it of items) {
      if (it.frequency < 2) {
        skipped++;
        continue;
      }
      inputs.push({
        userId,
        normalizedName: normalizeProductName(it.name).slice(0, 100),
        rawName: it.name.slice(0, 255),
        quantity: it.frequency >= 5 ? '1 unit' : '~0.5 unit',
        source: 'manual',
        confidence: it.frequency >= 5 ? 'high' : 'medium',
      });
    }

    if (inputs.length === 0) {
      await setSeedStatus(userId, 'done', 0);
      return { attemptedCount: items.length, insertedCount: 0, skippedCount: skipped };
    }

    const inserted = await addItemsBulk(inputs);
    log.info(`seed complete`, { userId, inserted: inserted.length, skipped });
    await setSeedStatus(userId, 'done', inserted.length);
    return {
      attemptedCount: items.length,
      insertedCount: inserted.length,
      skippedCount: skipped,
    };
  } catch (err) {
    await setSeedStatus(userId, 'failed');
    throw err;
  }
}

async function setSeedStatus(
  userId: string,
  status: 'idle' | 'running' | 'done' | 'failed',
  count?: number,
): Promise<void> {
  await db
    .update(users)
    .set({
      pantrySeedStatus: status,
      pantrySeedCount: count ?? null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

/**
 * Reduce a Zepto product name to a stable inventory key. Drops brand /
 * pack-size noise so "Amul Gold Milk 500ml" and "Amul Gold Milk 1L" both
 * collapse to "milk".
 *
 * Conservative heuristic — better to over-collapse than fragment the
 * pantry into 30 near-duplicate rows. The agent's free-form rename
 * tools can correct mis-collapses later.
 */
export function normalizeProductName(raw: string): string {
  let s = raw.toLowerCase();
  // Strip pack sizes ("500 ml", "1kg", "200g", "6 pc", "12 pieces")
  s = s.replace(
    /\b\d+(?:\.\d+)?\s*(ml|l|kg|g|gm|gms|grams?|pcs?|pieces?|pack|packs)\b/gi,
    '',
  );
  // Common brand prefixes; keep going if unmatched.
  const brands = [
    'amul', 'mother dairy', 'gowardhan', 'nestle', 'aashirvaad', 'fortune',
    'tata', 'patanjali', 'britannia', 'parle', 'haldiram', 'maggi',
    'mtr', 'everest', 'mdh', 'catch', 'kissan', 'sundrop', 'saffola',
    'fresho', 'farmley', 'farm fresh', 'happilo',
  ];
  for (const b of brands) {
    s = s.replace(new RegExp(`\\b${b}\\b`, 'g'), '');
  }
  // Collapse whitespace + trim
  s = s.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return s || raw.toLowerCase().trim();
}
