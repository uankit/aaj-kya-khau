/**
 * Surface binding — consume bind tokens minted on the web and resolve
 * incoming messages to a user.
 *
 * The web /api/me/bind/start endpoint mints a token and returns a deep
 * link. When the user opens that link and sends their first message
 * ("/start <token>" on Telegram), we look up + consume the token to bind
 * this chat to their existing web-onboarded user.
 */

import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../../config/database.js';
import {
  bindTokens,
  surfaceBindings,
  users,
  type Surface,
  type User,
} from '../../db/schema.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('identity-bind');

/** Pattern that Telegram '/start <token>' message bodies match. */
const TG_START_RE = /^\/start(?:@\w+)?(?:\s+(\S+))?$/i;

export function extractTelegramBindToken(text: string): string | null {
  const m = TG_START_RE.exec(text.trim());
  return m?.[1] ?? null;
}

export interface BindResult {
  user: User;
  surface: Surface;
  /** True if this surface was newly bound (vs already-bound user re-verifying). */
  fresh: boolean;
}

/**
 * Consume a bind token + record the surface binding. Atomic per token —
 * concurrent calls with the same token will see at most one succeed.
 *
 * Returns the user record, or null if the token is invalid / expired /
 * used / for a different surface than expected.
 */
export async function consumeBindToken(
  token: string,
  expectedSurface: Surface,
  externalId: string,
): Promise<BindResult | null> {
  // Step 1: claim the token. UPDATE ... RETURNING with conditions makes this
  // atomic — only the first caller wins.
  const [claimed] = await db
    .update(bindTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(bindTokens.token, token),
        eq(bindTokens.surface, expectedSurface),
        isNull(bindTokens.usedAt),
        gt(bindTokens.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!claimed) {
    log.warn(`bind token claim failed for surface=${expectedSurface}`, { token: token.slice(0, 4) });
    return null;
  }

  // Step 2: load user.
  const [user] = await db.select().from(users).where(eq(users.id, claimed.userId)).limit(1);
  if (!user) {
    log.error(`bind token referenced missing user`, { userId: claimed.userId });
    return null;
  }

  // Step 3: upsert surface_bindings. If this user already had a binding for
  // this surface (e.g. they re-bound), update the external_id to the new one.
  const existing = await db
    .select()
    .from(surfaceBindings)
    .where(
      and(eq(surfaceBindings.userId, user.id), eq(surfaceBindings.surface, expectedSurface)),
    )
    .limit(1);

  let fresh = true;
  if (existing.length > 0) {
    fresh = existing[0]!.externalId !== externalId;
    await db
      .update(surfaceBindings)
      .set({ externalId, boundAt: new Date() })
      .where(eq(surfaceBindings.id, existing[0]!.id));
  } else {
    await db.insert(surfaceBindings).values({
      userId: user.id,
      surface: expectedSurface,
      externalId,
    });
  }

  // Step 4: set primary_surface if user hasn't picked one. Set telegram_id
  // legacy column too so old code paths keep working during the migration.
  const updates: Partial<typeof users.$inferInsert> = {};
  if (!user.primarySurface) updates.primarySurface = expectedSurface;
  if (expectedSurface === 'telegram' && !user.telegramId) updates.telegramId = externalId;
  if (Object.keys(updates).length > 0) {
    updates.updatedAt = new Date();
    await db.update(users).set(updates).where(eq(users.id, user.id));
  }

  log.info(`bound surface=${expectedSurface} for user=${user.id} (fresh=${fresh})`);
  return { user, surface: expectedSurface, fresh };
}

/**
 * Resolve an inbound message's external_id to a user via surface_bindings.
 * Returns null if no binding exists — caller should redirect to web onboarding.
 */
export async function findUserBySurface(
  surface: Surface,
  externalId: string,
): Promise<User | null> {
  const [row] = await db
    .select({ user: users })
    .from(surfaceBindings)
    .innerJoin(users, eq(surfaceBindings.userId, users.id))
    .where(
      and(eq(surfaceBindings.surface, surface), eq(surfaceBindings.externalId, externalId)),
    )
    .limit(1);
  return row?.user ?? null;
}
