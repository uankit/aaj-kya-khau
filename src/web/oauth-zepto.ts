/**
 * Web OAuth flow for Zepto.
 *
 * Until Zepto whitelists our production callback, we use the Postman
 * OAuth relay as redirect_uri. Flow:
 *
 *   1. POST /api/oauth/zepto/start
 *      → mints PKCE + state, stashes in oauth_pending_states keyed to user
 *      → returns { authUrl } pointing at Zepto with Postman as redirect
 *
 *   2. User opens authUrl in a new tab, authenticates with Zepto, sees a
 *      code on the Postman relay page, copies it.
 *
 *   3. POST /api/oauth/zepto/finish { code }
 *      → looks up the pending state, exchanges code+verifier for tokens
 *      → encrypts and persists into connected_accounts
 *      → returns { connected: true }
 *
 * No state-in-URL because the user is already authenticated by web cookie;
 * the pending state is keyed by user_id and times out after 10 min.
 */

import type { FastifyInstance } from 'fastify';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../config/database.js';
import { env } from '../config/env.js';
import { connectedAccounts, oauthPendingStates } from '../db/schema.js';
import { encrypt } from '../utils/crypto.js';
import {
  ZEPTO_POSTMAN_REDIRECT,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generatePkce,
  generateState,
} from '../providers/grocery/zepto/oauth.js';
import { createLogger } from '../utils/logger.js';
import { requireAuth } from './auth-middleware.js';

const log = createLogger('web-oauth-zepto');

const STATE_TTL_MS = 10 * 60 * 1000;

const finishSchema = z.object({
  code: z.string().min(8).max(1024),
});

export async function zeptoOAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/oauth/zepto/start', { preHandler: requireAuth }, async (request, reply) => {
    if (!env.ZEPTO_CLIENT_ID) return reply.code(500).send({ error: 'zepto_not_configured' });
    const u = request.user!;
    const pkce = generatePkce();
    const state = generateState();

    // Clear any prior pending state for this user — only one OAuth in flight at a time.
    await db.delete(oauthPendingStates).where(eq(oauthPendingStates.userId, u.id));
    await db.insert(oauthPendingStates).values({
      userId: u.id,
      provider: 'zepto',
      codeVerifier: pkce.codeVerifier,
      state,
    });

    const authUrl = buildAuthorizationUrl({
      clientId: env.ZEPTO_CLIENT_ID,
      redirectUri: ZEPTO_POSTMAN_REDIRECT,
      state,
      codeChallenge: pkce.codeChallenge,
    });

    log.info(`zepto auth URL issued for user=${u.id}`);
    return reply.send({ authUrl });
  });

  app.post('/api/oauth/zepto/finish', { preHandler: requireAuth }, async (request, reply) => {
    if (!env.ZEPTO_CLIENT_ID) return reply.code(500).send({ error: 'zepto_not_configured' });
    const parsed = finishSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_code' });
    const u = request.user!;

    const cutoff = new Date(Date.now() - STATE_TTL_MS);
    const [pending] = await db
      .select()
      .from(oauthPendingStates)
      .where(
        and(
          eq(oauthPendingStates.userId, u.id),
          eq(oauthPendingStates.provider, 'zepto'),
          gt(oauthPendingStates.createdAt, cutoff),
        ),
      )
      .limit(1);
    if (!pending) {
      return reply.code(400).send({ error: 'no_pending_oauth_or_expired' });
    }

    let tokens;
    try {
      tokens = await exchangeCodeForTokens({
        clientId: env.ZEPTO_CLIENT_ID,
        code: parsed.data.code.trim(),
        redirectUri: ZEPTO_POSTMAN_REDIRECT,
        codeVerifier: pending.codeVerifier,
      });
    } catch (err) {
      log.warn(`zepto exchange failed for user=${u.id}`, err);
      return reply.code(400).send({ error: 'exchange_failed' });
    }

    const accessCipher = encrypt(tokens.access_token);
    const refreshCipher = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null;

    // Upsert: one row per (user, provider).
    const existing = await db
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, u.id), eq(connectedAccounts.provider, 'zepto')))
      .limit(1);
    if (existing.length > 0) {
      await db
        .update(connectedAccounts)
        .set({
          accessTokenCiphertext: accessCipher,
          refreshTokenCiphertext: refreshCipher,
          tokenExpiresAt: expiresAt,
          status: 'active',
          scopes: tokens.scope ?? null,
          connectedAt: new Date(),
        })
        .where(eq(connectedAccounts.id, existing[0]!.id));
    } else {
      await db.insert(connectedAccounts).values({
        userId: u.id,
        provider: 'zepto',
        accessTokenCiphertext: accessCipher,
        refreshTokenCiphertext: refreshCipher,
        tokenExpiresAt: expiresAt,
        status: 'active',
        scopes: tokens.scope ?? null,
      });
    }

    await db.delete(oauthPendingStates).where(eq(oauthPendingStates.userId, u.id));

    log.info(`zepto connected for user=${u.id}`);
    return reply.send({ connected: true });
  });
}
