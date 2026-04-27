/**
 * WhatsApp inbound — Twilio webhook parsing + signature validation.
 *
 * Twilio POSTs an `application/x-www-form-urlencoded` body. The signature
 * lives in `X-Twilio-Signature` and is computed over the absolute URL +
 * sorted POST params using the auth token. We validate it on every inbound
 * unless TWILIO_WEBHOOK_VALIDATE=false (local dev).
 *
 * The parsed shape mirrors the inbound interface we'll need from Telegram
 * once bind tokens land — `from` (the user's WhatsApp number, used to look
 * up surface_bindings) and `text` (their message). Media support is
 * scaffolded (NumMedia / MediaUrl0…) but not yet exposed.
 */

import twilio from 'twilio';
import { env } from '../../config/env.js';

export interface WhatsAppInbound {
  /** Twilio message SID — use for dedup. */
  messageSid: string;
  /** E.164 number with "whatsapp:" prefix. We strip the prefix here. */
  from: string;
  /** Bot's WhatsApp address (also stripped of prefix). */
  to: string;
  /** Message body (empty if media-only). */
  text: string;
  /** Number of media attachments. */
  numMedia: number;
  /** First media URL if any. (Caller can fetch additional via raw indexes if needed.) */
  mediaUrl?: string;
  mediaContentType?: string;
}

export function parseTwilioWebhook(body: Record<string, string>): WhatsAppInbound {
  const stripWa = (s: string): string => s.replace(/^whatsapp:/i, '');
  const numMedia = parseInt(body.NumMedia ?? '0', 10) || 0;
  return {
    messageSid: body.MessageSid ?? body.SmsMessageSid ?? '',
    from: stripWa(body.From ?? ''),
    to: stripWa(body.To ?? ''),
    text: body.Body ?? '',
    numMedia,
    mediaUrl: numMedia > 0 ? body.MediaUrl0 : undefined,
    mediaContentType: numMedia > 0 ? body.MediaContentType0 : undefined,
  };
}

/**
 * Verify Twilio's request signature. Returns true if valid (or validation
 * is disabled by env). Caller should 403 on false.
 */
export function validateTwilioSignature(opts: {
  url: string;
  params: Record<string, string>;
  signature: string;
}): boolean {
  if (!env.TWILIO_WEBHOOK_VALIDATE) return true;
  if (!env.TWILIO_AUTH_TOKEN) return false;
  return twilio.validateRequest(env.TWILIO_AUTH_TOKEN, opts.signature, opts.url, opts.params);
}
