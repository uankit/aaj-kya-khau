/**
 * Seeds the `nutrition_foods` table with IFCT 2017 data.
 *
 * Run: `npm run db:seed`
 *
 * Idempotent — uses ON CONFLICT DO UPDATE on name, so re-running won't
 * duplicate entries. It will update existing rows if values have changed.
 */

import { db, pool } from '../config/database.js';
import { nutritionFoods } from './schema.js';
import { NUTRITION_SEED } from '../data/nutrition-seed.js';
import { sql } from 'drizzle-orm';

async function main() {
  // eslint-disable-next-line no-console
  console.log(`Seeding ${NUTRITION_SEED.length} items into nutrition_foods...`);

  let inserted = 0;
  let updated = 0;

  for (const item of NUTRITION_SEED) {
    // Check if exists
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
  console.log(`Done. ${inserted} inserted, ${updated} updated.`);
  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Seed failed:', err);
  process.exit(1);
});
