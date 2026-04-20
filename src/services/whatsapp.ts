import twilio from 'twilio';
import { env } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { withTimeout, retryWithBackoff } from '../utils/timeout.js';

const log = createLogger('whatsapp');

const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

// Hard ceilings on external calls so nothing can pin a DB connection forever.
const TWILIO_SEND_TIMEOUT_MS = 15_000;
const TWILIO_SEND_RETRY_ATTEMPTS = 3;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 15_000;

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

/**
 * Sends a plain-text WhatsApp message with:
 *   - per-attempt timeout (Twilio SDK doesn't take an AbortSignal, so we race)
 *   - exponential-backoff retry up to 3 attempts on transient failures
 *
 * If every attempt fails, we throw — the caller handles the user-facing fallback.
 */
export async function sendText(toPhoneE164: string, text: string): Promise<void> {
  const to = toPhoneE164.startsWith('whatsapp:') ? toPhoneE164 : `whatsapp:${toPhoneE164}`;

  // INFO-level logs around the send so we can see *in production* whether
  // Twilio accepted the message or the call hung/threw. Debug-level logs
  // are filtered out by LOG_LEVEL=info.
  log.info(`→ sending to ${to}`, { chars: text.length, from: env.TWILIO_WHATSAPP_FROM });
  const startedAt = Date.now();

  try {
    await retryWithBackoff(
      async () => {
        const msg = await withTimeout(
          client.messages.create({ from: env.TWILIO_WHATSAPP_FROM, to, body: text }),
          TWILIO_SEND_TIMEOUT_MS,
          `Twilio send to ${to}`,
        );
        log.info(`✓ sent to ${to}`, {
          sid: msg.sid,
          status: msg.status,
          elapsedMs: Date.now() - startedAt,
        });
      },
      TWILIO_SEND_RETRY_ATTEMPTS,
      `Twilio send to ${to}`,
    );
  } catch (err) {
    log.error(`✗ failed to send to ${to} after ${Date.now() - startedAt}ms`, err);
    throw err;
  }
}

/**
 * Downloads a media file (e.g. PDF) from a Twilio media URL.
 * Twilio media URLs require HTTP Basic auth with your account credentials.
 *
 * Bounded by MEDIA_DOWNLOAD_TIMEOUT_MS via AbortSignal — if the CDN stalls
 * we free the connection and bubble an error up to the agent, which responds
 * with a friendly "try resending" fallback instead of hanging forever.
 */
export async function downloadMedia(mediaUrl: string): Promise<Buffer> {
  const authHeader =
    'Basic ' +
    Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');

  const response = await fetch(mediaUrl, {
    headers: { Authorization: authHeader },
    redirect: 'follow',
    signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS),
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
