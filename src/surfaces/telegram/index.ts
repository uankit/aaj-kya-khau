/**
 * Telegram transport — the single messaging backend for Aaj Kya Khaun.
 *
 * Uses `grammy` (modern TypeScript-first Telegram bot library). The bot is
 * registered as @aajkyakhaunbot via @BotFather; this module owns all
 * outbound + media-download operations for it.
 *
 * Incoming messages are handled by `src/routes/webhook.ts` which wires
 * grammy's `webhookCallback` into Fastify.
 */

import { Bot, type Context } from 'grammy';
import { env } from '../../config/env.js';
import { createLogger } from '../../utils/logger.js';
import { withTimeout, retryWithBackoff } from '../../utils/timeout.js';

const log = createLogger('telegram');

// Hard ceilings on external calls so nothing pins a DB connection forever.
const SEND_TIMEOUT_MS = 15_000;
const SEND_RETRY_ATTEMPTS = 3;
const FILE_DOWNLOAD_TIMEOUT_MS = 15_000;

export interface TelegramInlineButton {
  text: string;
  callbackData: string;
}

export type TelegramInlineKeyboard = TelegramInlineButton[][];

export interface SendMessageOptions {
  inlineKeyboard?: TelegramInlineKeyboard;
}

/**
 * The singleton bot. grammy's Bot class holds a Telegram API client under
 * the hood and optionally runs handlers. We use it in webhook mode —
 * grammy doesn't long-poll, we hand it HTTP requests via webhookCallback.
 */
export const bot = new Bot(env.TELEGRAM_BOT_TOKEN, {
  // grammy's HTTP client timeout — in addition to our withTimeout wrapper
  client: { timeoutSeconds: 15 },
});

// ─────────────────────────────────────────────
// Incoming message normalization
// ─────────────────────────────────────────────

export interface IncomingMessage {
  /** Telegram user id (bigint as string) */
  telegramId: string;
  /** Telegram chat id (usually same as user id for DMs) */
  chatId: number;
  /** Username if set (without @) */
  username?: string;
  /** Display name (first + last, best effort) */
  displayName?: string;
  /** Text body — empty string if the update wasn't a text message */
  body: string;
  /** Unique identifier for this update — used for dedup */
  updateId: string;
  /** Document / image attachments (if any) */
  mediaItems: Array<{ fileId: string; contentType: string; fileName?: string }>;
}

/** Converts a grammy Context into our normalized message shape. */
export function parseIncoming(ctx: Context): IncomingMessage | null {
  const message = ctx.message;
  if (!message) return null;

  const from = message.from;
  if (!from) return null;

  const telegramId = from.id.toString();
  const chatId = message.chat.id;
  const updateId = ctx.update.update_id.toString();

  const displayName =
    [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || undefined;

  // Text content: from text messages, or caption on media
  const body = message.text ?? message.caption ?? '';

  // Media: we care about documents (PDFs). Could extend to photos later.
  const mediaItems: IncomingMessage['mediaItems'] = [];
  if (message.document) {
    mediaItems.push({
      fileId: message.document.file_id,
      contentType: message.document.mime_type ?? 'application/octet-stream',
      fileName: message.document.file_name,
    });
  }

  return {
    telegramId,
    chatId,
    username: from.username,
    displayName,
    body,
    updateId,
    mediaItems,
  };
}

// ─────────────────────────────────────────────
// Outbound — send messages
// ─────────────────────────────────────────────

/**
 * Send a plain-text message to a Telegram user.
 *
 * `toTelegramId` is the recipient's Telegram user id (we store this in
 * `users.telegram_id`). Telegram's sendMessage API uses chat_id which for
 * DMs equals the user id — so we pass the same value as chat_id.
 *
 * Retries up to 3 times with exponential backoff on transient failures.
 */
function replyMarkup(options?: SendMessageOptions) {
  if (!options?.inlineKeyboard) return undefined;
  return {
    inline_keyboard: options.inlineKeyboard.map((row) =>
      row.map((button) => ({
        text: button.text,
        callback_data: button.callbackData,
      })),
    ),
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export async function sendText(
  toTelegramId: string,
  text: string,
  options?: SendMessageOptions,
): Promise<void> {
  log.info(`→ sending to ${toTelegramId}`, { chars: text.length });
  const startedAt = Date.now();

  try {
    await retryWithBackoff(
      async () => {
        const msg = await withTimeout(
          bot.api.sendMessage(toTelegramId, text, {
            reply_markup: replyMarkup(options),
          }),
          SEND_TIMEOUT_MS,
          `Telegram send to ${toTelegramId}`,
        );
        log.info(`✓ sent to ${toTelegramId}`, {
          messageId: msg.message_id,
          elapsedMs: Date.now() - startedAt,
        });
      },
      SEND_RETRY_ATTEMPTS,
      `Telegram send to ${toTelegramId}`,
    );
  } catch (err) {
    log.error(`✗ failed to send to ${toTelegramId} after ${Date.now() - startedAt}ms`, err);
    throw err;
  }
}

export async function sendHtml(
  toTelegramId: string,
  html: string,
  options?: SendMessageOptions,
): Promise<void> {
  log.info(`→ sending HTML to ${toTelegramId}`, { chars: html.length });
  const startedAt = Date.now();

  try {
    await retryWithBackoff(
      async () => {
        const msg = await withTimeout(
          bot.api.sendMessage(toTelegramId, html, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: replyMarkup(options),
          }),
          SEND_TIMEOUT_MS,
          `Telegram HTML send to ${toTelegramId}`,
        );
        log.info(`✓ sent HTML to ${toTelegramId}`, {
          messageId: msg.message_id,
          elapsedMs: Date.now() - startedAt,
        });
      },
      SEND_RETRY_ATTEMPTS,
      `Telegram HTML send to ${toTelegramId}`,
    );
  } catch (err) {
    log.warn(`HTML send failed for ${toTelegramId}; falling back to plain text`, err);
    await sendText(toTelegramId, stripHtml(html), options);
  }
}

// ─────────────────────────────────────────────
// Media download (PDF invoices etc.)
// ─────────────────────────────────────────────

/**
 * Downloads a file attachment by Telegram file_id.
 *
 * Two steps:
 *   1. getFile(file_id) → returns file_path
 *   2. GET https://api.telegram.org/file/bot<token>/<file_path> → bytes
 *
 * Bounded by FILE_DOWNLOAD_TIMEOUT_MS.
 */
export async function downloadMedia(fileId: string): Promise<Buffer> {
  const file = await withTimeout(
    bot.api.getFile(fileId),
    SEND_TIMEOUT_MS,
    `getFile ${fileId}`,
  );

  if (!file.file_path) {
    throw new Error(`Telegram getFile returned no file_path for ${fileId}`);
  }

  const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Failed to download media: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
