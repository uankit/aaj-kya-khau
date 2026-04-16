/**
 * Default pantry staples that every Indian kitchen is assumed to have.
 *
 * These are auto-added to a user's inventory at the end of onboarding so the
 * agent doesn't annoyingly say "you don't have salt" when suggesting dal.
 *
 * Users can still remove items via chat ("haldi khatam") and re-add them
 * ("got haldi") — these are just sensible defaults.
 */

export interface PantryItem {
  normalizedName: string;
  category: string;
}

export const DEFAULT_PANTRY: PantryItem[] = [
  // Salts & basics
  { normalizedName: 'salt', category: 'spice' },
  { normalizedName: 'black salt', category: 'spice' },
  { normalizedName: 'sugar', category: 'spice' },
  { normalizedName: 'black pepper', category: 'spice' },

  // Core Indian spices
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

  // Whole spices
  { normalizedName: 'bay leaf', category: 'spice' },
  { normalizedName: 'cloves', category: 'spice' },
  { normalizedName: 'cardamom', category: 'spice' },
  { normalizedName: 'cinnamon', category: 'spice' },
  { normalizedName: 'dried red chillies', category: 'spice' },

  // Oils & cooking fats
  { normalizedName: 'cooking oil', category: 'oil' },
  { normalizedName: 'ghee', category: 'oil' },

  // Tea / coffee
  { normalizedName: 'tea leaves', category: 'beverage' },
];
