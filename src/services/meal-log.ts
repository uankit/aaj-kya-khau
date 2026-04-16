import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { mealLogs, type MealLog } from '../db/schema.js';

export type MealType = MealLog['mealType'];

export interface LogMealInput {
  userId: string;
  mealType: MealType;
  description: string;
  wasJunk?: boolean;
  itemsUsed?: string[];
  suggestedByBot?: boolean;
  // Nutrition (calculated by the deterministic engine, not the LLM)
  estimatedCalories?: number;
  estimatedProteinG?: number;
  estimatedCarbsG?: number;
  estimatedFatG?: number;
  estimatedFiberG?: number;
  nutritionBreakdown?: unknown;
}

export async function logMeal(input: LogMealInput): Promise<MealLog> {
  const [row] = await db
    .insert(mealLogs)
    .values({
      userId: input.userId,
      mealType: input.mealType,
      description: input.description,
      wasJunk: input.wasJunk ?? null,
      itemsUsed: input.itemsUsed ?? null,
      suggestedByBot: input.suggestedByBot ?? false,
      estimatedCalories: input.estimatedCalories ?? null,
      estimatedProteinG: input.estimatedProteinG ?? null,
      estimatedCarbsG: input.estimatedCarbsG ?? null,
      estimatedFatG: input.estimatedFatG ?? null,
      estimatedFiberG: input.estimatedFiberG ?? null,
      nutritionBreakdown: input.nutritionBreakdown ?? null,
    })
    .returning();
  return row!;
}

/** Returns meal logs for the last `days` days for an agent context block. */
export async function recentMeals(userId: string, days = 3): Promise<MealLog[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return db
    .select()
    .from(mealLogs)
    .where(and(eq(mealLogs.userId, userId), gte(mealLogs.loggedAt, since)))
    .orderBy(sql`${mealLogs.loggedAt} desc`);
}
