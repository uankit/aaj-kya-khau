/**
 * Nightly summary cron.
 *
 * Each user has a `nightly_summary_at` time (default 22:00). We register a
 * per-user cron entry (same pattern as meal nudges) that fires the agent with
 * `{ type: 'nightly' }`. The agent then:
 *   - summarizes what the user ate today
 *   - asks if anything in the kitchen is finished
 *   - the user's reply triggers `mark_items_finished` tool
 */

import cron, { type ScheduledTask } from 'node-cron';
import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { users } from '../db/schema.js';
import { cronForTime } from '../utils/time.js';
import { handleTurn } from '../agent/agent.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('nightly');

const nightlyCrons = new Map<string, ScheduledTask>();

function cronKey(userId: string): string {
  return `nightly:${userId}`;
}

export function registerNightlyCron(args: {
  userId: string;
  nightlyAt: string; // 'HH:MM:SS'
  timezone: string;
}): void {
  const { userId, nightlyAt, timezone } = args;
  const key = cronKey(userId);

  const existing = nightlyCrons.get(key);
  if (existing) {
    existing.stop();
    nightlyCrons.delete(key);
  }

  const expr = cronForTime(nightlyAt);
  if (!expr) {
    log.warn(`Invalid nightlyAt for ${key}: ${nightlyAt}`);
    return;
  }

  const task = cron.schedule(
    expr,
    () => {
      triggerNightly(userId).catch((err) => {
        log.error(`Nightly failed for ${userId}`, err);
      });
    },
    { timezone },
  );
  nightlyCrons.set(key, task);
  log.info(`Registered nightly cron for ${userId} at ${nightlyAt} (${timezone})`);
}

export function unregisterNightlyCron(userId: string): void {
  const key = cronKey(userId);
  const task = nightlyCrons.get(key);
  if (task) {
    task.stop();
    nightlyCrons.delete(key);
    log.info(`Unregistered nightly cron for ${userId}`);
  }
}

async function triggerNightly(userId: string): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || !user.onboardingComplete) return;

  log.info(`[NIGHTLY] Firing for ${user.telegramId}`);
  await handleTurn(userId, { type: 'nightly' });
}

/** Load all nightly crons from DB on boot. */
export async function loadAllNightlyCrons(): Promise<void> {
  const rows = await db
    .select({
      id: users.id,
      nightlySummaryAt: users.nightlySummaryAt,
      timezone: users.timezone,
      onboardingComplete: users.onboardingComplete,
    })
    .from(users)
    .where(eq(users.onboardingComplete, true));

  let count = 0;
  for (const row of rows) {
    registerNightlyCron({
      userId: row.id,
      nightlyAt: row.nightlySummaryAt,
      timezone: row.timezone,
    });
    count++;
  }
  log.info(`Loaded ${count} nightly cron entries from DB`);
}

export function getNightlyCronCount(): number {
  return nightlyCrons.size;
}
