/**
 * Default pantry staples — seed data for the `default_pantry_items` table.
 *
 * These are auto-added to every new user's inventory at the end of onboarding
 * so the agent doesn't say "you don't have salt" when suggesting dal.
 *
 * Schema fields:
 *   - region: NULL = universal, or 'north_india' / 'south_india' etc.
 *   - excludeDiet: NULL = all diets, or a diet_type to EXCLUDE.
 *     e.g. ghee is excluded for vegans (they won't get it seeded).
 *
 * This file is only used by the seed script (`npm run db:seed`).
 * The live app reads from the `default_pantry_items` table.
 * Adding a new staple = INSERT into the DB. No redeploy.
 */

export type DietType = 'veg' | 'non-veg' | 'egg' | 'vegan';

export interface PantrySeedItem {
  normalizedName: string;
  category: string;
  region?: string | null;
  excludeDiet?: DietType | null;
}

export const PANTRY_SEED: PantrySeedItem[] = [
  // ── Universal staples (every Indian household) ──
  { normalizedName: 'salt', category: 'spice' },
  { normalizedName: 'black salt', category: 'spice' },
  { normalizedName: 'sugar', category: 'spice' },
  { normalizedName: 'black pepper', category: 'spice' },

  // ── Core Indian spices ──
  { normalizedName: 'turmeric', category: 'spice' },
  { normalizedName: 'red chilli powder', category: 'spice' },
  { normalizedName: 'coriander powder', category: 'spice' },
  { normalizedName: 'cumin powder', category: 'spice' },
  { normalizedName: 'cumin seeds', category: 'spice' },
  { normalizedName: 'mustard seeds', category: 'spice' },
  { normalizedName: 'garam masala', category: 'spice' },
  { normalizedName: 'chaat masala', category: 'spice' },
  { normalizedName: 'hing', category: 'spice' },
  { normalizedName: 'ajwain', category: 'spice' },
  { normalizedName: 'methi seeds', category: 'spice' },

  // ── Whole spices ──
  { normalizedName: 'bay leaf', category: 'spice' },
  { normalizedName: 'cloves', category: 'spice' },
  { normalizedName: 'cardamom', category: 'spice' },
  { normalizedName: 'cinnamon', category: 'spice' },
  { normalizedName: 'dried red chillies', category: 'spice' },

  // ── Oils & cooking fats ──
  { normalizedName: 'cooking oil', category: 'oil' },
  // Ghee is excluded for vegans (it's clarified butter)
  { normalizedName: 'ghee', category: 'oil', excludeDiet: 'vegan' },

  // ── Tea / coffee ──
  { normalizedName: 'tea leaves', category: 'beverage' },

  // ── Regional examples (filter by region in onboarding query) ──
  // Leave these commented until you want to enable regional variants
  // { normalizedName: 'curry leaves', category: 'spice', region: 'south_india' },
  // { normalizedName: 'tamarind', category: 'condiment', region: 'south_india' },
  // { normalizedName: 'coconut oil', category: 'oil', region: 'south_india' },
];
