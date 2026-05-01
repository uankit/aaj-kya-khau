/**
 * Slash-command short-circuits.
 *
 * A few commands need deterministic behavior (exact same response every time,
 * regardless of what the LLM feels like). Those are handled here, before the
 * agent ever sees the message. Everything else (including /hungry, /kitchen,
 * /ate, /today, /schedule, /profile) falls through to the agent, which
 * interprets them naturally via tool calls.
 *
 * Design principle: intercept only what the LLM might be inconsistent about.
 * Keep the agent in charge of anything that benefits from LLM intelligence.
 */

import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { userSchedules, type User } from '../db/schema.js';
import { sendHtml, type TelegramInlineKeyboard } from '../surfaces/telegram/index.js';
import { unregisterMealCron } from '../services/scheduler.js';
import { unregisterNightlyCron } from '../services/nightly.js';
import { createLogger } from '../utils/logger.js';
import { escapeHtml } from '../utils/html.js';

const log = createLogger('commands');

/** Bot capability overview shown on /help */
const HELP_TEXT = `<b>Here's what I can do</b> 🤌

📄 Send me a grocery bill PDF — I'll auto-build your kitchen inventory.

🍽️ <b>I'm hungry</b> — meals from what you have
📊 <b>/kitchen</b> — current pantry
📝 <b>ate poha</b> — log a meal
📈 <b>/today</b> — nutrition summary
⏰ <b>/schedule</b> — reminder times
👤 <b>/profile</b> — nutrition setup
🛒 Order cravings/missing items — connect Zepto at <a href="https://aajkyakhaun.com/app">aajkyakhaun.com/app</a>
🔇 <b>/mute</b> — pause reminders
💬 <b>/feedback</b> — tell me what's broken

Just talk naturally. I'll figure it out 🎯`;

const MAIN_MENU_KEYBOARD: TelegramInlineKeyboard = [
  [
    { text: 'Suggest a meal', callbackData: 'cmd:hungry' },
    { text: 'Show kitchen', callbackData: 'cmd:kitchen' },
  ],
  [
    { text: 'Today summary', callbackData: 'cmd:today' },
    { text: 'Schedule', callbackData: 'cmd:schedule' },
  ],
];

/** Menu shown to returning onboarded users who send /start */
function welcomeBackText(name: string | null): string {
  const n = escapeHtml(name ?? 'there');
  return `Welcome back, <b>${n}</b>! 👋

<b>What are we doing today?</b>

🍽️ Meal idea from your kitchen
📊 Pantry check
📈 Nutrition summary
⏰ Reminder settings
🛒 Order cravings or missing items`;
}

export interface CommandContext {
  user: User;
  /** True if the user was just created in this request (first-ever contact). */
  created: boolean;
  surface?: 'telegram';
  externalId?: string;
}

/**
 * Attempts to handle a slash command. Returns true if the command was handled
 * (caller should stop processing), false if the caller should continue with
 * normal onboarding / agent flow.
 */
export async function tryHandleCommand(text: string, ctx: CommandContext): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;

  // Extract just the command name (strip args: "/ate dal chawal" -> "/ate")
  // Also strip Telegram's @botname suffix: "/help@aajkyakhaunbot" -> "/help"
  const firstToken = trimmed.split(/\s+/)[0]!.toLowerCase();
  const command = firstToken.split('@')[0];

  switch (command) {
    case '/start':
      return handleStart(ctx);
    case '/help':
      return handleHelp(ctx);
    case '/mute':
      return handleMute(ctx);
    case '/feedback':
      return handleFeedback(ctx);
    case '/connect_zepto':
    case '/zepto_code':
      return handleZeptoMoved(ctx);
    default:
      // Let the agent handle everything else (/hungry, /kitchen, /ate, etc.)
      return false;
  }
}

async function handleStart(ctx: CommandContext): Promise<boolean> {
  const { user } = ctx;

  // Mid-onboarding (legacy users who never finished). Web is now the
  // single onboarding surface — point them there.
  if (!user.onboardingComplete) {
    await replyHtml(
      ctx,
      'Looks like setup isn\'t finished. Head to ' +
        '<a href="https://aajkyakhaun.com/start">aajkyakhaun.com/start</a> to wrap it up.',
    );
    return true;
  }

  await replyHtml(ctx, welcomeBackText(user.name), {
    inlineKeyboard: MAIN_MENU_KEYBOARD,
  });
  log.info(`/start returning user ${user.id}`);
  return true;
}

async function handleHelp(ctx: CommandContext): Promise<boolean> {
  await replyHtml(ctx, HELP_TEXT, { inlineKeyboard: MAIN_MENU_KEYBOARD });
  log.info(`/help sent to ${ctx.user.id}`);
  return true;
}

async function handleMute(ctx: CommandContext): Promise<boolean> {
  const { user } = ctx;

  // Disable all meal + nightly schedules at the DB level AND tear down the
  // in-memory cron entries. Next deploy / boot will not re-register these
  // because we filter on enabled=true when loading.
  const schedules = await db
    .select()
    .from(userSchedules)
    .where(eq(userSchedules.userId, user.id));

  await db
    .update(userSchedules)
    .set({ enabled: false })
    .where(eq(userSchedules.userId, user.id));

  for (const s of schedules) {
    unregisterMealCron(user.id, s.mealType);
  }
  unregisterNightlyCron(user.id);

  await replyHtml(
    ctx,
    `🤫 <b>All reminders paused.</b>

Just say something like <code>remind me for breakfast at 9</code> or use <b>/schedule</b> to turn them back on whenever.`,
  );
  log.info(`/mute: ${user.id} paused ${schedules.length} schedules`);
  return true;
}

async function handleZeptoMoved(ctx: CommandContext): Promise<boolean> {
  await replyHtml(
    ctx,
    `Connecting Zepto now happens on the web — head to ` +
      `<a href="https://aajkyakhaun.com/app">aajkyakhaun.com/app</a>, ` +
      `link your account, and you're set 🛒`,
  );
  log.info(`/connect_zepto redirect issued to ${ctx.user.id}`);
  return true;
}

async function handleFeedback(ctx: CommandContext): Promise<boolean> {
  await replyHtml(
    ctx,
    `<b>Tell me what's on your mind</b> 💭

Anything — features you want, things that broke, random thoughts. I'm listening.`,
  );
  log.info(`/feedback prompt sent to ${ctx.user.id}`);
  return true;
}

async function replyHtml(
  ctx: CommandContext,
  html: string,
  options?: { inlineKeyboard?: TelegramInlineKeyboard },
): Promise<void> {
  if (ctx.user.telegramId) {
    await sendHtml(ctx.user.telegramId, html, options);
  }
}
