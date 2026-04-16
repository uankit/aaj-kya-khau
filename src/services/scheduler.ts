/**
 * Per-user cron scheduler.
 *
 * We DO NOT poll the DB every minute. Instead, each user's enabled meal
 * reminder gets its own `node-cron` entry, firing once a day at the user's
 * chosen local time. On boot, we load all enabled schedules from the DB and
 * register them. When a user updates a schedule via the agent, we destroy
 * the previous entry and register the new one.
 *
 * The fires-at-boot / destroys-on-update model is a bit manual, but it's
 * dead simple to reason about and scales to thousands of users without Redis.
 *
 * When a cron fires, it calls `triggerNudge()` which (for now) just logs.
 * Phase 3 will replace this with a call into the agent loop.
 */

import cron, { type ScheduledTask } from 'node-cron';
import { eq, and } from 'drizzle-orm';
import { db } from '../config/database.js';
import { userSchedules, users, mealLogs, type MealLog } from '../db/schema.js';
import { cronForTime, todayInTimezone } from '../utils/time.js';
import { createLogger } from '../utils/logger.js';
import { handleTurn } from '../agent/agent.js';

const log = createLogger('scheduler');

type MealType = MealLog['mealType'];

/** Key is `${userId}:${mealType}`. Value is the active cron task. */
const activeCrons = new Map<string, ScheduledTask>();

function cronKey(userId: string, mealType: MealType): string {
  return `${userId}:${mealType}`;
}

export interface RegisterMealCronArgs {
  userId: string;
  mealType: MealType;
  remindAt: string; // 'HH:MM:SS' or 'HH:MM'
  timezone: string;
}

/** Destroys any existing cron entry for (user, meal) and re-registers it. */
export function registerMealCron(args: RegisterMealCronArgs): void {
  const { userId, mealType, remindAt, timezone } = args;
  const key = cronKey(userId, mealType);

  // Destroy any existing entry first
  const existing = activeCrons.get(key);
  if (existing) {
    existing.stop();
    activeCrons.delete(key);
  }

  const expr = cronForTime(remindAt);
  if (!expr) {
    log.warn(`Invalid remindAt for ${key}: ${remindAt} — skipping cron registration`);
    return;
  }

  const task = cron.schedule(
    expr,
    () => {
      // Fire and forget; errors inside a nudge shouldn't kill the cron.
      triggerNudge(userId, mealType).catch((err) => {
        log.error(`Nudge failed for ${key}`, err);
      });
    },
    { timezone },
  );
  activeCrons.set(key, task);
  log.info(`Registered cron ${key} at ${remindAt} (${timezone}) → ${expr}`);
}

/** Removes a cron entry (used when user disables a reminder). */
export function unregisterMealCron(userId: string, mealType: MealType): void {
  const key = cronKey(userId, mealType);
  const task = activeCrons.get(key);
  if (task) {
    task.stop();
    activeCrons.delete(key);
    log.info(`Unregistered cron ${key}`);
  }
}

/**
 * Called when a cron fires. Checks whether the user has already logged this
 * meal today (if yes, skip — no need to bug them), then triggers the nudge.
 *
 * Dispatches to the LLM agent which generates a casual nudge message.
 */
async function triggerNudge(userId: string, mealType: MealType): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) {
    log.warn(`Cron fired for unknown user ${userId}`);
    unregisterMealCron(userId, mealType);
    return;
  }
  if (!user.onboardingComplete) {
    log.warn(`Skipping nudge for ${userId} — onboarding not complete`);
    return;
  }

  // Duplicate-nudge guard: if the user already logged this meal today, bail.
  const todayYmd = todayInTimezone(user.timezone);
  const existing = await db
    .select()
    .from(mealLogs)
    .where(and(eq(mealLogs.userId, userId), eq(mealLogs.mealType, mealType)));

  const alreadyLoggedToday = existing.some((m) => {
    const loggedYmd = new Date(m.loggedAt).toLocaleDateString('en-CA', {
      timeZone: user.timezone,
    });
    return loggedYmd === todayYmd;
  });

  if (alreadyLoggedToday) {
    log.info(`Skipping ${mealType} nudge for ${userId} — already logged today`);
    return;
  }

  // Dispatch to the agent — it'll generate a casual nudge and send via Twilio.
  log.info(`[NUDGE] Firing ${mealType} nudge for ${user.phone}`);
  await handleTurn(userId, { type: 'nudge', mealType: mealType as 'breakfast' | 'lunch' | 'snack' | 'dinner' });
}

/**
 * Loads all enabled schedules from the DB and registers cron entries for them.
 * Called on server boot so crons survive restarts.
 */
export async function loadAllSchedules(): Promise<void> {
  const rows = await db
    .select({
      userId: userSchedules.userId,
      mealType: userSchedules.mealType,
      remindAt: userSchedules.remindAt,
      timezone: users.timezone,
      onboardingComplete: users.onboardingComplete,
    })
    .from(userSchedules)
    .innerJoin(users, eq(userSchedules.userId, users.id))
    .where(eq(userSchedules.enabled, true));

  let count = 0;
  for (const row of rows) {
    if (!row.onboardingComplete) continue;
    registerMealCron({
      userId: row.userId,
      mealType: row.mealType,
      remindAt: row.remindAt,
      timezone: row.timezone,
    });
    count++;
  }
  log.info(`Loaded ${count} meal cron entries from DB`);
}

/** Exposed for tests / admin diagnostics. */
export function getActiveCronCount(): number {
  return activeCrons.size;
}
