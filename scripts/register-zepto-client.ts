/**
 * One-shot RFC 7591 Dynamic Client Registration against Zepto's auth server.
 *
 * Run: `npm run zepto:register-client` (requires PUBLIC_BASE_URL in env).
 * Copy the printed client_id + registration_access_token into .env.
 *
 * Safe to re-run — each invocation creates a NEW client. If you register
 * twice, clean up the old one via:
 *   curl -X DELETE https://auth.zepto.co.in/api/register/<old_client_id> \
 *        -H "Authorization: Bearer <old_registration_access_token>"
 */

import 'dotenv/config';

import { ZEPTO, ZEPTO_POSTMAN_REDIRECT } from '../src/providers/grocery/zepto/oauth.js';

// Two modes:
//   --postman        → register with Postman's OAuth relay as redirect URI
//                      (use this today; pairs with the /zepto_code paste flow)
//   (default)        → use PUBLIC_BASE_URL/oauth/zepto/callback
//                      (only works once that domain is on Zepto's whitelist)
const usePostman = process.argv.includes('--postman');

let redirectUri: string;
if (usePostman) {
  redirectUri = ZEPTO_POSTMAN_REDIRECT;
} else {
  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
  if (!PUBLIC_BASE_URL) {
    console.error('❌ PUBLIC_BASE_URL not set. Add it to .env first, or pass --postman.');
    process.exit(1);
  }
  redirectUri = `${PUBLIC_BASE_URL.replace(/\/+$/, '')}/oauth/zepto/callback`;
}

const payload = {
  client_name: 'Aaj Kya Khaun',
  redirect_uris: [redirectUri],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

console.log(`Registering Zepto OAuth client…`);
console.log(`  redirect_uri: ${redirectUri}`);

const res = await fetch(ZEPTO.registrationEndpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

if (!res.ok) {
  const text = await res.text().catch(() => '');
  console.error(`❌ Registration failed: ${res.status} ${text}`);
  process.exit(1);
}

const data = (await res.json()) as {
  client_id: string;
  registration_access_token?: string;
  registration_client_uri?: string;
};

console.log(`\n✅ Registered.\n`);
console.log(`Add these to your .env (and Railway dashboard):\n`);
console.log(`ZEPTO_CLIENT_ID=${data.client_id}`);
if (data.registration_access_token) {
  console.log(`ZEPTO_REGISTRATION_ACCESS_TOKEN=${data.registration_access_token}`);
}
if (data.registration_client_uri) {
  console.log(`\n(Client management URL: ${data.registration_client_uri})`);
}
