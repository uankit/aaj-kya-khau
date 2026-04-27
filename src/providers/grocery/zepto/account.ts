/**
 * Per-user Zepto account helpers.
 *
 * Fetches the user's connected Zepto account, decrypts the access token for
 * the caller, and refreshes it if it's expired. Decryption only happens here
 * — the agent tools never see ciphertext or keys.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../../../config/database.js';
import { env } from '../../../config/env.js';
import { connectedAccounts } from '../../../db/schema.js';
import { decrypt, encrypt } from '../../../utils/crypto.js';
import { ZEPTO, ZEPTO_MCP_RESOURCE } from './oauth.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('zepto-account');

/** Consider a token "about to expire" if it has <60s left. Trigger refresh. */
const EXPIRY_BUFFER_MS = 60_000;

async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}> {
  if (!env.ZEPTO_CLIENT_ID) throw new Error('ZEPTO_CLIENT_ID not set');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.ZEPTO_CLIENT_ID,
    refresh_token: refreshToken,
    resource: ZEPTO_MCP_RESOURCE,
  });

  const res = await fetch(ZEPTO.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Zepto refresh failed: ${res.status} ${text}`);
  }
  return (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
}

/**
 * Returns a valid access token for this user's Zepto account, refreshing
 * transparently if close to expiry. Returns null if the user hasn't
 * connected Zepto or the refresh grant fails.
 */
export async function getValidZeptoAccessToken(userId: string): Promise<string | null> {
  const [account] = await db
    .select()
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.userId, userId),
        eq(connectedAccounts.provider, 'zepto'),
        eq(connectedAccounts.status, 'active'),
      ),
    )
    .limit(1);

  if (!account) return null;

  const needsRefresh =
    account.tokenExpiresAt !== null &&
    account.tokenExpiresAt.getTime() - Date.now() < EXPIRY_BUFFER_MS;

  if (!needsRefresh) {
    try {
      return decrypt(account.accessTokenCiphertext);
    } catch (err) {
      log.error(`Token decrypt failed for user ${userId}`, err);
      return null;
    }
  }

  if (!account.refreshTokenCiphertext) {
    // No refresh token on file — user will have to re-connect
    await db
      .update(connectedAccounts)
      .set({ status: 'expired' })
      .where(eq(connectedAccounts.id, account.id));
    log.warn(`Zepto token expired for user ${userId}; no refresh token on file`);
    return null;
  }

  let refreshToken: string;
  try {
    refreshToken = decrypt(account.refreshTokenCiphertext);
  } catch (err) {
    log.error(`Refresh token decrypt failed for user ${userId}`, err);
    return null;
  }

  let newTokens;
  try {
    newTokens = await refreshAccessToken(refreshToken);
  } catch (err) {
    log.error(`Zepto refresh failed for user ${userId}`, err);
    await db
      .update(connectedAccounts)
      .set({ status: 'expired' })
      .where(eq(connectedAccounts.id, account.id));
    return null;
  }

  const newExpiresAt = newTokens.expires_in
    ? new Date(Date.now() + newTokens.expires_in * 1000)
    : null;

  await db
    .update(connectedAccounts)
    .set({
      accessTokenCiphertext: encrypt(newTokens.access_token),
      refreshTokenCiphertext: newTokens.refresh_token
        ? encrypt(newTokens.refresh_token)
        : account.refreshTokenCiphertext,
      tokenExpiresAt: newExpiresAt,
      scopes: newTokens.scope ?? account.scopes,
      status: 'active',
    })
    .where(eq(connectedAccounts.id, account.id));

  log.info(`Refreshed Zepto token for user ${userId}`);
  return newTokens.access_token;
}

export async function hasZeptoConnected(userId: string): Promise<boolean> {
  const [account] = await db
    .select({ id: connectedAccounts.id })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.userId, userId),
        eq(connectedAccounts.provider, 'zepto'),
        eq(connectedAccounts.status, 'active'),
      ),
    )
    .limit(1);
  return !!account;
}
