/**
 * Nutrition calculation engine.
 *
 * Science underneath, LLM on top.
 *
 * BMR:   Mifflin-St Jeor (Am J Clin Nutr 1990;51:241-7)
 * TDEE:  BMR × activity multiplier
 * Macros: ICMR-NIN RDA for Indians, 2020
 * Food data: IFCT 2017 (stored in `nutrition_foods` table)
 *
 * The LLM never invents nutritional data. It reads from this engine's output
 * and presents it in a friendly way.
 */

import { sql, ilike, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { nutritionFoods, users, mealLogs, type NutritionFood, type User } from '../db/schema.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('nutrition');

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface NutritionTargets {
  bmr: number;         // kcal/day (basal)
  tdee: number;        // kcal/day (with activity)
  calories: number;    // kcal/day (goal-adjusted)
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number;
}

export interface MealNutrition {
  totalCalories: number;
  totalProteinG: number;
  totalCarbsG: number;
  totalFatG: number;
  totalFiberG: number;
  breakdown: Array<{
    food: string;
    matchedTo: string;
    grams: number;
    calories: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
  }>;
}

export interface DailySummary {
  date: string;
  targets: NutritionTargets | null;
  consumed: {
    calories: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
    fiberG: number;
  };
  meals: Array<{
    mealType: string;
    description: string;
    calories: number | null;
    proteinG: number | null;
  }>;
  percentages: {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
  } | null;
}

// ─────────────────────────────────────────────
// BMR & TDEE (Mifflin-St Jeor, 1990)
// ─────────────────────────────────────────────

const ACTIVITY_MULTIPLIERS: Record<string, number> = {
  sedentary: 1.2,
  lightly_active: 1.375,
  moderately_active: 1.55,
  very_active: 1.725,
};

/**
 * Mifflin-St Jeor equation for BMR (Basal Metabolic Rate).
 *
 * Males:   (10 × weight_kg) + (6.25 × height_cm) - (5 × age) + 5
 * Females: (10 × weight_kg) + (6.25 × height_cm) - (5 × age) - 161
 *
 * Source: Mifflin MD et al. Am J Clin Nutr 1990;51:241-7.
 */
export function calculateBMR(
  weightKg: number,
  heightCm: number,
  age: number,
  gender: 'male' | 'female',
): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return Math.round(gender === 'male' ? base + 5 : base - 161);
}

export function calculateTDEE(bmr: number, activityLevel: string): number {
  const multiplier = ACTIVITY_MULTIPLIERS[activityLevel] ?? 1.2;
  return Math.round(bmr * multiplier);
}

/**
 * Goal-adjusted daily calories.
 *
 * Fat loss:   TDEE - 500 kcal/day (~0.5 kg/week, WHO TRS 916)
 * Maintain:   TDEE
 * Gain:       TDEE + 400 kcal/day
 */
export function goalAdjustedCalories(tdee: number, goal: string): number {
  switch (goal) {
    case 'lose': return Math.round(tdee - 500);
    case 'gain': return Math.round(tdee + 400);
    default:     return tdee;
  }
}

/**
 * ICMR-NIN RDA-based macronutrient targets.
 *
 * Protein: 1.0 g/kg (sedentary) to 1.4 g/kg (very active / gain goal)
 * Fat:     25% of total calories
 * Carbs:   remainder after protein + fat
 * Fiber:   30 g/day (ICMR-NIN 2020)
 *
 * Source: ICMR-NIN Expert Group, "Nutrient Requirements for Indians", 2020.
 */
