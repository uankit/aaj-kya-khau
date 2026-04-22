/**
 * Zepto OAuth (RFC 6749 authorization code + RFC 7636 PKCE).
 *
 * Server metadata (discovered via `/.well-known/oauth-authorization-server`
 * on auth.zepto.co.in):
 *   - issuer: https://auth.zepto.co.in
 *   - authorization_endpoint: https://auth.zepto.co.in/authorize
 *   - token_endpoint: https://auth.zepto.co.in/token
 *   - response_types: ["code"]
 *   - grant_types: ["authorization_code", "refresh_token"]
 *   - code_challenge_methods: ["S256"]
 *   - token_endpoint_auth_methods: ["none"]   ← public client, no secret
 *
 * Public client with PKCE — no client_secret to ship. The client_id itself
 * comes from one-time dynamic client registration (see scripts/register-zepto-client.ts).
 */

import { createHash, randomBytes } from 'crypto';

export const ZEPTO = {
  authorizationEndpoint: 'https://auth.zepto.co.in/authorize',
  tokenEndpoint: 'https://auth.zepto.co.in/token',
  registrationEndpoint: 'https://auth.zepto.co.in/register',
  scopes: ['tools:read', 'tools:write'] as const,
} as const;

/**
 * Postman's public OAuth relay page. Displays the auth code for the user to
 * copy back. We use this because Zepto's registration server whitelists only
 * a small set of redirect domains (localhost, oauth.pstmn.io, claude.ai,
 * vscode.dev). Our Railway domain is not yet on the list — pending a
 * whitelist request. When it is, swap this out for `${PUBLIC_BASE_URL}/oauth/
 * zepto/callback` and the existing /oauth/zepto/callback route takes over
 * (no copy-paste).
 */
export const ZEPTO_POSTMAN_REDIRECT = 'https://oauth.pstmn.io/v1/callback';

/** Base64url-encode (no padding). RFC 4648 §5. */
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/** Generate a PKCE verifier (43 chars) and its S256 challenge. */
export function generatePkce(): PkcePair {
  const codeVerifier = b64url(randomBytes(32));
  const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

/** Random 32-byte hex string used as the OAuth `state` param + DB PK. */
export function generateState(): string {
  return randomBytes(32).toString('hex');
}

/** Build the URL the user opens to begin the Zepto consent flow. */
export function buildAuthorizationUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(ZEPTO.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', ZEPTO.scopes.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface ZeptoTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/** Exchange authorization code for access + refresh tokens. */
export async function exchangeCodeForTokens(params: {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<ZeptoTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: params.clientId,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });

  const response = await fetch(ZEPTO.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Zepto token exchange failed: ${response.status} ${text}`);
  }

  return (await response.json()) as ZeptoTokenResponse;
}
