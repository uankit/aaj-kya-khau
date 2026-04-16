import twilio from 'twilio';
import { env } from '../config/env.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('whatsapp');

const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

export interface IncomingWhatsAppMessage {
  from: string; // E.164 phone number WITHOUT the 'whatsapp:' prefix
  rawFrom: string; // Original 'whatsapp:+91...' value
  body: string;
  messageSid: string;
  profileName?: string;
  numMedia: number;
  mediaItems: Array<{ url: string; contentType: string }>;
}

/** Parses a Twilio webhook form body into our normalized message shape. */
export function parseIncoming(body: Record<string, string | undefined>): IncomingWhatsAppMessage {
  const rawFrom = body.From ?? '';
  const from = rawFrom.replace(/^whatsapp:/, '');
  const numMedia = Number(body.NumMedia ?? '0') || 0;

  const mediaItems: Array<{ url: string; contentType: string }> = [];
  for (let i = 0; i < numMedia; i++) {
    const url = body[`MediaUrl${i}`];
    const contentType = body[`MediaContentType${i}`];
    if (url && contentType) mediaItems.push({ url, contentType });
  }

  return {
    from,
    rawFrom,
    body: body.Body ?? '',
    messageSid: body.MessageSid ?? '',
    profileName: body.ProfileName,
    numMedia,
    mediaItems,
  };
}

/** Sends a plain-text WhatsApp message. */
export async function sendText(toPhoneE164: string, text: string): Promise<void> {
  const to = toPhoneE164.startsWith('whatsapp:') ? toPhoneE164 : `whatsapp:${toPhoneE164}`;
  try {
    const msg = await client.messages.create({
      from: env.TWILIO_WHATSAPP_FROM,
      to,
      body: text,
    });
    log.debug(`Sent to ${to}`, { sid: msg.sid, chars: text.length });
  } catch (err) {
    log.error(`Failed to send to ${to}`, err);
    throw err;
  }
}

/**
 * Downloads a media file (e.g. PDF) from a Twilio media URL.
 * Twilio media URLs require HTTP Basic auth with your account credentials.
 */
export async function downloadMedia(mediaUrl: string): Promise<Buffer> {
  const authHeader =
    'Basic ' +
    Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');

  const response = await fetch(mediaUrl, {
    headers: { Authorization: authHeader },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Failed to download media: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Validates a Twilio webhook signature. Returns true if valid (or if validation
 * is disabled via env). We use Twilio's helper which handles the HMAC-SHA1 bit.
 */
export function validateSignature(params: {
  signature: string | undefined;
  url: string;
  body: Record<string, string | undefined>;
}): boolean {
  if (!env.TWILIO_WEBHOOK_VALIDATE) return true;
  if (!params.signature) return false;
  return twilio.validateRequest(
    env.TWILIO_AUTH_TOKEN,
    params.signature,
    params.url,
    params.body as Record<string, string>,
  );
}
