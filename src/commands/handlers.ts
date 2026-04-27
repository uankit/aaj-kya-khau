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

import { and, desc, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import {
  connectedAccounts,
  oauthPendingStates,
  userSchedules,
  type User,
} from '../db/schema.js';
import { sendHtml, type TelegramInlineKeyboard } from '../surfaces/telegram/index.js';
import { unregisterMealCron } from '../services/scheduler.js';
import { unregisterNightlyCron } from '../services/nightly.js';
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generatePkce,
  generateState,
  ZEPTO_POSTMAN_REDIRECT,
} from '../providers/grocery/zepto/oauth.js';
import { encrypt } from '../utils/crypto.js';
import { env } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { escapeHtml } from '../utils/html.js';
import { sendCurrentPrompt } from '../onboarding/flow.js';

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
🛒 <b>/connect_zepto</b> — order cravings or missing items
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
  [{ text: 'Connect Zepto', callbackData: 'cmd:connect_zepto' }],
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
🛒 Zepto for cravings or missing items`;
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
    case '/connect_zepto':
      return handleConnectZepto(ctx);
    case '/zepto_code':
      return handleZeptoCode(ctx, trimmed);
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
  if (!user.onboardingComplete) {
    await sendCurrentPrompt(user);
    return true;
  }

  // Returning onboarded user — show friendly welcome-back menu
  await sendHtml(user.telegramId, welcomeBackText(user.name), {
    inlineKeyboard: MAIN_MENU_KEYBOARD,
  });
  log.info(`/start returning user ${user.telegramId}`);
  return true;
}

async function handleHelp(ctx: CommandContext): Promise<boolean> {
  await sendHtml(ctx.user.telegramId, HELP_TEXT, { inlineKeyboard: MAIN_MENU_KEYBOARD });
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

  await sendHtml(
    user.telegramId,
    `🤫 <b>All reminders paused.</b>

Just say something like <code>remind me for breakfast at 9</code> or use <b>/schedule</b> to turn them back on whenever.`,
  );
  log.info(`/mute: ${user.telegramId} paused ${schedules.length} schedules`);
  return true;
}

async function handleConnectZepto(ctx: CommandContext): Promise<boolean> {
  const { user } = ctx;

  if (!env.ZEPTO_CLIENT_ID || !env.ENCRYPTION_KEY) {
    await sendHtml(
      user.telegramId,
      `Zepto connection isn't configured on the server yet. Hang tight 🛒`,
    );
    log.warn(`/connect_zepto requested by ${user.telegramId} but env not fully configured`);
    return true;
  }

  // Clear any stale in-flight state for this user — we only allow one active
  // Zepto OAuth attempt at a time. Simplifies the /zepto_code lookup.
  await db
    .delete(oauthPendingStates)
    .where(
      and(
        eq(oauthPendingStates.userId, user.id),
        eq(oauthPendingStates.provider, 'zepto'),
      ),
    );

  const { codeVerifier, codeChallenge } = generatePkce();
  const state = generateState();

  await db.insert(oauthPendingStates).values({
    state,
    userId: user.id,
    provider: 'zepto',
    codeVerifier,
  });

  // Note: redirect_uri here must exactly match what's registered on Zepto
  // AND what we send in the token exchange later. Using Postman's OOB page.
  const authUrl = buildAuthorizationUrl({
    clientId: env.ZEPTO_CLIENT_ID,
    redirectUri: ZEPTO_POSTMAN_REDIRECT,
    state,
    codeChallenge,
  });

  await sendHtml(
    user.telegramId,
    `<b>Let's link your Zepto account</b> 🛒

1. Tap this link to approve:
${escapeHtml(authUrl)}

2. You'll land on a page that shows an <b>authorization code</b> — copy it.

3. Come back here and send:
<code>/zepto_code PASTE_THE_CODE_HERE</code>

(The link stays valid for 10 minutes.)

<b>One heads-up:</b> Zepto is hyperlocal — make sure you have a <b>delivery address set on your Zepto account</b> before ordering through me, otherwise search & checkout will fail. If you've used Zepto before, you're good.`,
  );
  log.info(`/connect_zepto link (Postman OOB) issued to ${user.telegramId}`);
  return true;
}

