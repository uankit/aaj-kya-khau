/**
 * IFCT 2017 — Indian Food Composition Tables seed data.
 *
 * Source: Longvah T, Ananthan R, Bhaskarachary K, Venkaiah K.
 *   "Indian Food Composition Tables." National Institute of Nutrition,
 *   Indian Council of Medical Research, 2017.
 *
 * Values are per 100g of edible portion. Where IFCT doesn't cover a
 * prepared/processed item (e.g. Maggi, biscuits), USDA FoodData Central
 * or manufacturer labels are used and marked source = 'USDA' or 'label'.
 *
 * This file is only used by the seed script (`npm run db:seed`).
 * The live app reads from the `nutrition_foods` table in PostgreSQL.
 * To add new foods → INSERT into the DB. No code redeploy needed.
 */

export interface NutritionSeedItem {
  name: string;
  aliases: string[];
  caloriesPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatPer100g: number;
  fiberPer100g: number;
  servingSizeG: number;
  servingDescription: string;
  category: string;
  source: string;
}

export const NUTRITION_SEED: NutritionSeedItem[] = [
  // ═══════════════════════════════════════════
  // CEREALS & GRAINS (cooked / ready-to-eat)
  // ═══════════════════════════════════════════
  {
    name: 'rice (cooked)',
    aliases: ['chawal', 'steamed rice', 'white rice', 'basmati rice'],
    caloriesPer100g: 130, proteinPer100g: 3, carbsPer100g: 28, fatPer100g: 0, fiberPer100g: 0,
    servingSizeG: 180, servingDescription: '1 katori / bowl', category: 'grain', source: 'IFCT 2017',
  },
  {
    name: 'roti',
    aliases: ['chapati', 'phulka', 'wheat roti'],
    caloriesPer100g: 240, proteinPer100g: 8, carbsPer100g: 42, fatPer100g: 5, fiberPer100g: 4,
    servingSizeG: 40, servingDescription: '1 roti', category: 'grain', source: 'IFCT 2017',
  },
  {
    name: 'paratha',
    aliases: ['aloo paratha', 'stuffed paratha', 'plain paratha'],
    caloriesPer100g: 260, proteinPer100g: 7, carbsPer100g: 36, fatPer100g: 10, fiberPer100g: 3,
    servingSizeG: 80, servingDescription: '1 paratha', category: 'grain', source: 'IFCT 2017',
  },
  {
    name: 'bread',
    aliases: ['white bread', 'brown bread', 'toast', 'pav'],
    caloriesPer100g: 265, proteinPer100g: 8, carbsPer100g: 50, fatPer100g: 3, fiberPer100g: 3,
    servingSizeG: 30, servingDescription: '1 slice', category: 'grain', source: 'IFCT 2017',
  },
  {
    name: 'poha (cooked)',
    aliases: ['flattened rice', 'chivda', 'beaten rice cooked'],
    caloriesPer100g: 140, proteinPer100g: 3, carbsPer100g: 26, fatPer100g: 3, fiberPer100g: 1,
    servingSizeG: 200, servingDescription: '1 plate', category: 'prepared', source: 'IFCT 2017',
  },
  {
    name: 'upma',
    aliases: ['suji upma', 'rava upma', 'semolina upma'],
    caloriesPer100g: 130, proteinPer100g: 3, carbsPer100g: 20, fatPer100g: 4, fiberPer100g: 1,
    servingSizeG: 200, servingDescription: '1 plate', category: 'prepared', source: 'IFCT 2017',
  },
  {
    name: 'idli',
    aliases: ['steamed idli', 'rava idli'],
    caloriesPer100g: 130, proteinPer100g: 4, carbsPer100g: 24, fatPer100g: 1, fiberPer100g: 1,
    servingSizeG: 40, servingDescription: '1 idli', category: 'prepared', source: 'IFCT 2017',
  },
  {
    name: 'dosa',
    aliases: ['plain dosa', 'masala dosa', 'crispy dosa'],
    caloriesPer100g: 168, proteinPer100g: 4, carbsPer100g: 27, fatPer100g: 5, fiberPer100g: 1,
    servingSizeG: 80, servingDescription: '1 dosa', category: 'prepared', source: 'IFCT 2017',
  },
  {
    name: 'oats (cooked)',
    aliases: ['oatmeal', 'porridge', 'rolled oats'],
    caloriesPer100g: 71, proteinPer100g: 3, carbsPer100g: 12, fatPer100g: 2, fiberPer100g: 2,
    servingSizeG: 240, servingDescription: '1 bowl', category: 'grain', source: 'IFCT 2017',
  },
  {
    name: 'atta',
    aliases: ['wheat flour', 'whole wheat flour', 'gehun ka atta'],
    caloriesPer100g: 341, proteinPer100g: 12, carbsPer100g: 65, fatPer100g: 2, fiberPer100g: 11,
    servingSizeG: 30, servingDescription: '2 tbsp / 1 roti worth', category: 'grain', source: 'IFCT 2017',
  },
  {
    name: 'puri',
    aliases: ['poori', 'deep fried bread'],
    caloriesPer100g: 350, proteinPer100g: 7, carbsPer100g: 42, fatPer100g: 17, fiberPer100g: 2,
    servingSizeG: 25, servingDescription: '1 puri', category: 'grain', source: 'IFCT 2017',
  },
  {
    name: 'naan',
    aliases: ['butter naan', 'garlic naan', 'tandoori naan'],
    caloriesPer100g: 290, proteinPer100g: 9, carbsPer100g: 48, fatPer100g: 7, fiberPer100g: 2,
    servingSizeG: 90, servingDescription: '1 naan', category: 'grain', source: 'IFCT 2017',
  },
  // ═══════════════════════════════════════════
  // PULSES & DALS (cooked)
  // ═══════════════════════════════════════════
  {
    name: 'toor dal (cooked)',
    aliases: ['arhar dal', 'pigeon pea', 'dal', 'yellow dal'],
    caloriesPer100g: 118, proteinPer100g: 7, carbsPer100g: 17, fatPer100g: 2, fiberPer100g: 3,
    servingSizeG: 150, servingDescription: '1 katori', category: 'pulse', source: 'IFCT 2017',
  },
  {
    name: 'moong dal (cooked)',
    aliases: ['green gram dal', 'moong', 'mung dal'],
    caloriesPer100g: 105, proteinPer100g: 7, carbsPer100g: 15, fatPer100g: 1, fiberPer100g: 3,
    servingSizeG: 150, servingDescription: '1 katori', category: 'pulse', source: 'IFCT 2017',
  },
  {
    name: 'chana dal (cooked)',
    aliases: ['bengal gram dal', 'split chickpea'],
    caloriesPer100g: 116, proteinPer100g: 7, carbsPer100g: 18, fatPer100g: 2, fiberPer100g: 4,
    servingSizeG: 150, servingDescription: '1 katori', category: 'pulse', source: 'IFCT 2017',
  },
  {
    name: 'masoor dal (cooked)',
    aliases: ['red lentil', 'lentil dal', 'masoor'],
    caloriesPer100g: 116, proteinPer100g: 9, carbsPer100g: 16, fatPer100g: 1, fiberPer100g: 2,
    servingSizeG: 150, servingDescription: '1 katori', category: 'pulse', source: 'IFCT 2017',
  },
  {
    name: 'rajma (cooked)',
    aliases: ['kidney beans', 'rajma curry', 'rajma chawal'],
    caloriesPer100g: 127, proteinPer100g: 9, carbsPer100g: 17, fatPer100g: 2, fiberPer100g: 6,
    servingSizeG: 150, servingDescription: '1 katori', category: 'pulse', source: 'IFCT 2017',
  },
  {
    name: 'chole (cooked)',
    aliases: ['chickpeas', 'chana', 'chole masala', 'chana masala', 'kabuli chana'],
    caloriesPer100g: 164, proteinPer100g: 9, carbsPer100g: 22, fatPer100g: 4, fiberPer100g: 6,
    servingSizeG: 150, servingDescription: '1 katori', category: 'pulse', source: 'IFCT 2017',
  },
  {
    name: 'urad dal (cooked)',
    aliases: ['black gram dal', 'dhuli urad'],
    caloriesPer100g: 105, proteinPer100g: 7, carbsPer100g: 14, fatPer100g: 2, fiberPer100g: 3,
    servingSizeG: 150, servingDescription: '1 katori', category: 'pulse', source: 'IFCT 2017',
  },
  {
    name: 'sprouts (moong)',
    aliases: ['moong sprouts', 'sprouted moong', 'ankurit moong'],
    caloriesPer100g: 30, proteinPer100g: 3, carbsPer100g: 4, fatPer100g: 0, fiberPer100g: 2,
    servingSizeG: 100, servingDescription: '1 katori', category: 'pulse', source: 'IFCT 2017',
  },
  // ═══════════════════════════════════════════
  // DAIRY
  // ═══════════════════════════════════════════
  {
    name: 'milk (toned)',
    aliases: ['milk', 'toned milk', 'dudh'],
    caloriesPer100g: 58, proteinPer100g: 3, carbsPer100g: 5, fatPer100g: 3, fiberPer100g: 0,
    servingSizeG: 200, servingDescription: '1 glass', category: 'dairy', source: 'IFCT 2017',
  },
  {
    name: 'milk (full cream)',
    aliases: ['whole milk', 'full fat milk'],
    caloriesPer100g: 72, proteinPer100g: 3, carbsPer100g: 5, fatPer100g: 4, fiberPer100g: 0,
    servingSizeG: 200, servingDescription: '1 glass', category: 'dairy', source: 'IFCT 2017',
  },
  {
    name: 'curd',
    aliases: ['dahi', 'yogurt', 'yoghurt', 'plain curd'],
    caloriesPer100g: 60, proteinPer100g: 3, carbsPer100g: 5, fatPer100g: 3, fiberPer100g: 0,
    servingSizeG: 100, servingDescription: '1 katori', category: 'dairy', source: 'IFCT 2017',
  },
  {
    name: 'paneer',
    aliases: ['cottage cheese', 'paneer cubes'],
    caloriesPer100g: 265, proteinPer100g: 18, carbsPer100g: 3, fatPer100g: 21, fiberPer100g: 0,
    servingSizeG: 80, servingDescription: '~5-6 cubes', category: 'dairy', source: 'IFCT 2017',
  },
  {
    name: 'cheese',
    aliases: ['processed cheese', 'cheese slice', 'cheddar'],
    caloriesPer100g: 349, proteinPer100g: 24, carbsPer100g: 2, fatPer100g: 28, fiberPer100g: 0,
    servingSizeG: 20, servingDescription: '1 slice', category: 'dairy', source: 'IFCT 2017',
  },
  {
    name: 'butter',
    aliases: ['makhan', 'amul butter'],
    caloriesPer100g: 717, proteinPer100g: 1, carbsPer100g: 0, fatPer100g: 81, fiberPer100g: 0,
    servingSizeG: 10, servingDescription: '1 tbsp', category: 'dairy', source: 'IFCT 2017',
  },
  {
    name: 'ghee',
    aliases: ['clarified butter', 'desi ghee'],
    caloriesPer100g: 897, proteinPer100g: 0, carbsPer100g: 0, fatPer100g: 100, fiberPer100g: 0,
    servingSizeG: 5, servingDescription: '1 tsp', category: 'oil', source: 'IFCT 2017',
  },
  {
    name: 'buttermilk',
    aliases: ['chaas', 'mattha', 'salted lassi'],
    caloriesPer100g: 19, proteinPer100g: 1, carbsPer100g: 2, fatPer100g: 1, fiberPer100g: 0,
    servingSizeG: 200, servingDescription: '1 glass', category: 'dairy', source: 'IFCT 2017',
  },
  {
    name: 'lassi (sweet)',
    aliases: ['punjabi lassi', 'mango lassi'],
    caloriesPer100g: 75, proteinPer100g: 2, carbsPer100g: 12, fatPer100g: 2, fiberPer100g: 0,
    servingSizeG: 200, servingDescription: '1 glass', category: 'dairy', source: 'IFCT 2017',
  },
  // ═══════════════════════════════════════════
  // EGGS & MEAT
  // ═══════════════════════════════════════════
  {
    name: 'egg (boiled)',
    aliases: ['anda', 'boiled egg', 'whole egg'],
    caloriesPer100g: 155, proteinPer100g: 13, carbsPer100g: 1, fatPer100g: 11, fiberPer100g: 0,
    servingSizeG: 50, servingDescription: '1 egg', category: 'egg', source: 'IFCT 2017',
  },
  {
    name: 'egg omelette',
    aliases: ['omelette', 'anda omelette', 'masala omelette'],
    caloriesPer100g: 175, proteinPer100g: 11, carbsPer100g: 1, fatPer100g: 14, fiberPer100g: 0,
    servingSizeG: 60, servingDescription: '1 omelette (1 egg)', category: 'egg', source: 'IFCT 2017',
  },
  {
    name: 'chicken breast (cooked)',
    aliases: ['grilled chicken', 'chicken breast', 'boiled chicken'],
    caloriesPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 4, fiberPer100g: 0,
    servingSizeG: 120, servingDescription: '1 piece', category: 'meat', source: 'IFCT 2017',
  },
  {
    name: 'chicken curry',
    aliases: ['chicken masala', 'chicken gravy', 'butter chicken'],
    caloriesPer100g: 148, proteinPer100g: 15, carbsPer100g: 5, fatPer100g: 8, fiberPer100g: 1,
    servingSizeG: 200, servingDescription: '1 serving', category: 'meat', source: 'IFCT 2017',
  },
  {
    name: 'fish curry',
    aliases: ['machhi', 'fish masala', 'fish fry'],
    caloriesPer100g: 140, proteinPer100g: 16, carbsPer100g: 3, fatPer100g: 7, fiberPer100g: 0,
    servingSizeG: 150, servingDescription: '1 piece with gravy', category: 'meat', source: 'IFCT 2017',
  },
  {
    name: 'mutton curry',
    aliases: ['mutton', 'goat curry', 'lamb curry'],
    caloriesPer100g: 194, proteinPer100g: 18, carbsPer100g: 3, fatPer100g: 12, fiberPer100g: 0,
    servingSizeG: 200, servingDescription: '1 serving', category: 'meat', source: 'IFCT 2017',
  },
  {
    name: 'keema',
    aliases: ['minced meat', 'chicken keema', 'mutton keema'],
    caloriesPer100g: 180, proteinPer100g: 16, carbsPer100g: 4, fatPer100g: 11, fiberPer100g: 1,
    servingSizeG: 150, servingDescription: '1 katori', category: 'meat', source: 'IFCT 2017',
  },
  // ═══════════════════════════════════════════
  // VEGETABLES
  // ═══════════════════════════════════════════
  {
    name: 'potato',
    aliases: ['aloo', 'batata'],
    caloriesPer100g: 77, proteinPer100g: 2, carbsPer100g: 17, fatPer100g: 0, fiberPer100g: 2,
    servingSizeG: 120, servingDescription: '1 medium', category: 'vegetable', source: 'IFCT 2017',
  },
  {
    name: 'onion',
    aliases: ['pyaaz', 'kanda'],
    caloriesPer100g: 40, proteinPer100g: 1, carbsPer100g: 9, fatPer100g: 0, fiberPer100g: 2,
    servingSizeG: 100, servingDescription: '1 medium', category: 'vegetable', source: 'IFCT 2017',
  },
  {
    name: 'tomato',
    aliases: ['tamatar'],
    caloriesPer100g: 18, proteinPer100g: 1, carbsPer100g: 4, fatPer100g: 0, fiberPer100g: 1,
    servingSizeG: 80, servingDescription: '1 medium', category: 'vegetable', source: 'IFCT 2017',
  },
  {
    name: 'spinach',
    aliases: ['palak', 'saag'],
    caloriesPer100g: 23, proteinPer100g: 3, carbsPer100g: 2, fatPer100g: 0, fiberPer100g: 2,
    servingSizeG: 100, servingDescription: '1 cup raw', category: 'vegetable', source: 'IFCT 2017',
  },
  {
    name: 'cauliflower',
    aliases: ['gobi', 'phool gobi'],
    caloriesPer100g: 25, proteinPer100g: 2, carbsPer100g: 5, fatPer100g: 0, fiberPer100g: 2,
    servingSizeG: 100, servingDescription: '1 cup', category: 'vegetable', source: 'IFCT 2017',
  },
  {
    name: 'capsicum',
    aliases: ['shimla mirch', 'bell pepper'],
    caloriesPer100g: 28, proteinPer100g: 1, carbsPer100g: 5, fatPer100g: 0, fiberPer100g: 2,
    servingSizeG: 80, servingDescription: '1 medium', category: 'vegetable', source: 'IFCT 2017',
  },
  {
    name: 'peas',
    aliases: ['matar', 'green peas', 'har matar'],
    caloriesPer100g: 81, proteinPer100g: 5, carbsPer100g: 14, fatPer100g: 0, fiberPer100g: 5,
    servingSizeG: 80, servingDescription: '1/2 cup', category: 'vegetable', source: 'IFCT 2017',
  },
  {
    name: 'carrot',
    aliases: ['gajar'],
    caloriesPer100g: 41, proteinPer100g: 1, carbsPer100g: 10, fatPer100g: 0, fiberPer100g: 3,
    servingSizeG: 80, servingDescription: '1 medium', category: 'vegetable', source: 'IFCT 2017',
  },
  {
    name: 'beans',
    aliases: ['french beans', 'green beans', 'string beans'],
    caloriesPer100g: 31, proteinPer100g: 2, carbsPer100g: 7, fatPer100g: 0, fiberPer100g: 3,
    servingSizeG: 80, servingDescription: '1 cup chopped', category: 'vegetable', source: 'IFCT 2017',
  },
  {
    name: 'bhindi',
    aliases: ['okra', 'ladyfinger'],
    caloriesPer100g: 33, proteinPer100g: 2, carbsPer100g: 7, fatPer100g: 0, fiberPer100g: 3,
    servingSizeG: 80, servingDescription: '1 cup', category: 'vegetable', source: 'IFCT 2017',
  },
  {
    name: 'brinjal',
    aliases: ['baingan', 'eggplant', 'aubergine'],
    caloriesPer100g: 25, proteinPer100g: 1, carbsPer100g: 6, fatPer100g: 0, fiberPer100g: 3,
    servingSizeG: 100, servingDescription: '1 medium', category: 'vegetable', source: 'IFCT 2017',
  },
  {
    name: 'lauki',
    aliases: ['bottle gourd', 'ghiya', 'doodhi'],
    caloriesPer100g: 14, proteinPer100g: 1, carbsPer100g: 3, fatPer100g: 0, fiberPer100g: 1,
    servingSizeG: 150, servingDescription: '1 cup', category: 'vegetable', source: 'IFCT 2017',
  },
  {
    name: 'tinda',
    aliases: ['round gourd', 'apple gourd'],
    caloriesPer100g: 18, proteinPer100g: 1, carbsPer100g: 4, fatPer100g: 0, fiberPer100g: 1,
    servingSizeG: 100, servingDescription: '2-3 pieces', category: 'vegetable', source: 'IFCT 2017',
  },
  {
    name: 'cabbage',
    aliases: ['patta gobhi', 'bandh gobhi'],
    caloriesPer100g: 25, proteinPer100g: 1, carbsPer100g: 6, fatPer100g: 0, fiberPer100g: 3,
    servingSizeG: 80, servingDescription: '1 cup shredded', category: 'vegetable', source: 'IFCT 2017',
  },
  {
    name: 'mushroom',
    aliases: ['kumbh', 'button mushroom'],
    caloriesPer100g: 22, proteinPer100g: 3, carbsPer100g: 3, fatPer100g: 0, fiberPer100g: 1,
    servingSizeG: 80, servingDescription: '1 cup', category: 'vegetable', source: 'IFCT 2017',
  },
  {
    name: 'sweet potato',
    aliases: ['shakarkand', 'shakarkandi'],
    caloriesPer100g: 86, proteinPer100g: 2, carbsPer100g: 20, fatPer100g: 0, fiberPer100g: 3,
    servingSizeG: 120, servingDescription: '1 medium', category: 'vegetable', source: 'IFCT 2017',
  },
  {
    name: 'corn',
    aliases: ['makka', 'bhutta', 'sweet corn', 'maize'],
    caloriesPer100g: 86, proteinPer100g: 3, carbsPer100g: 19, fatPer100g: 1, fiberPer100g: 2,
    servingSizeG: 100, servingDescription: '1 ear', category: 'vegetable', source: 'IFCT 2017',
  },
  // ═══════════════════════════════════════════
  // FRUITS
  // ═══════════════════════════════════════════
  {
    name: 'banana',
    aliases: ['kela'],
    caloriesPer100g: 89, proteinPer100g: 1, carbsPer100g: 23, fatPer100g: 0, fiberPer100g: 3,
    servingSizeG: 120, servingDescription: '1 medium', category: 'fruit', source: 'IFCT 2017',
  },
  {
    name: 'apple',
    aliases: ['seb'],
    caloriesPer100g: 52, proteinPer100g: 0, carbsPer100g: 14, fatPer100g: 0, fiberPer100g: 2,
    servingSizeG: 180, servingDescription: '1 medium', category: 'fruit', source: 'IFCT 2017',
  },
  {
    name: 'mango',
    aliases: ['aam', 'alphonso', 'hapus'],
    caloriesPer100g: 60, proteinPer100g: 1, carbsPer100g: 15, fatPer100g: 0, fiberPer100g: 2,
    servingSizeG: 150, servingDescription: '1 medium / 1 cup', category: 'fruit', source: 'IFCT 2017',
  },
  {
    name: 'papaya',
    aliases: ['papita'],
    caloriesPer100g: 43, proteinPer100g: 0, carbsPer100g: 11, fatPer100g: 0, fiberPer100g: 2,
    servingSizeG: 150, servingDescription: '1 cup', category: 'fruit', source: 'IFCT 2017',
  },
  {
    name: 'orange',
    aliases: ['santra', 'mosambi', 'sweet lime'],
    caloriesPer100g: 47, proteinPer100g: 1, carbsPer100g: 12, fatPer100g: 0, fiberPer100g: 2,
    servingSizeG: 130, servingDescription: '1 medium', category: 'fruit', source: 'IFCT 2017',
  },
  {
    name: 'watermelon',
    aliases: ['tarbooz', 'tarbuj'],
    caloriesPer100g: 30, proteinPer100g: 1, carbsPer100g: 8, fatPer100g: 0, fiberPer100g: 0,
    servingSizeG: 250, servingDescription: '1 slice', category: 'fruit', source: 'IFCT 2017',
  },
  {
    name: 'guava',
    aliases: ['amrood'],
    caloriesPer100g: 68, proteinPer100g: 3, carbsPer100g: 14, fatPer100g: 1, fiberPer100g: 5,
    servingSizeG: 100, servingDescription: '1 medium', category: 'fruit', source: 'IFCT 2017',
  },
  {
    name: 'grapes',
    aliases: ['angoor'],
    caloriesPer100g: 69, proteinPer100g: 1, carbsPer100g: 18, fatPer100g: 0, fiberPer100g: 1,
    servingSizeG: 100, servingDescription: '~15-20 grapes', category: 'fruit', source: 'IFCT 2017',
  },
  {
    name: 'pomegranate',
    aliases: ['anaar', 'anar'],
    caloriesPer100g: 83, proteinPer100g: 2, carbsPer100g: 19, fatPer100g: 1, fiberPer100g: 4,
    servingSizeG: 100, servingDescription: '1/2 medium', category: 'fruit', source: 'IFCT 2017',
  },
  // ═══════════════════════════════════════════
  // NUTS & SEEDS
  // ═══════════════════════════════════════════
  {
    name: 'peanuts',
    aliases: ['moongfali', 'groundnuts'],
    caloriesPer100g: 567, proteinPer100g: 26, carbsPer100g: 16, fatPer100g: 49, fiberPer100g: 9,
    servingSizeG: 30, servingDescription: 'a handful', category: 'nut', source: 'IFCT 2017',
  },
  {
    name: 'almonds',
    aliases: ['badam'],
    caloriesPer100g: 579, proteinPer100g: 21, carbsPer100g: 22, fatPer100g: 50, fiberPer100g: 13,
    servingSizeG: 20, servingDescription: '~10-12 almonds', category: 'nut', source: 'IFCT 2017',
  },
  {
    name: 'cashews',
    aliases: ['kaju'],
    caloriesPer100g: 553, proteinPer100g: 18, carbsPer100g: 30, fatPer100g: 44, fiberPer100g: 3,
    servingSizeG: 20, servingDescription: '~8-10 cashews', category: 'nut', source: 'IFCT 2017',
  },
  {
    name: 'walnuts',
    aliases: ['akhrot'],
    caloriesPer100g: 654, proteinPer100g: 15, carbsPer100g: 14, fatPer100g: 65, fiberPer100g: 7,
    servingSizeG: 20, servingDescription: '~4-5 halves', category: 'nut', source: 'IFCT 2017',
  },
  {
    name: 'peanut butter',
    aliases: ['pb'],
    caloriesPer100g: 588, proteinPer100g: 25, carbsPer100g: 20, fatPer100g: 50, fiberPer100g: 6,
    servingSizeG: 20, servingDescription: '1 tbsp', category: 'nut', source: 'label',
  },
  // ═══════════════════════════════════════════
  // PREPARED DISHES (common Indian home meals)
  // ═══════════════════════════════════════════
  {
    name: 'dal chawal',
    aliases: ['dal rice', 'dal bhat'],
    caloriesPer100g: 115, proteinPer100g: 4, carbsPer100g: 19, fatPer100g: 2, fiberPer100g: 2,
    servingSizeG: 350, servingDescription: '1 plate (dal + rice)', category: 'prepared', source: 'IFCT 2017',
  },
  {
    name: 'rajma chawal',
    aliases: ['rajma rice'],
    caloriesPer100g: 120, proteinPer100g: 5, carbsPer100g: 19, fatPer100g: 2, fiberPer100g: 3,
    servingSizeG: 350, servingDescription: '1 plate', category: 'prepared', source: 'IFCT 2017',
  },
  {
    name: 'chole chawal',
    aliases: ['chana chawal', 'chole rice'],
    caloriesPer100g: 135, proteinPer100g: 5, carbsPer100g: 21, fatPer100g: 3, fiberPer100g: 3,
    servingSizeG: 350, servingDescription: '1 plate', category: 'prepared', source: 'IFCT 2017',
  },
  {
    name: 'kadhi chawal',
    aliases: ['kadhi rice', 'besan kadhi'],
    caloriesPer100g: 110, proteinPer100g: 3, carbsPer100g: 18, fatPer100g: 3, fiberPer100g: 1,
    servingSizeG: 350, servingDescription: '1 plate', category: 'prepared', source: 'IFCT 2017',
  },
  {
    name: 'biryani (veg)',
    aliases: ['veg biryani', 'pulao'],
    caloriesPer100g: 146, proteinPer100g: 3, carbsPer100g: 22, fatPer100g: 5, fiberPer100g: 1,
    servingSizeG: 250, servingDescription: '1 plate', category: 'prepared', source: 'IFCT 2017',
  },
  {
    name: 'biryani (chicken)',
    aliases: ['chicken biryani', 'non-veg biryani', 'dum biryani'],
    caloriesPer100g: 168, proteinPer100g: 9, carbsPer100g: 20, fatPer100g: 6, fiberPer100g: 1,
    servingSizeG: 250, servingDescription: '1 plate', category: 'prepared', source: 'IFCT 2017',
  },
  {
    name: 'khichdi',
    aliases: ['masala khichdi', 'dal khichdi', 'moong khichdi'],
    caloriesPer100g: 110, proteinPer100g: 4, carbsPer100g: 18, fatPer100g: 2, fiberPer100g: 2,
    servingSizeG: 250, servingDescription: '1 bowl', category: 'prepared', source: 'IFCT 2017',
  },
  {
    name: 'mixed veg sabzi',
    aliases: ['sabzi', 'subzi', 'mixed vegetable curry'],
    caloriesPer100g: 75, proteinPer100g: 2, carbsPer100g: 8, fatPer100g: 4, fiberPer100g: 2,
    servingSizeG: 150, servingDescription: '1 katori', category: 'prepared', source: 'IFCT 2017',
  },
  {
    name: 'aloo gobi',
    aliases: ['potato cauliflower'],
    caloriesPer100g: 80, proteinPer100g: 2, carbsPer100g: 11, fatPer100g: 3, fiberPer100g: 2,
    servingSizeG: 150, servingDescription: '1 katori', category: 'prepared', source: 'IFCT 2017',
  },
  {
    name: 'palak paneer',
    aliases: ['spinach paneer', 'saag paneer'],
    caloriesPer100g: 138, proteinPer100g: 8, carbsPer100g: 5, fatPer100g: 10, fiberPer100g: 2,
    servingSizeG: 150, servingDescription: '1 katori', category: 'prepared', source: 'IFCT 2017',
  },
  {
    name: 'paneer bhurji',
    aliases: ['scrambled paneer'],
    caloriesPer100g: 190, proteinPer100g: 12, carbsPer100g: 5, fatPer100g: 14, fiberPer100g: 1,
    servingSizeG: 150, servingDescription: '1 katori', category: 'prepared', source: 'IFCT 2017',
  },
  {
    name: 'fried rice',
    aliases: ['veg fried rice', 'chinese fried rice'],
    caloriesPer100g: 163, proteinPer100g: 4, carbsPer100g: 24, fatPer100g: 6, fiberPer100g: 1,
    servingSizeG: 250, servingDescription: '1 plate', category: 'prepared', source: 'IFCT 2017',
  },
  {
    name: 'pasta (cooked)',
    aliases: ['macaroni', 'penne', 'spaghetti'],
    caloriesPer100g: 131, proteinPer100g: 5, carbsPer100g: 25, fatPer100g: 1, fiberPer100g: 2,
    servingSizeG: 200, servingDescription: '1 plate', category: 'prepared', source: 'USDA',
  },
  // ═══════════════════════════════════════════
  // SNACKS & JUNK
  // ═══════════════════════════════════════════
  {
    name: 'maggi',
    aliases: ['noodles', 'instant noodles', 'ramen'],
    caloriesPer100g: 390, proteinPer100g: 8, carbsPer100g: 56, fatPer100g: 15, fiberPer100g: 2,
    servingSizeG: 70, servingDescription: '1 packet', category: 'snack', source: 'label',
  },
  {
    name: 'samosa',
    aliases: ['aloo samosa'],
    caloriesPer100g: 262, proteinPer100g: 4, carbsPer100g: 28, fatPer100g: 15, fiberPer100g: 2,
    servingSizeG: 80, servingDescription: '1 samosa', category: 'snack', source: 'IFCT 2017',
  },
  {
    name: 'pakora',
    aliases: ['pakoda', 'bhajiya', 'onion pakora'],
    caloriesPer100g: 240, proteinPer100g: 5, carbsPer100g: 22, fatPer100g: 15, fiberPer100g: 2,
    servingSizeG: 80, servingDescription: '4-5 pieces', category: 'snack', source: 'IFCT 2017',
  },
  {
    name: 'bhel puri',
    aliases: ['bhel', 'chaat'],
    caloriesPer100g: 190, proteinPer100g: 5, carbsPer100g: 32, fatPer100g: 5, fiberPer100g: 3,
    servingSizeG: 150, servingDescription: '1 plate', category: 'snack', source: 'IFCT 2017',
  },
  {
    name: 'sandwich',
    aliases: ['veg sandwich', 'grilled sandwich', 'bread sandwich'],
    caloriesPer100g: 230, proteinPer100g: 7, carbsPer100g: 28, fatPer100g: 10, fiberPer100g: 2,
    servingSizeG: 150, servingDescription: '1 sandwich', category: 'snack', source: 'IFCT 2017',
  },
  {
    name: 'biscuits',
    aliases: ['cookies', 'cream biscuit', 'parle-g', 'marie'],
    caloriesPer100g: 450, proteinPer100g: 6, carbsPer100g: 68, fatPer100g: 17, fiberPer100g: 2,
    servingSizeG: 25, servingDescription: '3-4 biscuits', category: 'snack', source: 'label',
  },
  {
    name: 'chips',
    aliases: ['potato chips', 'wafers', 'lays', 'kurkure'],
    caloriesPer100g: 536, proteinPer100g: 7, carbsPer100g: 53, fatPer100g: 35, fiberPer100g: 4,
    servingSizeG: 30, servingDescription: 'small packet', category: 'snack', source: 'label',
  },
  {
    name: 'pizza',
    aliases: ['pizza slice'],
    caloriesPer100g: 266, proteinPer100g: 11, carbsPer100g: 33, fatPer100g: 10, fiberPer100g: 2,
    servingSizeG: 110, servingDescription: '1 slice', category: 'snack', source: 'USDA',
  },
  {
    name: 'burger',
    aliases: ['veg burger', 'chicken burger'],
    caloriesPer100g: 250, proteinPer100g: 10, carbsPer100g: 28, fatPer100g: 11, fiberPer100g: 2,
    servingSizeG: 180, servingDescription: '1 burger', category: 'snack', source: 'USDA',
  },
  // ═══════════════════════════════════════════
  // BEVERAGES
  // ═══════════════════════════════════════════
  {
    name: 'tea with milk',
    aliases: ['chai', 'masala chai', 'cutting chai', 'doodh chai'],
    caloriesPer100g: 37, proteinPer100g: 1, carbsPer100g: 5, fatPer100g: 1, fiberPer100g: 0,
    servingSizeG: 150, servingDescription: '1 cup', category: 'beverage', source: 'IFCT 2017',
  },
  {
    name: 'coffee with milk',
    aliases: ['coffee', 'filter coffee', 'instant coffee'],
    caloriesPer100g: 30, proteinPer100g: 1, carbsPer100g: 4, fatPer100g: 1, fiberPer100g: 0,
    servingSizeG: 150, servingDescription: '1 cup', category: 'beverage', source: 'IFCT 2017',
  },
  {
    name: 'fresh juice',
    aliases: ['orange juice', 'mango juice', 'mixed fruit juice'],
    caloriesPer100g: 45, proteinPer100g: 1, carbsPer100g: 11, fatPer100g: 0, fiberPer100g: 0,
    servingSizeG: 200, servingDescription: '1 glass', category: 'beverage', source: 'IFCT 2017',
  },
  {
    name: 'nimbu pani',
    aliases: ['lemonade', 'shikanji', 'lime water'],
    caloriesPer100g: 25, proteinPer100g: 0, carbsPer100g: 6, fatPer100g: 0, fiberPer100g: 0,
    servingSizeG: 200, servingDescription: '1 glass', category: 'beverage', source: 'IFCT 2017',
  },
  {
    name: 'coconut water',
    aliases: ['nariyal pani', 'tender coconut'],
    caloriesPer100g: 19, proteinPer100g: 0, carbsPer100g: 4, fatPer100g: 0, fiberPer100g: 0,
    servingSizeG: 250, servingDescription: '1 glass', category: 'beverage', source: 'IFCT 2017',
  },
  // ═══════════════════════════════════════════
  // SWEETMEATS & DESSERTS
  // ═══════════════════════════════════════════
  {
    name: 'gulab jamun',
    aliases: ['gulab jaman'],
    caloriesPer100g: 325, proteinPer100g: 5, carbsPer100g: 45, fatPer100g: 14, fiberPer100g: 0,
    servingSizeG: 40, servingDescription: '1 piece', category: 'dessert', source: 'IFCT 2017',
  },
  {
    name: 'rasgulla',
    aliases: ['rosogolla'],
    caloriesPer100g: 186, proteinPer100g: 5, carbsPer100g: 35, fatPer100g: 3, fiberPer100g: 0,
    servingSizeG: 50, servingDescription: '1 piece', category: 'dessert', source: 'IFCT 2017',
  },
  {
    name: 'kheer',
    aliases: ['rice kheer', 'payasam'],
    caloriesPer100g: 130, proteinPer100g: 3, carbsPer100g: 20, fatPer100g: 4, fiberPer100g: 0,
    servingSizeG: 150, servingDescription: '1 katori', category: 'dessert', source: 'IFCT 2017',
  },
  {
    name: 'halwa',
    aliases: ['suji halwa', 'gajar halwa', 'moong dal halwa'],
    caloriesPer100g: 250, proteinPer100g: 3, carbsPer100g: 35, fatPer100g: 12, fiberPer100g: 1,
    servingSizeG: 100, servingDescription: '1 katori', category: 'dessert', source: 'IFCT 2017',
  },
  {
    name: 'jalebi',
    aliases: ['imarti'],
    caloriesPer100g: 380, proteinPer100g: 3, carbsPer100g: 56, fatPer100g: 16, fiberPer100g: 0,
    servingSizeG: 50, servingDescription: '2-3 pieces', category: 'dessert', source: 'IFCT 2017',
  },
  // ═══════════════════════════════════════════
  // MISCELLANEOUS STAPLES
  // ═══════════════════════════════════════════
  {
    name: 'raita',
    aliases: ['boondi raita', 'cucumber raita'],
    caloriesPer100g: 50, proteinPer100g: 2, carbsPer100g: 5, fatPer100g: 2, fiberPer100g: 0,
    servingSizeG: 100, servingDescription: '1 katori', category: 'prepared', source: 'IFCT 2017',
  },
  {
    name: 'pickle',
    aliases: ['achaar', 'mango pickle', 'lime pickle'],
    caloriesPer100g: 150, proteinPer100g: 2, carbsPer100g: 6, fatPer100g: 13, fiberPer100g: 2,
    servingSizeG: 10, servingDescription: '1 tsp', category: 'condiment', source: 'IFCT 2017',
  },
  {
    name: 'papad',
    aliases: ['papadum', 'appalam'],
    caloriesPer100g: 340, proteinPer100g: 19, carbsPer100g: 47, fatPer100g: 7, fiberPer100g: 5,
    servingSizeG: 15, servingDescription: '1 papad', category: 'snack', source: 'IFCT 2017',
  },
  {
    name: 'chutney (coconut)',
    aliases: ['coconut chutney', 'nariyal chutney'],
    caloriesPer100g: 110, proteinPer100g: 2, carbsPer100g: 6, fatPer100g: 9, fiberPer100g: 2,
    servingSizeG: 30, servingDescription: '2 tbsp', category: 'condiment', source: 'IFCT 2017',
  },
  {
    name: 'sambhar',
    aliases: ['sambar', 'sambaar'],
    caloriesPer100g: 50, proteinPer100g: 2, carbsPer100g: 7, fatPer100g: 1, fiberPer100g: 2,
    servingSizeG: 150, servingDescription: '1 katori', category: 'prepared', source: 'IFCT 2017',
  },
];
