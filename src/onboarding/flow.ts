/**
 * Deterministic onboarding state machine.
 *
 * Given a user row (with `onboarding_step`) and an incoming message, this:
 *   1. validates the answer for the current step
 *   2. persists the answer (to `users` or `user_schedules`)
 *   3. advances `onboarding_step`
 *   4. sends the next question (or the completion message)
 *   5. when complete → registers all crons and flips onboarding_complete=true
 *
 * No LLM involved. This is cheap, predictable, and easy to reason about.
 */

import { eq, and, isNull, or, ne } from 'drizzle-orm';
import { db } from '../config/database.js';
import { users, userSchedules, messages, defaultPantryItems, type User } from '../db/schema.js';
import { sendText } from '../services/telegram.js';
import { registerMealCron } from '../services/scheduler.js';
import { registerNightlyCron } from '../services/nightly.js';
import { addItemsBulk } from '../services/inventory.js';
import {
  ONBOARDING_PROMPTS,
  validateName,
  validateDiet,
  validateTime,
  nextStep,
  stepToMealType,
  type OnboardingStep,
} from './questions.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('onboarding');

/** Persist a message in the history table (used for later agent context). */
async function persistMessage(
  userId: string,
  role: 'user' | 'assistant',
  content: string,
) {
  await db.insert(messages).values({ userId, role, content });
}

/** Sends a message and persists it as the assistant message. */
async function sendAndPersist(user: User, text: string) {
  await sendText(user.telegramId, text);
  await persistMessage(user.id, 'assistant', text);
}

/**
 * Sends the prompt for the *current* step of the user. Used when we want to
 * (re)send the question — e.g. on first contact, or after invalid input.
 */
export async function sendCurrentPrompt(user: User) {
  const prompt = ONBOARDING_PROMPTS[user.onboardingStep](user.name ?? undefined);
  await sendAndPersist(user, prompt);
}

/**
 * Handles one incoming message while the user is onboarding.
 * Returns `true` if onboarding just finished so the caller knows to treat the
 * next message (if any) as a regular agent turn.
 */
export async function handleOnboardingMessage(user: User, text: string): Promise<boolean> {
  // Persist user message first so the history is complete even if we fail later
  await persistMessage(user.id, 'user', text);

  const step = user.onboardingStep;

  switch (step) {
    case 'ask_name': {
      const result = validateName(text);
      if (!result.ok) {
        await sendAndPersist(user, result.error);
        return false;
      }
      const updated = await advanceUser(user, {
        name: result.value,
        onboardingStep: nextStep(step),
      });
      await sendAndPersist(updated, ONBOARDING_PROMPTS.ask_diet(updated.name ?? undefined));
      return false;
    }

    case 'ask_diet': {
      const result = validateDiet(text);
      if (!result.ok) {
        await sendAndPersist(user, result.error);
        return false;
      }
      const updated = await advanceUser(user, {
        dietType: result.value,
        onboardingStep: nextStep(step),
      });
      await sendAndPersist(
        updated,
        ONBOARDING_PROMPTS.ask_breakfast_time(updated.name ?? undefined),
      );
      return false;
    }

    case 'ask_breakfast_time':
    case 'ask_lunch_time':
    case 'ask_snack_time':
    case 'ask_dinner_time': {
      const result = validateTime(text);
      if (!result.ok) {
        await sendAndPersist(user, result.error);
        return false;
      }
      const mealType = stepToMealType(step)!;
      if (result.value !== null) {
        // Upsert the schedule row. Safe to insert fresh since we uniquely gate by (user, meal).
        await db
          .insert(userSchedules)
          .values({ userId: user.id, mealType, remindAt: result.value, enabled: true })
          .onConflictDoUpdate({
            target: [userSchedules.userId, userSchedules.mealType],
            set: { remindAt: result.value, enabled: true },
          });
      }

      const next = nextStep(step);

      if (next === 'complete') {
        const updated = await advanceUser(user, {
          onboardingStep: 'complete',
          onboardingComplete: true,
        });
        // Register all crons for this user now that onboarding is done.
        await registerUserCrons(updated.id);
        await sendAndPersist(
          updated,
          ONBOARDING_PROMPTS.complete(updated.name ?? undefined),
        );
        log.info(`Onboarding complete for ${updated.telegramId}`);
        return true;
      }

      const updated = await advanceUser(user, { onboardingStep: next });
      await sendAndPersist(updated, ONBOARDING_PROMPTS[next](updated.name ?? undefined));
      return false;
    }

    case 'complete': {
      // Defensive: if somehow we're called while onboarding_step=complete, just
      // re-send the welcome note and let the router dispatch subsequent messages
      // to the agent.
      await sendAndPersist(user, ONBOARDING_PROMPTS.complete(user.name ?? undefined));
      return true;
    }
  }
}

async function advanceUser(
  user: User,
  patch: Partial<{
    name: string;
    dietType: User['dietType'];
    onboardingStep: OnboardingStep;
    onboardingComplete: boolean;
  }>,
): Promise<User> {
  const [updated] = await db
    .update(users)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(users.id, user.id))
    .returning();
  if (!updated) throw new Error(`Failed to update user ${user.id}`);
  return updated;
}

/** Loads all enabled schedules for a user and registers cron jobs for them. */
async function registerUserCrons(userId: string) {
  const rows = await db
    .select()
    .from(userSchedules)
    .where(eq(userSchedules.userId, userId));

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return;

  for (const s of rows) {
    if (!s.enabled) continue;
    registerMealCron({
      userId: s.userId,
      mealType: s.mealType,
      remindAt: s.remindAt,
      timezone: user.timezone,
    });
  }

  // Register the nightly summary cron (defaults to 22:00)
  registerNightlyCron({
    userId,
    nightlyAt: user.nightlySummaryAt,
    timezone: user.timezone,
  });

  // Seed default pantry staples from the DB table.
  // - region filter: universal (NULL) for v1; later we'll respect user.region
  // - diet filter: exclude items where excludeDiet matches user's diet_type
  //   (e.g. ghee is excluded for vegans)
  const pantryRows = await db
    .select()
    .from(defaultPantryItems)
    .where(
      and(
        // Region: universal only for now
        isNull(defaultPantryItems.region),
        // Diet: include item if excludeDiet is NULL, or doesn't match user's diet
        or(
          isNull(defaultPantryItems.excludeDiet),
          user.dietType ? ne(defaultPantryItems.excludeDiet, user.dietType) : isNull(defaultPantryItems.excludeDiet),
        ),
      ),
    );

  if (pantryRows.length > 0) {
    await addItemsBulk(
      pantryRows.map((item) => ({
        userId,
        normalizedName: item.normalizedName,
        category: item.category,
        source: 'manual' as const,
        confidence: 'high' as const,
      })),
    );
  }
  log.info(`Seeded ${pantryRows.length} default pantry items for ${userId} (diet: ${user.dietType ?? 'none'})`);
}
