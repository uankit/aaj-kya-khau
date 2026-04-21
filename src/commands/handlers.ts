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

import { and, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { userSchedules, type User } from '../db/schema.js';
import { sendText } from '../services/telegram.js';
import { unregisterMealCron, registerMealCron } from '../services/scheduler.js';
import { unregisterNightlyCron, registerNightlyCron } from '../services/nightly.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('commands');

/** Bot capability overview shown on /help */
const HELP_TEXT = `Here's what I can do 🤌

📄 Send me a grocery bill PDF — I'll auto-build your kitchen inventory

🍽️ Say "I'm hungry" or /hungry — meal suggestion from what you have
📊 /kitchen — everything currently in your kitchen
📝 "ate poha" or /ate poha — log what you just had
📈 /today — today's nutrition summary (after /profile setup)
⏰ /schedule — view or change meal reminder times
👤 /profile — set up nutrition tracking (age, weight, goals)
🔇 /mute — pause all reminders
💬 /feedback — tell me what's broken or missing

Just talk to me naturally. I'll figure it out 🎯`;

/** Menu shown to returning onboarded users who send /start */
function welcomeBackText(name: string | null): string {
  const n = name ?? 'there';
  return `Welcome back, ${n}! 👋

What are we doing today?

🍽️ /hungry — suggest me a meal
📊 /kitchen — what do I have?
📈 /today — my nutrition today
⏰ /schedule — change my reminder times
❓ /help — all commands`;
}

export interface CommandContext {
  user: User;
  /** True if the user was just created in this request (first-ever contact). */
  created: boolean;
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
    default:
      // Let the agent handle everything else (/hungry, /kitchen, /ate, etc.)
      return false;
  }
}

async function handleStart(ctx: CommandContext): Promise<boolean> {
  const { user, created } = ctx;

  // Brand-new user — fall through, webhook will send onboarding welcome
  if (created) return false;

  // Mid-onboarding — fall through, handleOnboardingMessage will resend
  // the current step's prompt (we treat /start as "no-op, show me where I am")
  if (!user.onboardingComplete) {
    // Special case: typing /start while mid-onboarding is confusing. Just
    // re-send the current question so the user isn't stuck.
    // We do this by falling through — the onboarding flow's validation will
    // mark /start as invalid input and re-send the current question.
    return false;
  }

  // Returning onboarded user — show friendly welcome-back menu
  await sendText(user.telegramId, welcomeBackText(user.name));
  log.info(`/start returning user ${user.telegramId}`);
  return true;
}

async function handleHelp(ctx: CommandContext): Promise<boolean> {
  await sendText(ctx.user.telegramId, HELP_TEXT);
  log.info(`/help sent to ${ctx.user.telegramId}`);
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

  await sendText(
    user.telegramId,
    `🤫 All reminders paused.

Just say something like "remind me for breakfast at 9" or use /schedule to turn them back on whenever.`,
  );
  log.info(`/mute: ${user.telegramId} paused ${schedules.length} schedules`);
  return true;
}

async function handleFeedback(ctx: CommandContext): Promise<boolean> {
  await sendText(
    ctx.user.telegramId,
    `Tell me what's on your mind 💭

Anything — features you want, things that broke, random thoughts. I'm listening.`,
  );
  log.info(`/feedback prompt sent to ${ctx.user.telegramId}`);
  return true;
}

/**
 * Re-enable a user's schedules after /mute. Exposed for future use — we don't
 * currently have a /resume command but the scheduler needs the ability to
 * re-register crons from the DB.
 */
export async function reenableUserSchedules(user: User): Promise<void> {
  const schedules = await db
    .select()
    .from(userSchedules)
    .where(and(eq(userSchedules.userId, user.id), eq(userSchedules.enabled, true)));

  for (const s of schedules) {
    registerMealCron({
      userId: user.id,
      mealType: s.mealType,
      remindAt: s.remindAt,
      timezone: user.timezone,
    });
  }
  registerNightlyCron({
    userId: user.id,
    nightlyAt: user.nightlySummaryAt,
    timezone: user.timezone,
  });
}
