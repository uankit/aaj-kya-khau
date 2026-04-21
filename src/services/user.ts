import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { users, type User } from '../db/schema.js';
import { env } from '../config/env.js';

export interface UserLookup {
  user: User;
  /** True if we just created this user (brand-new contact). */
  created: boolean;
}

/** Fetches a user by Telegram id, or creates a blank onboarding row if they're new. */
export async function getOrCreateUserByTelegramId(telegramId: string): Promise<UserLookup> {
  const existing = await db.query.users.findFirst({
    where: eq(users.telegramId, telegramId),
  });
  if (existing) return { user: existing, created: false };

  const [created] = await db
    .insert(users)
    .values({
      telegramId,
      timezone: env.DEFAULT_TIMEZONE,
      onboardingStep: 'ask_name',
      onboardingComplete: false,
    })
    .returning();
  if (!created) throw new Error('Failed to create user');
  return { user: created, created: true };
}
