/**
 * OAuth routes for linking external grocery accounts.
 *
 * Flow:
 *   1. User taps /connect_zepto in Telegram → bot sends a one-time signed
 *      link to `/oauth/zepto/start?t=<token>`.
 *   2. `/oauth/zepto/start` verifies the token, generates PKCE + state,
 *      persists them to `oauth_pending_states`, redirects to Zepto.
 *   3. Zepto redirects back to `/oauth/zepto/callback?code=...&state=...`.
 *   4. Callback looks up the state, exchanges the code for tokens via PKCE,
 *      encrypts tokens, upserts into `connected_accounts`, DMs the user a
 *      success message, and redirects them back to the bot.
 *
 * The signed token (step 1) binds the OAuth flow to a specific user id +
 * expiry. HMAC is keyed off TELEGRAM_WEBHOOK_SECRET so no new secret to
 * manage. 10-minute TTL — a leaked link stops working fast.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import { and, eq, lt, sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../config/database.js';
import {
  connectedAccounts,
  oauthPendingStates,
  users,
} from '../db/schema.js';
import { encrypt } from '../utils/crypto.js';
import { sendHtml } from '../surfaces/telegram/index.js';
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generatePkce,
  generateState,
} from '../providers/grocery/zepto/oauth.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('oauth');

const LINK_TTL_MS = 10 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;
const BOT_DEEPLINK = 'https://t.me/aajkyakhaunbot';

/**
 * Sign a Telegram-to-web handoff token: `<userId>.<expiryMs>.<hmac>`.
 * Verifies on /oauth/.../start so the browser flow can't be initiated for
 * another user's account just by editing the URL.
 */
export function signHandoffToken(userId: string): string {
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET required to sign OAuth handoff tokens');
  }
  const expiry = Date.now() + LINK_TTL_MS;
  const payload = `${userId}.${expiry}`;
  const sig = createHmac('sha256', env.TELEGRAM_WEBHOOK_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyHandoffToken(token: string): { userId: string } | null {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expiryStr, sig] = parts as [string, string, string];
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return null;
  const expected = createHmac('sha256', env.TELEGRAM_WEBHOOK_SECRET)
    .update(`${userId}.${expiryStr}`)
    .digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  return { userId };
}

function redirectUri(): string {
  if (!env.PUBLIC_BASE_URL) {
    throw new Error('PUBLIC_BASE_URL required for OAuth callback URL');
  }
  return `${env.PUBLIC_BASE_URL}/oauth/zepto/callback`;
}

