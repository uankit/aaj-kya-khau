import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../config/database.js';
import { webhookDedup } from '../db/schema.js';
import { parseIncoming, validateSignature, sendText } from '../services/whatsapp.js';
import { getOrCreateUserByPhone } from '../services/user.js';
import { handleOnboardingMessage, sendCurrentPrompt } from '../onboarding/flow.js';
import { handleTurn } from '../agent/agent.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('webhook');

/**
 * Atomically claim a Twilio MessageSid. Returns true if we've never seen
 * this SID before (caller should process), false if it's a duplicate.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING so the DB gives us true atomic
 * check-and-claim. Unlike the previous in-memory Map, this survives
 * restarts and races (two concurrent webhook workers can both arrive at
 * the "is this new?" question; exactly one will get the insert).
 */
async function claimSid(messageSid: string): Promise<boolean> {
  const inserted = await db
    .insert(webhookDedup)
    .values({ messageSid })
    .onConflictDoNothing({ target: webhookDedup.messageSid })
    .returning({ messageSid: webhookDedup.messageSid });
  return inserted.length > 0;
}

/**
 * Periodic cleanup of rows older than 24h. We do this opportunistically
 * from the webhook handler itself (low volume, fire-and-forget).
 */
let lastDedupCleanupAt = 0;
const DEDUP_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async function cleanupOldDedupRows(): Promise<void> {
  if (Date.now() - lastDedupCleanupAt < DEDUP_CLEANUP_INTERVAL_MS) return;
  lastDedupCleanupAt = Date.now();
  try {
    await db.execute(
      sql`DELETE FROM ${webhookDedup} WHERE ${webhookDedup.createdAt} < NOW() - INTERVAL '24 hours'`,
    );
  } catch (err) {
    log.warn('Dedup cleanup failed (non-fatal)', err);
  }
}

export async function webhookRoutes(app: FastifyInstance) {
  app.post(
    '/webhook/whatsapp',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = (request.body ?? {}) as Record<string, string | undefined>;

      // Signature validation: reconstruct the full URL Twilio signed against.
      const url =
        (env.PUBLIC_BASE_URL ?? `${request.protocol}://${request.hostname}`) +
        request.url;
      const signature = request.headers['x-twilio-signature'] as string | undefined;

      const valid = validateSignature({ signature, url, body });
      if (!valid) {
        log.warn('Invalid Twilio signature', { url });
        return reply.code(403).send({ error: 'invalid signature' });
      }

      const incoming = parseIncoming(body);
      if (!incoming.from || !incoming.messageSid) {
        return reply.code(400).send({ error: 'missing From or MessageSid' });
      }

      // Atomic dedup: if another worker already claimed this SID (or an
      // earlier retry already processed it), bail with a 200 so Twilio
      // stops retrying. Must happen BEFORE sending 200 so we can cleanly
      // short-circuit retries without processing twice.
      let claimed: boolean;
      try {
        claimed = await claimSid(incoming.messageSid);
      } catch (err) {
        // If the DB is down we'd rather accept a possible duplicate than
        // return 5xx and have Twilio retry forever.
        log.error('Dedup claim failed; proceeding without dedup', err);
        claimed = true;
      }

      if (!claimed) {
        log.info(`Ignoring duplicate SID ${incoming.messageSid}`);
        return reply.code(200).send();
      }

      // Reply 200 early so Twilio doesn't retry on any downstream error.
      reply.code(200).send();

      // Opportunistic cleanup (fire-and-forget)
      cleanupOldDedupRows().catch(() => {});

      // Fire-and-forget the actual processing. If processing throws, the
      // agent handler itself sends a fallback message and persists it —
      // the outer catch here is just for *truly* unexpected errors that
      // escape even that. Log loudly so we know something's very wrong.
      processMessage(incoming).catch(async (err) => {
        log.error(`Unhandled error processing message from ${incoming.from}`, err);
        try {
          await sendText(
            incoming.from,
            'Sorry, something went wrong on my end. Please try again in a minute!',
          );
        } catch (sendErr) {
          log.error(`Even the fallback send failed for ${incoming.from}`, sendErr);
        }
      });
    },
  );
}

async function processMessage(
  incoming: ReturnType<typeof parseIncoming>,
): Promise<void> {
  const { user, created } = await getOrCreateUserByPhone(incoming.from);

  if (!user.onboardingComplete) {
    // Brand-new user: don't treat their first message ("hi"/"hello") as the
    // answer to "what's your name?". Send the welcome prompt and wait for
    // their next message to be the actual answer.
    if (created) {
      log.info(`New user ${user.phone} — sending welcome prompt`);
      await sendCurrentPrompt(user);
      return;
    }

    // Existing onboarding-in-progress user: process their answer.
    const finished = await handleOnboardingMessage(user, incoming.body);
    if (finished) {
      log.info(`User ${user.phone} just finished onboarding`);
    }
    return;
  }

  // Post-onboarding: dispatch to the LLM agent.
  await handleTurn(user.id, {
    type: 'message',
    text: incoming.body,
    mediaItems: incoming.mediaItems,
  });
}
