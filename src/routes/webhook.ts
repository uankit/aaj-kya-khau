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
import { bot, parseIncoming, sendHtml, sendText, type IncomingMessage } from '../surfaces/telegram/index.js';
import { consumeBindToken, extractTelegramBindToken } from '../domain/identity/bind.js';
import { findUserByTelegramId } from '../services/user.js';
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

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const from = ctx.callbackQuery.from;
    const telegramId = from.id.toString();
    const updateId = ctx.update.update_id.toString();

    let claimed: boolean;
    try {
      claimed = await claimUpdate(updateId);
    } catch (err) {
      log.error('Callback dedup claim failed; proceeding without dedup', err);
      claimed = true;
    }
    if (!claimed) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }

    cleanupOldDedupRows().catch(() => {});

    try {
      const body = callbackDataToMessage(data);
      if (!body) {
        await ctx.answerCallbackQuery({ text: 'That action expired. Send me a message again?' });
        return;
      }

      await ctx.answerCallbackQuery();
      await processMessage({
        telegramId,
        chatId: ctx.callbackQuery.message?.chat.id ?? from.id,
        username: from.username,
        displayName: [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || undefined,
        body,
        updateId,
        mediaItems: [],
      });
    } catch (err) {
      log.error(`Unhandled callback error from ${telegramId}`, err);
      await ctx.answerCallbackQuery({ text: 'Something went wrong. Try again?' }).catch(() => {});
      await sendText(telegramId, 'Sorry, something went wrong on my end. Please try again in a minute!');
    }
  });

  // Anything else (stickers, locations, voice notes we don't yet parse) → ignore
}

function callbackDataToMessage(data: string): string | null {
  switch (data) {
    case 'cmd:hungry':
      return "I'm hungry";
    case 'cmd:kitchen':
      return '/kitchen';
    case 'cmd:today':
      return '/today';
    case 'cmd:schedule':
      return '/schedule';
    case 'onboard:diet:1':
      return '1';
    case 'onboard:diet:2':
      return '2';
    case 'onboard:diet:3':
      return '3';
    case 'onboard:diet:4':
      return '4';
    case 'onboard:skip':
      return 'skip';
    default:
      return null;
  }
}

function escapeUserName(name: string | null): string {
  return (name ?? 'there').replace(/[<>&]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;',
  );
}

async function processMessage(incoming: IncomingMessage): Promise<void> {
  // Web-first onboarding: /start <bind_token> binds an existing web-created
  // user to this Telegram chat. Try this BEFORE auto-creating a Telegram
  // user — once binding succeeds, the user already exists.
  const bindToken = extractTelegramBindToken(incoming.body);
  if (bindToken) {
    const result = await consumeBindToken(bindToken, incoming.telegramId);
    if (result) {
      const greeting = result.fresh
        ? `Hi ${escapeUserName(result.user.name)} 👋 You're all set on Telegram. What can I do?`
        : `Welcome back. Telegram is still bound to your account.`;
      await sendHtml(incoming.telegramId, greeting);
      return;
    }
    // Token failed — fall through to plain /start handling so users with a
    // typo / expired link still get a useful response.
  }

  const user = await findUserByTelegramId(incoming.telegramId);
  if (!user) {
    // No bind, no legacy account. Onboarding is web-first now.
    await sendHtml(
      incoming.telegramId,
      'Hi! I don\'t recognize this chat yet.\n\n' +
        'Sign up at <a href="https://aajkyakhaun.com/start">aajkyakhaun.com/start</a>, ' +
        'finish setup, then click the Telegram link at the end to connect this chat.',
    );
    return;
  }

  // Short-circuit specific slash commands (/start, /help, /mute, /feedback).
  // Everything else falls through to the LLM agent.
  const commandHandled = await tryHandleCommand(incoming.body, { user, created: false });
  if (commandHandled) return;

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