export function calculateTargets(
  weightKg: number,
  heightCm: number,
  age: number,
  gender: 'male' | 'female',
  activityLevel: string,
  goal: string,
): NutritionTargets {
  const bmr = calculateBMR(weightKg, heightCm, age, gender);
  const tdee = calculateTDEE(bmr, activityLevel);
  const calories = goalAdjustedCalories(tdee, goal);

  // Protein: scale with activity + goal
  let proteinPerKg = 1.0;
  if (activityLevel === 'moderately_active') proteinPerKg = 1.2;
  if (activityLevel === 'very_active') proteinPerKg = 1.4;
  if (goal === 'gain') proteinPerKg = Math.max(proteinPerKg, 1.4);
  if (goal === 'lose') proteinPerKg = Math.max(proteinPerKg, 1.2); // preserve muscle

  const proteinG = Math.round(weightKg * proteinPerKg);
  const proteinCals = proteinG * 4;

  // Fat: 25% of calories (ICMR-NIN mid-range of 20-30%)
  const fatCals = calories * 0.25;
  const fatG = Math.round(fatCals / 9);

  // Carbs: remainder
  const carbsCals = calories - proteinCals - fatCals;
  const carbsG = Math.round(carbsCals / 4);

  const fiberG = 30; // ICMR-NIN 2020 recommendation

  return { bmr, tdee, calories, proteinG, carbsG, fatG, fiberG };
}

// ─────────────────────────────────────────────
// Food lookup from PostgreSQL
// ─────────────────────────────────────────────

/**
 * Fuzzy-match a food name against the `nutrition_foods` table.
 * Checks both the `name` column and the `aliases` JSONB array.
 */
export async function lookupFood(query: string): Promise<NutritionFood | null> {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return null;

  // Exact name match first
  const exact = await db
    .select()
    .from(nutritionFoods)
    .where(sql`lower(${nutritionFoods.name}) = ${q}`)
    .limit(1);
  if (exact.length > 0) return exact[0]!;

  // Alias match (check if any alias in the JSONB array matches)
  const aliasMatch = await db
    .select()
    .from(nutritionFoods)
    .where(sql`${nutritionFoods.aliases}::jsonb @> ${JSON.stringify([q])}::jsonb`)
    .limit(1);
  if (aliasMatch.length > 0) return aliasMatch[0]!;

  // Partial name match (ILIKE)
  const partial = await db
    .select()
    .from(nutritionFoods)
    .where(ilike(nutritionFoods.name, `%${q}%`))
    .limit(1);
  if (partial.length > 0) return partial[0]!;

  return null;
}

/** Get all foods in DB (for passing to LLM context when needed). */
export async function getAllFoodNames(): Promise<string[]> {
  const rows = await db
    .select({ name: nutritionFoods.name })
    .from(nutritionFoods)
    .orderBy(nutritionFoods.name);
  return rows.map((r) => r.name);
}

// ─────────────────────────────────────────────
// Meal nutrition estimation
// ─────────────────────────────────────────────

export interface FoodPortion {
  food: string;        // name the LLM extracted
  servings: number;    // how many standard servings (default 1)
}

/**
 * Given a list of (food, servings) pairs, look each up in the DB and
 * calculate totals. This is the deterministic core — the LLM's job is
 * only to decompose "poha with chai" → [{food:"poha", servings:1}, {food:"chai", servings:1}].
 */
export async function estimateMealNutrition(
  items: FoodPortion[],
): Promise<MealNutrition> {
  const breakdown: MealNutrition['breakdown'] = [];
  let totalCal = 0, totalP = 0, totalC = 0, totalF = 0, totalFi = 0;

  for (const item of items) {
    const food = await lookupFood(item.food);
    if (!food) {
      log.debug(`No nutrition match for "${item.food}"`);
      continue;
    }

    const grams = food.servingSizeG * item.servings;
    const factor = grams / 100;
    const cal = Math.round(food.caloriesPer100g * factor);
    const p = Math.round(food.proteinPer100g * factor);
    const c = Math.round(food.carbsPer100g * factor);
    const f = Math.round(food.fatPer100g * factor);
    const fi = Math.round(food.fiberPer100g * factor);

    breakdown.push({
      food: item.food,
      matchedTo: food.name,
      grams,
      calories: cal,
      proteinG: p,
      carbsG: c,
      fatG: f,
    });

    totalCal += cal;
    totalP += p;
    totalC += c;
    totalF += f;
    totalFi += fi;
  }

  return {
    totalCalories: totalCal,
    totalProteinG: totalP,
    totalCarbsG: totalC,
    totalFatG: totalF,
    totalFiberG: totalFi,
    breakdown,
  };
}

