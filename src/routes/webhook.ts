import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';
import { parseIncoming, validateSignature, sendText } from '../services/whatsapp.js';
import { getOrCreateUserByPhone } from '../services/user.js';
import { handleOnboardingMessage, sendCurrentPrompt } from '../onboarding/flow.js';
import { handleTurn } from '../agent/agent.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('webhook');

// De-dup: Twilio occasionally redelivers the same MessageSid on network hiccups.
// Tracking recently-processed SIDs in a Set with a short TTL is enough for v1.
const recentSids = new Map<string, number>();
const SID_TTL_MS = 10 * 60 * 1000; // 10 minutes

function rememberSid(sid: string) {
  recentSids.set(sid, Date.now());
  // Cheap cleanup
  if (recentSids.size > 1000) {
    const cutoff = Date.now() - SID_TTL_MS;
    for (const [k, v] of recentSids) {
      if (v < cutoff) recentSids.delete(k);
    }
  }
}

function wasSeenRecently(sid: string): boolean {
  const ts = recentSids.get(sid);
  if (!ts) return false;
  if (Date.now() - ts > SID_TTL_MS) {
    recentSids.delete(sid);
    return false;
  }
  return true;
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

      // De-dup: Twilio may redeliver on retries.
      if (wasSeenRecently(incoming.messageSid)) {
        log.info(`Ignoring duplicate SID ${incoming.messageSid}`);
        return reply.code(200).send();
      }
      rememberSid(incoming.messageSid);

      // Reply 200 early so Twilio doesn't retry on any downstream error.
      reply.code(200).send();

      // Fire-and-forget the actual processing. We swallow errors to one
      // user-facing fallback message so Twilio stops retrying.
      processMessage(incoming).catch((err) => {
        log.error(`Failed to process message from ${incoming.from}`, err);
        sendText(
          incoming.from,
          "Sorry, something went wrong on my end. Please try again in a minute!",
        ).catch(() => {});
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
