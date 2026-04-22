/**
 * AES-256-GCM helpers for encrypting OAuth tokens at rest.
 *
 * Format: `<iv>.<ciphertext>.<authTag>`, each base64-encoded, dot-separated.
 * Fresh 12-byte IV per encryption. Authentication tag is verified on decrypt
 * — tampered ciphertext throws.
 *
 * Never log ciphertexts. Never return decrypted tokens from any agent tool
 * call. Decryption happens only inside the MCP adapter layer.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { env } from '../config/env.js';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey(): Buffer {
  if (!env.ENCRYPTION_KEY) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Required for OAuth token storage. ' +
        'Generate with: `openssl rand -base64 32`',
    );
  }
  return Buffer.from(env.ENCRYPTION_KEY, 'base64');
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${enc.toString('base64')}.${tag.toString('base64')}`;
}

export function decrypt(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format');
  }
  const [ivB64, encB64, tagB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}
