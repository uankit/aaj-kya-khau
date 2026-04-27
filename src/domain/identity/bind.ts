/**
 * Telegram bind-token handling.
 *
 * The web /api/me/bind/start endpoint mints a token and returns a
 * https://t.me/<bot>?start=<token> link. When the user opens that link
 * and sends "/start <token>" to the bot, we look up + atomically claim
 * the token, set users.telegram_id, and welcome them.
 */

import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { bindTokens, users, type User } from '../../db/schema.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('identity-bind');

const TG_START_RE = /^\/start(?:@\w+)?(?:\s+(\S+))?$/i;

export function extractTelegramBindToken(text: string): string | null {
  const m = TG_START_RE.exec(text.trim());
  return m?.[1] ?? null;
}

export interface BindResult {
  user: User;
  /** True if telegram was newly bound; false if the user re-verified an existing binding. */
  fresh: boolean;
}

/**
 * Atomically consume a bind token and write users.telegram_id. Concurrent
 * calls with the same token will see at most one succeed.
 */
export async function consumeBindToken(
  token: string,
  telegramId: string,
): Promise<BindResult | null> {
  const [claimed] = await db
    .update(bindTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(bindTokens.token, token),
        isNull(bindTokens.usedAt),
        gt(bindTokens.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!claimed) {
    log.warn(`bind token claim failed`, { token: token.slice(0, 4) });
    return null;
  }

  const [user] = await db.select().from(users).where(eq(users.id, claimed.userId)).limit(1);
  if (!user) {
    log.error(`bind token referenced missing user`, { userId: claimed.userId });
    return null;
  }

  const fresh = user.telegramId !== telegramId;
  if (fresh) {
    await db
      .update(users)
      .set({ telegramId, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  }
  log.info(`telegram bound for user=${user.id} (fresh=${fresh})`);
  return { user: { ...user, telegramId }, fresh };
}