/** Lightweight HTML page for the final redirect-back-to-bot step. */
function redirectPage(message: string, deeplink: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Aaj Kya Khaun</title>
<meta http-equiv="refresh" content="2; url=${deeplink}">
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;text-align:center;color:#222}
a.btn{display:inline-block;margin-top:24px;padding:12px 24px;background:#0088cc;color:#fff;border-radius:8px;text-decoration:none}</style>
</head><body><h2>${message}</h2><p>Returning to the bot…</p><a class="btn" href="${deeplink}">Open Telegram</a></body></html>`;
}

async function pruneOldPendingStates(): Promise<void> {
  try {
    await db
      .delete(oauthPendingStates)
      .where(lt(oauthPendingStates.createdAt, sql`NOW() - INTERVAL '1 hour'`));
  } catch (err) {
    log.warn('oauth_pending_states prune failed (non-fatal)', err);
  }
}

export async function oauthRoutes(app: FastifyInstance) {
  /* ---------------- Zepto: start ---------------- */

  app.get(
    '/oauth/zepto/start',
    async (req: FastifyRequest<{ Querystring: { t?: string } }>, reply: FastifyReply) => {
      const token = req.query.t;
      if (!token) return reply.code(400).send('Missing token');
      const verified = verifyHandoffToken(token);
      if (!verified) return reply.code(401).send('Link expired or invalid. Try /connect_zepto again.');

      if (!env.ZEPTO_CLIENT_ID) {
        log.error('ZEPTO_CLIENT_ID not set — cannot start OAuth');
        return reply.code(503).send('Zepto integration not configured yet. Please try again later.');
      }

      // Confirm the user exists (defensive — handoff token could outlive the user)
      const [user] = await db.select().from(users).where(eq(users.id, verified.userId)).limit(1);
      if (!user) return reply.code(404).send('User not found');

      const { codeVerifier, codeChallenge } = generatePkce();
      const state = generateState();

      await db.insert(oauthPendingStates).values({
        state,
        userId: user.id,
        provider: 'zepto',
        codeVerifier,
      });
      void pruneOldPendingStates();

      const authUrl = buildAuthorizationUrl({
        clientId: env.ZEPTO_CLIENT_ID,
        redirectUri: redirectUri(),
        state,
        codeChallenge,
      });

      log.info(`Starting Zepto OAuth for user ${user.id}`);
      return reply.redirect(authUrl);
    },
  );

  /* ---------------- Zepto: callback ---------------- */

  app.get(
    '/oauth/zepto/callback',
    async (
      req: FastifyRequest<{
        Querystring: { code?: string; state?: string; error?: string; error_description?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { code, state, error, error_description } = req.query;

      if (error) {
        log.warn(`Zepto OAuth returned error: ${error} - ${error_description ?? ''}`);
        return reply
          .type('text/html; charset=utf-8')
          .send(redirectPage(`Zepto connection cancelled`, BOT_DEEPLINK));
      }
      if (!code || !state) return reply.code(400).send('Missing code or state');

      // Atomically consume the pending state — single-use.
      const [pending] = await db
        .delete(oauthPendingStates)
        .where(
          and(
            eq(oauthPendingStates.state, state),
            eq(oauthPendingStates.provider, 'zepto'),
          ),
        )
        .returning();

      if (!pending) return reply.code(400).send('Invalid or expired state');
      if (Date.now() - pending.createdAt.getTime() > STATE_TTL_MS) {
        return reply.code(400).send('State expired. Please restart the flow.');
      }
      if (!env.ZEPTO_CLIENT_ID) return reply.code(503).send('Zepto integration not configured');

      // Exchange code → tokens
      let tokens;
      try {
        tokens = await exchangeCodeForTokens({
          clientId: env.ZEPTO_CLIENT_ID,
          code,
          redirectUri: redirectUri(),
          codeVerifier: pending.codeVerifier,
        });
      } catch (err) {
        log.error(`Token exchange failed for user ${pending.userId}`, err);
        return reply.code(502).send('Failed to complete Zepto connection. Please try again.');
      }

      // Encrypt + upsert
      const accessCt = encrypt(tokens.access_token);
      const refreshCt = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;
      const expiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : null;

      await db
        .insert(connectedAccounts)
        .values({
          userId: pending.userId,
          provider: 'zepto',
          accessTokenCiphertext: accessCt,
          refreshTokenCiphertext: refreshCt,
          tokenExpiresAt: expiresAt,
          scopes: tokens.scope ?? null,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: [connectedAccounts.userId, connectedAccounts.provider],
          set: {
            accessTokenCiphertext: accessCt,
            refreshTokenCiphertext: refreshCt,
            tokenExpiresAt: expiresAt,
            scopes: tokens.scope ?? null,
            status: 'active',
            connectedAt: new Date(),
          },
        });

      // Confirm via the bot (don't let a failed DM block the browser redirect)
      const [user] = await db.select().from(users).where(eq(users.id, pending.userId)).limit(1);
      if (user) {
        sendHtml(
          user.telegramId,
          `✅ <b>Zepto connected!</b>\n\nNow I can help with cravings and missing ingredients straight from chat.\n\nTry: <code>I'm craving Bournville</code>`,
        ).catch((err) => log.warn(`Post-connect DM failed for ${user.telegramId}`, err));
      }

      log.info(`Zepto connected for user ${pending.userId}`);
      return reply
        .type('text/html; charset=utf-8')
        .send(redirectPage('✅ Zepto connected!', BOT_DEEPLINK));
    },
  );
}
