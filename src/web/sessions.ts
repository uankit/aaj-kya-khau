/**
 * Magic-link issuance + web session lifecycle.
 *
 * Magic links: random 32-byte token sent via email; consumed once on click,
 * then a separate web session is minted and the link expires.
 *
 * Sessions: random 32-byte token in a cookie. The DB only stores its
 * SHA-256 hash — DB compromise doesn't leak active session tokens.
 */

import { createHash, randomBytes } from 'crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../config/database.js';
import { magicLinkTokens, users, webSessions, type User } from '../db/schema.js';

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 min
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const SESSION_COOKIE = 'akk_session';

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────
// Magic links
// ─────────────────────────────────────────────────────────────────────────

export async function issueMagicLink(email: string): Promise<string> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);
  await db.insert(magicLinkTokens).values({
    token,
    email: email.toLowerCase().trim(),
    expiresAt,
  });
  return token;
}

/**
 * Consume a magic-link token. Returns the user (creating one if this is
 * the first time we've seen this email). Throws on invalid / expired /
 * already-used tokens.
 */
export async function consumeMagicLink(token: string): Promise<User> {
  const [row] = await db
    .select()
    .from(magicLinkTokens)
    .where(
      and(
        eq(magicLinkTokens.token, token),
        isNull(magicLinkTokens.usedAt),
        gt(magicLinkTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!row) throw new Error('invalid or expired magic link');

  // Mark used FIRST to make consumption atomic-ish even under concurrent clicks.
  const [used] = await db
    .update(magicLinkTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(magicLinkTokens.token, token), isNull(magicLinkTokens.usedAt)))
    .returning();
  if (!used) throw new Error('magic link already used');

  // Find-or-create user.
  let [user] = await db.select().from(users).where(eq(users.email, row.email)).limit(1);
  if (!user) {
    const [created] = await db
      .insert(users)
      .values({
        email: row.email,
        emailVerifiedAt: new Date(),
      })
      .returning();
    user = created;
  } else if (!user.emailVerifiedAt) {
    const [updated] = await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
    user = updated ?? user;
  }
  return user!;
}

// ─────────────────────────────────────────────────────────────────────────
// Web sessions
// ─────────────────────────────────────────────────────────────────────────

export interface SessionInfo {
  user: User;
  tokenHash: string;
  expiresAt: Date;
}

export async function issueSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(webSessions).values({
    tokenHash: sha256(token),
    userId,
    expiresAt,
  });
  return { token, expiresAt };
}

export async function loadSession(token: string): Promise<SessionInfo | null> {
  const tokenHash = sha256(token);
  const [row] = await db
    .select({ session: webSessions, user: users })
    .from(webSessions)
    .innerJoin(users, eq(webSessions.userId, users.id))
    .where(and(eq(webSessions.tokenHash, tokenHash), gt(webSessions.expiresAt, new Date())))
    .limit(1);
  if (!row) return null;
  // Touch lastSeen — best-effort.
  await db
    .update(webSessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(webSessions.tokenHash, tokenHash))
    .catch(() => {});
  return { user: row.user, tokenHash, expiresAt: row.session.expiresAt };
}

export async function destroySession(token: string): Promise<void> {
  await db.delete(webSessions).where(eq(webSessions.tokenHash, sha256(token)));
}
