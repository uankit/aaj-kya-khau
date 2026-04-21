import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { users, type User } from '../db/schema.js';
import { env } from '../config/env.js';

export interface UserLookup {
  user: User;
  /** True if we just created this user (brand-new contact). */
  created: boolean;
}

/**
 * Fetches a user by Telegram id, or creates a blank onboarding row if they're new.
 *
 * Race-safe: uses INSERT ... ON CONFLICT DO NOTHING RETURNING so that two
 * concurrent webhook deliveries for the same user can't both try to insert
 * a row and have one crash with unique-constraint violation. If ON CONFLICT
 * fires (someone else inserted first), we fetch the existing row.
 */
export async function getOrCreateUserByTelegramId(telegramId: string): Promise<UserLookup> {
  // Atomic upsert-or-nothing. If the row already exists, returning() is empty.
  const inserted = await db
    .insert(users)
    .values({
      telegramId,
      timezone: env.DEFAULT_TIMEZONE,
      onboardingStep: 'ask_name',
      onboardingComplete: false,
    })
    .onConflictDoNothing({ target: users.telegramId })
    .returning();

  if (inserted.length > 0) {
    return { user: inserted[0]!, created: true };
  }

  // Row already existed — fetch it.
  const existing = await db.query.users.findFirst({
    where: eq(users.telegramId, telegramId),
  });
  if (!existing) {
    // Extremely unlikely — would require a DELETE between our INSERT check
    // and our SELECT. Treat as a real failure.
    throw new Error(`User ${telegramId} vanished between insert and select`);
  }
  return { user: existing, created: false };
}
