/**
 * Builds the per-turn context snapshot the agent needs to answer intelligently:
 *   - user profile (name, diet, timezone, schedules)
 *   - current inventory (available items)
 *   - recent meal logs (last 3 days, for no-repeat suggestions)
 *   - last ~15 messages (conversational continuity)
 *
 * This is rebuilt fresh every turn — cheap compared to an LLM call, and keeps
 * state 100% in the DB.
 */

import { desc, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { users, userSchedules, messages, type User } from '../db/schema.js';
import { listAvailable, type InventoryRow } from '../services/inventory.js';
import { recentMeals } from '../services/meal-log.js';
import type { MealLog } from '../db/schema.js';

const MESSAGE_HISTORY_LIMIT = 15;

export interface AgentContext {
  user: User;
  schedules: Array<{ mealType: MealLog['mealType']; remindAt: string; enabled: boolean }>;
  inventory: InventoryRow[];
  recentMeals: MealLog[];
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export async function loadContext(userId: string): Promise<AgentContext> {
  const [user, schedules, inventory, meals, history] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, userId) }),
    db
      .select({
        mealType: userSchedules.mealType,
        remindAt: userSchedules.remindAt,
        enabled: userSchedules.enabled,
      })
      .from(userSchedules)
      .where(eq(userSchedules.userId, userId)),
    listAvailable(userId),
    recentMeals(userId, 3),
    db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.userId, userId))
      .orderBy(desc(messages.createdAt))
      .limit(MESSAGE_HISTORY_LIMIT),
  ]);

  if (!user) throw new Error(`User ${userId} not found`);

  // Per-message cap: a pathologically long single message (user pasting a
  // wall of text, or an older assistant reply that listed every item)
  // shouldn't balloon the LLM context. 2000 chars is generous for a
  // WhatsApp-sized exchange but bounded.
  const MAX_MESSAGE_CHARS = 2000;

  // History comes back newest-first; the agent wants it oldest-first
  // and only user/assistant messages (filter out 'system' entries).
  const chronologicalHistory = history
    .filter((m): m is { role: 'user' | 'assistant'; content: string } => m.role !== 'system')
    .map((m) => ({
      role: m.role,
      content:
        m.content.length > MAX_MESSAGE_CHARS
          ? m.content.slice(0, MAX_MESSAGE_CHARS) + '…'
          : m.content,
    }))
    .reverse();

  return {
    user,
    schedules,
    inventory,
    recentMeals: meals,
    history: chronologicalHistory,
  };
}
