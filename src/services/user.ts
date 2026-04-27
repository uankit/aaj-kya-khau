import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { users, type User } from '../db/schema.js';

/**
 * Look up a user by their Telegram id. Returns null if no user has bound
 * Telegram yet — onboarding now happens on the web, so unknown senders
 * get redirected there rather than auto-created.
 *
 * The legacy auto-create flow is gone as of the web-first migration. Users
 * created before the migration still resolve here normally — their
 * telegram_id column is unchanged.
 */
export async function findUserByTelegramId(telegramId: string): Promise<User | null> {
  const row = await db.query.users.findFirst({
    where: eq(users.telegramId, telegramId),
  });
  return row ?? null;
}
