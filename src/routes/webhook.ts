/**
 * Telegram webhook.
 *
 * grammy's webhookCallback handles update parsing, signature verification
 * (via secret token header), and routing to our bot handlers. We register
 * bot handlers here for incoming messages, which then flow through the
 * same onboarding → agent pipeline as before.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { lt, sql } from 'drizzle-orm';
import { webhookCallback } from 'grammy';
import { env } from '../config/env.js';
import { db } from '../config/database.js';
import { webhookDedup } from '../db/schema.js';
import { bot, parseIncoming, sendText } from '../services/telegram.js';
import { getOrCreateUserByTelegramId } from '../services/user.js';
import { handleOnboardingMessage, sendCurrentPrompt } from '../onboarding/flow.js';
import { handleTurn } from '../agent/agent.js';
import { tryHandleCommand } from '../commands/handlers.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('webhook');

/**
 * Atomically claim a Telegram update_id. Returns true if we've never seen
 * this update before (caller should process), false if it's a duplicate.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING. Telegram is at-least-once delivery
 * and retries the webhook if we don't respond with 200 in time.
 */
async function claimUpdate(updateId: string): Promise<boolean> {
  const inserted = await db
    .insert(webhookDedup)
    .values({ messageSid: updateId })
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
    log.warn('Dedup cleanup failed (non-fatal)', err);
  }
}

/**
 * Register grammy message handlers. Every incoming update flows through
 * here → claimUpdate (dedup) → parseIncoming → onboarding or agent.
 *
 * We handle errors at this boundary so grammy can still 200-OK the webhook
 * response to Telegram (preventing retry storms).
 */
function registerBotHandlers(): void {
  // Matches text messages, PDF documents, or photos
  bot.on(['message:text', 'message:document', 'message:photo'], async (ctx) => {
    const incoming = parseIncoming(ctx);
    if (!incoming) return;

    // Dedup
    let claimed: boolean;
    try {
      claimed = await claimUpdate(incoming.updateId);
    } catch (err) {
      log.error('Dedup claim failed; proceeding without dedup', err);
      claimed = true;
    }
    if (!claimed) {
      log.info(`Ignoring duplicate update ${incoming.updateId}`);
      return;
    }

    cleanupOldDedupRows().catch(() => {});

    try {
      await processMessage(incoming);
    } catch (err) {
      log.error(`Unhandled error processing update from ${incoming.telegramId}`, err);
      try {
        await sendText(
          incoming.telegramId,
          'Sorry, something went wrong on my end. Please try again in a minute!',
        );
      } catch (sendErr) {
        log.error(`Even the fallback send failed for ${incoming.telegramId}`, sendErr);
      }
    }
  });

  // Anything else (stickers, locations, voice notes we don't yet parse) → ignore
}

async function processMessage(
  incoming: ReturnType<typeof parseIncoming> & object,
): Promise<void> {
  const { user, created } = await getOrCreateUserByTelegramId(incoming.telegramId);

  // Short-circuit specific slash commands (/start, /help, /mute, /feedback).
  // Everything else falls through — the LLM agent handles /hungry, /kitchen,
  // /ate, /today, /schedule, /profile via natural language + tool calls.
  const commandHandled = await tryHandleCommand(incoming.body, { user, created });
  if (commandHandled) return;

  if (!user.onboardingComplete) {
    if (created) {
      log.info(`New user ${user.telegramId} — sending welcome prompt`);
      await sendCurrentPrompt(user);
      return;
    }

    const finished = await handleOnboardingMessage(user, incoming.body);
    if (finished) {
      log.info(`User ${user.telegramId} just finished onboarding`);
    }
    return;
  }

  await handleTurn(user.id, {
    type: 'message',
    text: incoming.body,
    mediaItems: incoming.mediaItems,
  });
}

export async function webhookRoutes(app: FastifyInstance) {
  // Register the grammy handlers once at boot
  registerBotHandlers();

  // grammy's webhookCallback returns a function that takes (req, res).
  // We bridge it to Fastify by calling it from the Fastify handler.
  // The 'fastify' framework adapter handles all the req.body parsing.
  const handleGrammy = webhookCallback(bot, 'fastify', {
    secretToken: env.TELEGRAM_WEBHOOK_SECRET,
  });

  app.post('/webhook/telegram', async (request: FastifyRequest, reply: FastifyReply) => {
    await handleGrammy(request, reply);
  });
}