async function handleZeptoCode(ctx: CommandContext, rawText: string): Promise<boolean> {
  const { user } = ctx;

  // Extract the code — everything after the command, first token only
  const parts = rawText.trim().split(/\s+/);
  const code = parts[1];
  if (!code) {
    await sendHtml(
      user.telegramId,
      `Send the code like this:\n\n<code>/zepto_code YOUR_CODE_HERE</code>`,
    );
    return true;
  }

  if (!env.ZEPTO_CLIENT_ID || !env.ENCRYPTION_KEY) {
    await sendHtml(
      user.telegramId,
      `Zepto isn't configured on the server yet. Sorry! 😬`,
    );
    return true;
  }

  // Look up the most recent pending state for this user + provider
  const [pending] = await db
    .select()
    .from(oauthPendingStates)
    .where(
      and(
        eq(oauthPendingStates.userId, user.id),
        eq(oauthPendingStates.provider, 'zepto'),
      ),
    )
    .orderBy(desc(oauthPendingStates.createdAt))
    .limit(1);

  if (!pending) {
    await sendHtml(
      user.telegramId,
      `I don't see an active Zepto connection in progress. Start one with <b>/connect_zepto</b> 🛒`,
    );
    return true;
  }

  const ageMs = Date.now() - pending.createdAt.getTime();
  if (ageMs > 10 * 60 * 1000) {
    await db
      .delete(oauthPendingStates)
      .where(eq(oauthPendingStates.state, pending.state));
    await sendHtml(
      user.telegramId,
      `That code's link has expired. Kick it off again with <b>/connect_zepto</b> 🕙`,
    );
    return true;
  }

  // Exchange code for tokens
  let tokens;
  try {
    tokens = await exchangeCodeForTokens({
      clientId: env.ZEPTO_CLIENT_ID,
      code,
      redirectUri: ZEPTO_POSTMAN_REDIRECT,
      codeVerifier: pending.codeVerifier,
    });
  } catch (err) {
    log.error(`Token exchange failed for user ${user.id}`, err);
    await sendHtml(
      user.telegramId,
      `Couldn't verify that code with Zepto. Either it's already been used or it's mistyped — try /connect_zepto again.`,
    );
    return true;
  }

  // Encrypt + upsert + cleanup
  const accessCt = encrypt(tokens.access_token);
  const refreshCt = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : null;

  await db
    .insert(connectedAccounts)
    .values({
      userId: user.id,
      provider: 'zepto',
      accessTokenCiphertext: accessCt,
      refreshTokenCiphertext: refreshCt,
      tokenExpiresAt: expiresAt,
      scopes: tokens.scope ?? null,
      status: 'active',
    })
    .onConflictDoUpdate({
      target: [connectedAccounts.userId, connectedAccounts.provider],
      set: {
        accessTokenCiphertext: accessCt,
        refreshTokenCiphertext: refreshCt,
        tokenExpiresAt: expiresAt,
        scopes: tokens.scope ?? null,
        status: 'active',
        connectedAt: new Date(),
      },
    });

  await db
    .delete(oauthPendingStates)
    .where(eq(oauthPendingStates.state, pending.state));

  await sendHtml(
    user.telegramId,
    `✅ <b>Zepto connected!</b>

Now you can say things like:
• <code>I'm craving Bournville</code>
• <code>make paneer butter masala</code>
• <code>order chips</code>

I'll check your pantry first, then guide the Zepto order with buttons when something's missing 🛒`,
    { inlineKeyboard: MAIN_MENU_KEYBOARD },
  );

  log.info(`Zepto connected (OOB) for user ${user.id}`);
  return true;
}

async function handleFeedback(ctx: CommandContext): Promise<boolean> {
  await sendHtml(
    ctx.user.telegramId,
    `<b>Tell me what's on your mind</b> 💭

Anything — features you want, things that broke, random thoughts. I'm listening.`,
  );
  log.info(`/feedback prompt sent to ${ctx.user.telegramId}`);
  return true;
}
