/**
 * Agent tool registry.
 *
 * Each tool = Zod schema (input validation) + an async executor that performs
 * the side effect. Tools are built inside `buildTools(userId)` so every tool
 * closes over the current user's id — the LLM can never target another user.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../config/database.js';
import { users, userSchedules } from '../db/schema.js';
import { addItem, removeItemByName, markFinishedBulk } from '../services/inventory.js';
import { logMeal } from '../services/meal-log.js';
import { registerMealCron, unregisterMealCron } from '../services/scheduler.js';
import { registerNightlyCron } from '../services/nightly.js';
import { saveHealthProfile, estimateMealNutrition, getDailySummary, type FoodPortion } from '../services/nutrition.js';
import { parseTimeOfDay, formatTimeOfDay, todayInTimezone } from '../utils/time.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('tools');

const MEAL_TYPE = z.enum(['breakfast', 'lunch', 'snack', 'dinner']);

export function buildTools(userId: string) {
  return {
    add_inventory_item: tool({
      description:
        'Add a single item to the user\'s kitchen inventory. Use this when the user says "add X" or "I just bought X".',
      parameters: z.object({
        name: z.string().describe('Short normalized name, e.g. "milk", "paneer", "bread"'),
        quantity: z.string().nullable().optional().describe('e.g. "1L", "500g", "6 pcs"'),
        category: z.string().nullable().optional(),
      }),
      execute: async ({ name, quantity, category }) => {
        const row = await addItem({
          userId,
          normalizedName: name,
          quantity: quantity ?? undefined,
          category: category ?? undefined,
          source: 'manual',
        });
        log.info(`[tool] add_inventory_item: ${row.normalizedName}`);
        return { added: row.normalizedName };
      },
    }),

    remove_inventory_item: tool({
      description:
        'Mark an item as finished / no longer available. Use when the user says "I finished X", "remove X", or "X is over".',
      parameters: z.object({
        name: z.string().describe('The item name to remove (substring match is OK)'),
      }),
      execute: async ({ name }) => {
        const removed = await removeItemByName(userId, name);
        log.info(`[tool] remove_inventory_item: ${name} → ${removed.length} removed`);
        return { removed, count: removed.length };
      },
    }),

    mark_items_finished: tool({
      description:
        'Mark MULTIPLE items as finished in one call. Use this in the nightly flow when the user lists several items that are over.',
      parameters: z.object({
        names: z.array(z.string()).min(1).describe('Array of item names to mark as finished'),
      }),
      execute: async ({ names }) => {
        const removed = await markFinishedBulk(userId, names);
        log.info(`[tool] mark_items_finished: ${names.length} requested, ${removed.length} matched`);
        return { removed, count: removed.length };
      },
    }),

    set_meal_schedule: tool({
      description:
        'Change or create a meal reminder time. Use when the user says "change my dinner to 9pm", "remind me for lunch at 1:30", etc.',
      parameters: z.object({
        meal_type: MEAL_TYPE,
        time: z.string().describe('Time in HH:MM format, e.g. "09:00", "21:30"'),
      }),
      execute: async ({ meal_type, time }) => {
        const parsed = parseTimeOfDay(time);
        if (!parsed) {
          return { error: `Invalid time format: ${time}. Use HH:MM.` };
        }
        const remindAt = formatTimeOfDay(parsed.hour, parsed.minute);

        // Upsert the schedule row
        await db
          .insert(userSchedules)
          .values({ userId, mealType: meal_type, remindAt, enabled: true })
          .onConflictDoUpdate({
            target: [userSchedules.userId, userSchedules.mealType],
            set: { remindAt, enabled: true },
          });

        // Fetch user timezone for cron registration
        const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
        const timezone = user?.timezone ?? 'Asia/Kolkata';

        registerMealCron({ userId, mealType: meal_type, remindAt, timezone });
        log.info(`[tool] set_meal_schedule: ${meal_type} → ${remindAt}`);
        return { updated: meal_type, time: remindAt };
      },
    }),

    remove_meal_schedule: tool({
      description:
        'Disable/remove a meal reminder. Use when the user says "stop my snack reminders", "no more breakfast pings", etc.',
      parameters: z.object({
        meal_type: MEAL_TYPE,
      }),
      execute: async ({ meal_type }) => {
        await db
          .update(userSchedules)
          .set({ enabled: false })
          .where(
            and(
              eq(userSchedules.userId, userId),
              eq(userSchedules.mealType, meal_type),
            ),
          );

        unregisterMealCron(userId, meal_type);
        log.info(`[tool] remove_meal_schedule: ${meal_type} disabled`);
        return { disabled: meal_type };
      },
    }),

    update_diet_type: tool({
      description:
        'Change the user\'s diet type. Use when they say "I\'m vegan now", "switched to non-veg", etc.',
      parameters: z.object({
        diet_type: z.enum(['veg', 'non-veg', 'egg', 'vegan']),
      }),
      execute: async ({ diet_type }) => {
        await db
          .update(users)
          .set({ dietType: diet_type, updatedAt: new Date() })
          .where(eq(users.id, userId));
        log.info(`[tool] update_diet_type: → ${diet_type}`);
        return { updated: diet_type };
      },
    }),

    set_nightly_time: tool({
      description:
        'Change the nightly summary / goodnight check-in time. Use when the user says "send goodnight at 11pm", "change nightly to 23:00", etc.',
      parameters: z.object({
        time: z.string().describe('Time in HH:MM format, e.g. "22:00", "23:30"'),
      }),
      execute: async ({ time }) => {
        const parsed = parseTimeOfDay(time);
        if (!parsed) {
          return { error: `Invalid time format: ${time}. Use HH:MM.` };
        }
        const nightlyAt = formatTimeOfDay(parsed.hour, parsed.minute);

        await db
          .update(users)
          .set({ nightlySummaryAt: nightlyAt, updatedAt: new Date() })
          .where(eq(users.id, userId));

        const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
        const timezone = user?.timezone ?? 'Asia/Kolkata';

        registerNightlyCron({ userId, nightlyAt, timezone });
        log.info(`[tool] set_nightly_time: → ${nightlyAt}`);
        return { updated: nightlyAt };
      },
    }),

    log_meal: tool({
      description:
        'Record a meal the user ate. Call this after the user confirms they\'re going to eat something you suggested, or tells you what they ate. ALWAYS include nutrition_items so we can estimate calories/macros from our IFCT database.',
      parameters: z.object({
        meal_type: MEAL_TYPE,
        description: z.string().describe('Short description, e.g. "poha with chai", "dal chawal"'),
        was_junk: z.boolean().nullable().optional(),
        items_used: z
          .array(z.string())
          .nullable()
          .optional()
          .describe('Inventory item names that were consumed'),
        suggested_by_bot: z.boolean().nullable().optional(),
        nutrition_items: z
          .array(
            z.object({
              food: z.string().describe('Food name (match to common Indian food, e.g. "roti", "tea with milk", "dal chawal", "egg omelette")'),
              servings: z.number().describe('Number of standard servings (1 = typical single portion)'),
            }),
          )
          .optional()
          .describe('Break the meal into its component foods so we can estimate nutrition. E.g., "paneer bhurji with 2 rotis and chai" → [{food:"paneer bhurji",servings:1},{food:"roti",servings:2},{food:"tea with milk",servings:1}]'),
      }),
      execute: async ({ meal_type, description, was_junk, items_used, suggested_by_bot, nutrition_items }) => {
        // Estimate nutrition from IFCT database (deterministic, not LLM)
        let nutritionData = null;
        if (nutrition_items && nutrition_items.length > 0) {
          try {
            const portions: FoodPortion[] = nutrition_items.map((ni) => ({
              food: ni.food,
              servings: ni.servings,
            }));
            nutritionData = await estimateMealNutrition(portions);
            log.info(`[tool] log_meal nutrition: ${nutritionData.totalCalories} cal, ${nutritionData.totalProteinG}g protein`);
          } catch (err) {
            log.warn('[tool] log_meal nutrition estimation failed', err);
          }
        }

        const row = await logMeal({
          userId,
          mealType: meal_type,
          description,
          wasJunk: was_junk ?? undefined,
          itemsUsed: items_used ?? undefined,
          suggestedByBot: suggested_by_bot ?? false,
          estimatedCalories: nutritionData?.totalCalories,
          estimatedProteinG: nutritionData?.totalProteinG,
          estimatedCarbsG: nutritionData?.totalCarbsG,
          estimatedFatG: nutritionData?.totalFatG,
          estimatedFiberG: nutritionData?.totalFiberG,
          nutritionBreakdown: nutritionData?.breakdown,
        });
        log.info(`[tool] log_meal: ${meal_type} "${description}"`);

        const result: Record<string, unknown> = { logged: true, id: row.id };
        if (nutritionData) {
          result.nutrition = {
            calories: nutritionData.totalCalories,
            protein_g: nutritionData.totalProteinG,
            carbs_g: nutritionData.totalCarbsG,
            fat_g: nutritionData.totalFatG,
            breakdown: nutritionData.breakdown.map((b) => `${b.food} (${b.matchedTo}): ${b.calories} cal, ${b.proteinG}g protein`),
          };
        }
        return result;
      },
    }),

    set_health_profile: tool({
      description:
        'Save the user\'s health profile for nutrition tracking (calorie/macro targets). Use when user says "track my nutrition", "set up my health profile", "I want to count calories", etc. Ask them for each field conversationally.',
      parameters: z.object({
        age: z.number().int().min(10).max(120),
        gender: z.enum(['male', 'female']),
        height_cm: z.number().int().min(100).max(250),
        weight_kg: z.number().int().min(25).max(300),
        activity_level: z.enum(['sedentary', 'lightly_active', 'moderately_active', 'very_active'])
          .describe('sedentary = desk job, lightly_active = 1-3x/wk exercise, moderately_active = 3-5x/wk, very_active = 6-7x/wk'),
        health_goal: z.enum(['lose', 'maintain', 'gain'])
          .describe('lose = fat loss, maintain = stay same, gain = muscle/weight gain'),
      }),
      execute: async ({ age, gender, height_cm, weight_kg, activity_level, health_goal }) => {
        const targets = await saveHealthProfile(userId, {
          age,
          gender,
          heightCm: height_cm,
          weightKg: weight_kg,
          activityLevel: activity_level,
          healthGoal: health_goal,
        });
        log.info(`[tool] set_health_profile: BMR=${targets.bmr}, TDEE=${targets.tdee}, target=${targets.calories} kcal`);
        return {
          bmr: targets.bmr,
          tdee: targets.tdee,
          daily_target_calories: targets.calories,
          daily_target_protein_g: targets.proteinG,
          daily_target_carbs_g: targets.carbsG,
          daily_target_fat_g: targets.fatG,
          daily_target_fiber_g: targets.fiberG,
          method: 'Mifflin-St Jeor (1990) + ICMR-NIN RDA (2020)',
        };
      },
    }),

    get_nutrition_summary: tool({
      description:
        'Get the user\'s nutrition summary for today (or a specific date). Shows calories and macros consumed vs targets. Use when user asks "how am I doing today?", "show my macros", "calories today?", etc.',
      parameters: z.object({
        date: z
          .string()
          .optional()
          .describe('Date in YYYY-MM-DD format. Omit for today.'),
      }),
      execute: async ({ date }) => {
        const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
        const tz = user?.timezone ?? 'Asia/Kolkata';
        const ymd = date ?? todayInTimezone(tz);
        const summary = await getDailySummary(userId, ymd);
        log.info(`[tool] get_nutrition_summary for ${ymd}`);
        return summary;
      },
    }),
  };
}

export type AgentTools = ReturnType<typeof buildTools>;
