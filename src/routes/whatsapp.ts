/**
 * WhatsApp inbound webhook (Twilio Cloud API).
 *
 * Mirror of the Telegram webhook flow:
 *   1. Validate Twilio signature (rejects forged requests)
 *   2. Parse the URL-encoded body
 *   3. Dedup by MessageSid via webhookDedup
 *   4. Hand off to processWhatsAppMessage (TODO: bind-token + agent routing
 *      lands once surface_bindings ships in Step 4)
 *
 * Twilio expects a 200 response with TwiML or empty body. We always
 * 200 quickly so Twilio doesn't retry; failures are logged.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { lt, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { env } from '../config/env.js';
import { webhookDedup } from '../db/schema.js';
import { whatsappAdapter } from '../surfaces/whatsapp/adapter.js';
import {
  parseTwilioWebhook,
  validateTwilioSignature,
  type WhatsAppInbound,
} from '../surfaces/whatsapp/inbound.js';
import {
  consumeBindToken,
  extractWhatsAppBindToken,
  findUserBySurface,
} from '../domain/identity/bind.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('webhook-whatsapp');

async function claimMessage(messageSid: string): Promise<boolean> {
  const inserted = await db
    .insert(webhookDedup)
    .values({ messageSid })
    .onConflictDoNothing({ target: webhookDedup.messageSid })
    .returning({ messageSid: webhookDedup.messageSid });
  return inserted.length > 0;
}

let lastDedupCleanupAt = 0;
const DEDUP_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
async function cleanupOldDedupRows(): Promise<void> {
  if (Date.now() - lastDedupCleanupAt < DEDUP_CLEANUP_INTERVAL_MS) return;
  lastDedupCleanupAt = Date.now();
  try {
    await db
      .delete(webhookDedup)
      .where(lt(webhookDedup.createdAt, sql`NOW() - INTERVAL '24 hours'`));
  } catch (err) {
    log.warn('WA dedup cleanup failed (non-fatal)', err);
  }
}

async function processWhatsAppMessage(msg: WhatsAppInbound): Promise<void> {
  log.info('inbound', {
    from: msg.from,
    text: msg.text.slice(0, 80),
    media: msg.numMedia,
  });

  // Web-first bind flow. If the message starts with "verify <token>", try
  // to consume the bind token and link this WhatsApp number to the user
  // who started onboarding on the web.
  const bindToken = extractWhatsAppBindToken(msg.text);
  if (bindToken) {
    const result = await consumeBindToken(bindToken, 'whatsapp', msg.from);
    if (result) {
      const name = result.user.name ?? 'there';
      try {
        await whatsappAdapter.send(msg.from, {
          kind: 'text',
          text: result.fresh
            ? `Hi ${name} 👋 You're all set on WhatsApp. What can I do?`
            : `Welcome back. WhatsApp is still bound to your account.`,
        });
      } catch (err) {
        log.error(`bind welcome send failed to ${msg.from}`, err);
      }
      return;
    }
    // Token failed — fall through so the user gets a useful nudge below.
  }

  // No bind token; resolve identity from existing surface binding.
  const user = await findUserBySurface('whatsapp', msg.from);
  if (!user) {
    try {
      await whatsappAdapter.send(msg.from, {
        kind: 'text',
        text:
          "Hi! I don't recognize this number yet.\n\n" +
          'Sign up first at https://aajkyakhaun.com/start, then click ' +
          'the WhatsApp link at the end of onboarding to connect.',
      });
    } catch (err) {
      log.error(`unknown-sender reply failed to ${msg.from}`, err);
    }
    return;
  }

  // Known user — placeholder echo until the agent loop is wired to surfaces
  // (multi-item workflow lands in Step 8). Swapping this for handleTurn()
  // is the one-line change that makes WhatsApp a first-class chat surface.
  try {
    await whatsappAdapter.send(msg.from, {
      kind: 'text',
      text: `Got it: "${msg.text.slice(0, 200)}"\n(agent integration coming next)`,
    });
  } catch (err) {
    log.error(`echo reply failed to ${msg.from}`, err);
  }
}

export async function whatsappRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/webhook/whatsapp',
    {
      // Twilio sends application/x-www-form-urlencoded; Fastify parses by
      // default. Disable rate limit on this route — Twilio retries are
      // policy-driven, not abusive.
      config: { rateLimit: false },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = (request.body ?? {}) as Record<string, string>;

      // Signature validation. Twilio computes signature over the absolute
      // URL it POSTed to + sorted form params. PUBLIC_BASE_URL must match
      // exactly what Twilio is configured to call.
      const signature = (request.headers['x-twilio-signature'] as string) ?? '';
      const url = `${env.PUBLIC_BASE_URL ?? `https://${request.headers.host}`}${request.url}`;
      const valid = validateTwilioSignature({ url, params, signature });
      if (!valid) {
        log.warn('rejected: invalid Twilio signature', { url, hasSig: !!signature });
        await reply.code(403).send('invalid signature');
        return;
      }

      const msg = parseTwilioWebhook(params);
      if (!msg.messageSid) {
        log.warn('rejected: missing MessageSid', { params: Object.keys(params) });
        await reply.code(400).send('missing MessageSid');
        return;
      }

      let claimed: boolean;
      try {
        claimed = await claimMessage(msg.messageSid);
      } catch (err) {
        log.error('dedup claim failed; proceeding', err);
        claimed = true;
      }
      if (!claimed) {
        log.info(`ignoring duplicate ${msg.messageSid}`);
        await reply.code(200).send('');
        return;
      }
      cleanupOldDedupRows().catch(() => {});

      // Process async-ish — we still return 200 quickly. Errors are logged.
      processWhatsAppMessage(msg).catch((err) => {
        log.error(`processWhatsAppMessage failed for ${msg.from}`, err);
      });

      await reply.code(200).send('');
    },
  );
}
