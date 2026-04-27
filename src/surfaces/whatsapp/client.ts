/**
 * Lazy-initialized Twilio client. Module-level singleton so we don't pay
 * the constructor cost on every send and so the user-friendly error path
 * is consistent: if Twilio creds are missing, sends throw with a clear
 * message rather than crashing on require().
 */

import twilio, { type Twilio } from 'twilio';
import { env } from '../../config/env.js';
import { SurfaceNotConfiguredError } from '../types.js';

let client: Twilio | null = null;

export function getTwilioClient(): Twilio {
  if (client) return client;
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    throw new SurfaceNotConfiguredError('whatsapp');
  }
  client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  return client;
}

/** "+91…" → "whatsapp:+91…". Idempotent — passes through if already prefixed. */
export function asWhatsAppAddress(e164: string): string {
  return e164.startsWith('whatsapp:') ? e164 : `whatsapp:${e164}`;
}

export function whatsAppFrom(): string {
  if (!env.TWILIO_WHATSAPP_FROM) throw new SurfaceNotConfiguredError('whatsapp');
  return asWhatsAppAddress(env.TWILIO_WHATSAPP_FROM);
}
