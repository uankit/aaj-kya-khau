/**
 * Tiny helpers for getMe + the public t.me link to the bot.
 * Cached at module scope — getMe never changes for a given token.
 */

import { env } from '../../config/env.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('telegram-bot-info');

let cachedUsername: string | null = null;

export async function resolveTelegramBotUsername(): Promise<string | null> {
  if (cachedUsername) return cachedUsername;
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`,
    );
    const json = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    cachedUsername = json.result?.username ?? null;
    return cachedUsername;
  } catch (err) {
    log.warn('resolveTelegramBotUsername failed', err);
    return null;
  }
}

/** Public deep link to the bot, suitable for emails or the landing page. */
export async function getTelegramBotUrl(): Promise<string | null> {
  const username = await resolveTelegramBotUsername();
  return username ? `https://t.me/${username}` : null;
}