// ─────────────────────────────────────────────
// Daily nutrition summary
// ─────────────────────────────────────────────

/**
 * Builds a daily nutrition summary for a user.
 * Used by the agent to present "you've had X of Y calories today".
 */
export async function getDailySummary(
  userId: string,
  dateYmd: string, // YYYY-MM-DD
): Promise<DailySummary> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new Error(`User ${userId} not found`);

  // Get today's meals
  const todayMeals = await db
    .select()
    .from(mealLogs)
    .where(
      sql`${mealLogs.userId} = ${userId} AND date(${mealLogs.loggedAt} AT TIME ZONE ${user.timezone}) = ${dateYmd}`,
    );

  const consumed = {
    calories: 0,
    proteinG: 0,
    carbsG: 0,
    fatG: 0,
    fiberG: 0,
  };

  const meals = todayMeals.map((m) => {
    consumed.calories += m.estimatedCalories ?? 0;
    consumed.proteinG += m.estimatedProteinG ?? 0;
    consumed.carbsG += m.estimatedCarbsG ?? 0;
    consumed.fatG += m.estimatedFatG ?? 0;
    consumed.fiberG += m.estimatedFiberG ?? 0;
    return {
      mealType: m.mealType,
      description: m.description,
      calories: m.estimatedCalories,
      proteinG: m.estimatedProteinG,
    };
  });

  // Build targets if user has health profile
  let targets: NutritionTargets | null = null;
  let percentages: DailySummary['percentages'] = null;

  if (user.age && user.gender && user.heightCm && user.weightKg && user.activityLevel) {
    targets = calculateTargets(
      user.weightKg,
      user.heightCm,
      user.age,
      user.gender,
      user.activityLevel,
      user.healthGoal ?? 'maintain',
    );
    percentages = {
      calories: targets.calories > 0 ? Math.round((consumed.calories / targets.calories) * 100) : 0,
      protein: targets.proteinG > 0 ? Math.round((consumed.proteinG / targets.proteinG) * 100) : 0,
      carbs: targets.carbsG > 0 ? Math.round((consumed.carbsG / targets.carbsG) * 100) : 0,
      fat: targets.fatG > 0 ? Math.round((consumed.fatG / targets.fatG) * 100) : 0,
    };
  }

  return { date: dateYmd, targets, consumed, meals, percentages };
}

// ─────────────────────────────────────────────
// User health profile persistence
// ─────────────────────────────────────────────

export interface HealthProfileInput {
  age: number;
  gender: 'male' | 'female';
  heightCm: number;
  weightKg: number;
  activityLevel: string;
  healthGoal: string;
}

/**
 * Saves the user's health profile AND pre-calculates their nutrition targets.
 * Returns the calculated targets so the agent can present them.
 */
export async function saveHealthProfile(
  userId: string,
  input: HealthProfileInput,
): Promise<NutritionTargets> {
  const targets = calculateTargets(
    input.weightKg,
    input.heightCm,
    input.age,
    input.gender as 'male' | 'female',
    input.activityLevel,
    input.healthGoal,
  );

  await db
    .update(users)
    .set({
      age: input.age,
      gender: input.gender as 'male' | 'female',
      heightCm: input.heightCm,
      weightKg: input.weightKg,
      activityLevel: input.activityLevel as User['activityLevel'],
      healthGoal: input.healthGoal as User['healthGoal'],
      bmr: targets.bmr,
      tdee: targets.tdee,
      dailyCaloriesTarget: targets.calories,
      dailyProteinTargetG: targets.proteinG,
      dailyCarbsTargetG: targets.carbsG,
      dailyFatTargetG: targets.fatG,
      dailyFiberTargetG: targets.fiberG,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  log.info(`Health profile saved for ${userId}: BMR=${targets.bmr}, TDEE=${targets.tdee}, target=${targets.calories} kcal`);
  return targets;
}
