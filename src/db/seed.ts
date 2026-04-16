/**
 * Seeds reference tables:
 *   - `nutrition_foods` (IFCT 2017 food composition data)
 *   - `default_pantry_items` (staples auto-added at onboarding)
 *
 * Run: `npm run db:seed`
 *
 * Idempotent: existing rows with the same canonical name are UPDATED,
 * not duplicated. Safe to re-run on every deploy.
 */

import { db, pool } from '../config/database.js';
import { nutritionFoods, defaultPantryItems } from './schema.js';
import { NUTRITION_SEED } from '../data/nutrition-seed.js';
import { PANTRY_SEED } from '../data/pantry-seed.js';
import { sql, and, eq, isNull } from 'drizzle-orm';

async function seedNutritionFoods() {
  // eslint-disable-next-line no-console
  console.log(`Seeding ${NUTRITION_SEED.length} items into nutrition_foods...`);

  let inserted = 0;
  let updated = 0;

  for (const item of NUTRITION_SEED) {
    const existing = await db
      .select()
      .from(nutritionFoods)
      .where(sql`lower(${nutritionFoods.name}) = ${item.name.toLowerCase()}`)
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(nutritionFoods)
        .set({
          aliases: item.aliases,
          caloriesPer100g: item.caloriesPer100g,
          proteinPer100g: item.proteinPer100g,
          carbsPer100g: item.carbsPer100g,
          fatPer100g: item.fatPer100g,
          fiberPer100g: item.fiberPer100g,
          servingSizeG: item.servingSizeG,
          servingDescription: item.servingDescription,
          category: item.category,
          source: item.source,
        })
        .where(sql`lower(${nutritionFoods.name}) = ${item.name.toLowerCase()}`);
      updated++;
    } else {
      await db.insert(nutritionFoods).values({
        name: item.name,
        aliases: item.aliases,
        caloriesPer100g: item.caloriesPer100g,
        proteinPer100g: item.proteinPer100g,
        carbsPer100g: item.carbsPer100g,
        fatPer100g: item.fatPer100g,
        fiberPer100g: item.fiberPer100g,
        servingSizeG: item.servingSizeG,
        servingDescription: item.servingDescription,
        category: item.category,
        source: item.source,
      });
      inserted++;
    }
  }

  // eslint-disable-next-line no-console
  console.log(`  nutrition_foods: ${inserted} inserted, ${updated} updated.`);
}

async function seedDefaultPantry() {
  // eslint-disable-next-line no-console
  console.log(`Seeding ${PANTRY_SEED.length} items into default_pantry_items...`);

  let inserted = 0;
  let updated = 0;

  for (const item of PANTRY_SEED) {
    // Uniqueness key: (normalizedName, region). Same item can appear with
    // different regions/diet filters, so we scope the match.
    const regionClause =
      item.region != null
        ? eq(defaultPantryItems.region, item.region)
        : isNull(defaultPantryItems.region);

    const existing = await db
      .select()
      .from(defaultPantryItems)
      .where(
        and(
          sql`lower(${defaultPantryItems.normalizedName}) = ${item.normalizedName.toLowerCase()}`,
          regionClause,
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(defaultPantryItems)
        .set({
          category: item.category,
          excludeDiet: item.excludeDiet ?? null,
        })
        .where(eq(defaultPantryItems.id, existing[0]!.id));
      updated++;
    } else {
      await db.insert(defaultPantryItems).values({
        normalizedName: item.normalizedName,
        category: item.category,
        region: item.region ?? null,
        excludeDiet: item.excludeDiet ?? null,
      });
      inserted++;
    }
  }

  // eslint-disable-next-line no-console
  console.log(`  default_pantry_items: ${inserted} inserted, ${updated} updated.`);
}

async function main() {
  await seedNutritionFoods();
  await seedDefaultPantry();
  // eslint-disable-next-line no-console
  console.log('Seed complete.');
  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Seed failed:', err);
  process.exit(1);
});
