import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  boolean,
  timestamp,
  text,
  time,
  jsonb,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

/* ------------------------------------------------------------------ */
/* Enums                                                              */
/* ------------------------------------------------------------------ */

export const dietTypeEnum = pgEnum('diet_type', ['veg', 'non-veg', 'egg', 'vegan']);

export const mealTypeEnum = pgEnum('meal_type', ['breakfast', 'lunch', 'snack', 'dinner']);

export const onboardingStepEnum = pgEnum('onboarding_step', [
  'ask_name',
  'ask_diet',
  'ask_breakfast_time',
  'ask_lunch_time',
  'ask_snack_time',
  'ask_dinner_time',
  'complete',
]);

export const inventorySourceEnum = pgEnum('inventory_source', ['invoice', 'manual']);

export const confidenceEnum = pgEnum('confidence', ['high', 'medium', 'low']);

export const invoiceStatusEnum = pgEnum('invoice_status', ['processing', 'completed', 'failed']);

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant', 'system']);

export const genderEnum = pgEnum('gender', ['male', 'female']);

export const activityLevelEnum = pgEnum('activity_level', [
  'sedentary',
  'lightly_active',
  'moderately_active',
  'very_active',
]);

export const healthGoalEnum = pgEnum('health_goal', ['lose', 'maintain', 'gain']);

/* ------------------------------------------------------------------ */
/* users                                                              */
/* ------------------------------------------------------------------ */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phone: varchar('phone', { length: 20 }).notNull(),
    name: varchar('name', { length: 100 }),
    dietType: dietTypeEnum('diet_type'),
    timezone: varchar('timezone', { length: 40 }).notNull().default('Asia/Kolkata'),
    onboardingComplete: boolean('onboarding_complete').notNull().default(false),
    onboardingStep: onboardingStepEnum('onboarding_step').notNull().default('ask_name'),
    nightlySummaryAt: time('nightly_summary_at').notNull().default('22:00:00'),
    // Health profile (nullable — collected via agent, not onboarding)
    age: integer('age'),
    gender: genderEnum('gender'),
    heightCm: integer('height_cm'),
    weightKg: integer('weight_kg'),
    activityLevel: activityLevelEnum('activity_level'),
    healthGoal: healthGoalEnum('health_goal'),
    // Calculated nutrition targets (Mifflin-St Jeor + ICMR-NIN)
    bmr: integer('bmr'),
    tdee: integer('tdee'),
    dailyCaloriesTarget: integer('daily_calories_target'),
    dailyProteinTargetG: integer('daily_protein_target_g'),
    dailyCarbsTargetG: integer('daily_carbs_target_g'),
    dailyFatTargetG: integer('daily_fat_target_g'),
    dailyFiberTargetG: integer('daily_fiber_target_g'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    phoneUnique: uniqueIndex('users_phone_unique').on(table.phone),
  }),
);

export const usersRelations = relations(users, ({ many }) => ({
  schedules: many(userSchedules),
  inventory: many(inventoryItems),
  invoices: many(invoices),
  mealLogs: many(mealLogs),
  messages: many(messages),
}));

/* ------------------------------------------------------------------ */
/* user_schedules                                                     */
/* ------------------------------------------------------------------ */

export const userSchedules = pgTable(
  'user_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mealType: mealTypeEnum('meal_type').notNull(),
    remindAt: time('remind_at').notNull(), // HH:MM:SS in user's local tz
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userMealUnique: uniqueIndex('user_schedules_user_meal_unique').on(
      table.userId,
      table.mealType,
    ),
  }),
);

export const userSchedulesRelations = relations(userSchedules, ({ one }) => ({
  user: one(users, { fields: [userSchedules.userId], references: [users.id] }),
}));

/* ------------------------------------------------------------------ */
/* invoices                                                           */
/* ------------------------------------------------------------------ */

export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  mediaUrl: text('media_url'),
  rawText: text('raw_text'),
  parsedItems: jsonb('parsed_items'),
  itemCount: integer('item_count').notNull().default(0),
  status: invoiceStatusEnum('status').notNull().default('processing'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  user: one(users, { fields: [invoices.userId], references: [users.id] }),
  items: many(inventoryItems),
}));

/* ------------------------------------------------------------------ */
/* inventory_items                                                    */
/* ------------------------------------------------------------------ */

export const inventoryItems = pgTable(
  'inventory_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rawName: varchar('raw_name', { length: 255 }),
    normalizedName: varchar('normalized_name', { length: 100 }).notNull(),
    category: varchar('category', { length: 50 }),
    quantity: varchar('quantity', { length: 50 }),
    isAvailable: boolean('is_available').notNull().default(true),
    source: inventorySourceEnum('source').notNull().default('manual'),
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    confidence: confidenceEnum('confidence').notNull().default('high'),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => ({
    userAvailableIdx: index('inventory_user_available_idx').on(table.userId, table.isAvailable),
    userNameIdx: index('inventory_user_name_idx').on(table.userId, table.normalizedName),
  }),
);

export const inventoryItemsRelations = relations(inventoryItems, ({ one }) => ({
  user: one(users, { fields: [inventoryItems.userId], references: [users.id] }),
  invoice: one(invoices, { fields: [inventoryItems.invoiceId], references: [invoices.id] }),
}));

/* ------------------------------------------------------------------ */
/* meal_logs                                                          */
/* ------------------------------------------------------------------ */

export const mealLogs = pgTable(
  'meal_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mealType: mealTypeEnum('meal_type').notNull(),
    description: text('description').notNull(),
    itemsUsed: jsonb('items_used'),
    wasJunk: boolean('was_junk'),
    suggestedByBot: boolean('suggested_by_bot').notNull().default(false),
    // Nutrition tracking (estimated from IFCT 2017 data)
    estimatedCalories: integer('estimated_calories'),
    estimatedProteinG: integer('estimated_protein_g'),
    estimatedCarbsG: integer('estimated_carbs_g'),
    estimatedFatG: integer('estimated_fat_g'),
    estimatedFiberG: integer('estimated_fiber_g'),
    nutritionBreakdown: jsonb('nutrition_breakdown'), // [{food, grams, cal, protein, carbs, fat}]
    loggedAt: timestamp('logged_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userLoggedIdx: index('meal_logs_user_logged_idx').on(table.userId, table.loggedAt),
  }),
);

export const mealLogsRelations = relations(mealLogs, ({ one }) => ({
  user: one(users, { fields: [mealLogs.userId], references: [users.id] }),
}));

/* ------------------------------------------------------------------ */
/* messages (short-term memory for the agent)                         */
/* ------------------------------------------------------------------ */

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: messageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    toolCalls: jsonb('tool_calls'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCreatedIdx: index('messages_user_created_idx').on(table.userId, table.createdAt),
  }),
);

export const messagesRelations = relations(messages, ({ one }) => ({
  user: one(users, { fields: [messages.userId], references: [users.id] }),
}));

/* ------------------------------------------------------------------ */
/* nutrition_foods (IFCT 2017 food composition database)              */
/* ------------------------------------------------------------------ */

export const nutritionFoods = pgTable(
  'nutrition_foods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 100 }).notNull(),
    aliases: jsonb('aliases').notNull().default([]),
    caloriesPer100g: integer('calories_per_100g').notNull(),
    proteinPer100g: integer('protein_per_100g').notNull(),
    carbsPer100g: integer('carbs_per_100g').notNull(),
    fatPer100g: integer('fat_per_100g').notNull(),
    fiberPer100g: integer('fiber_per_100g').notNull().default(0),
    servingSizeG: integer('serving_size_g').notNull().default(100),
    servingDescription: varchar('serving_description', { length: 100 }),
    category: varchar('category', { length: 50 }).notNull(),
    source: varchar('source', { length: 50 }).notNull().default('IFCT 2017'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: index('nutrition_foods_name_idx').on(table.name),
  }),
);

export type NutritionFood = typeof nutritionFoods.$inferSelect;
export type NewNutritionFood = typeof nutritionFoods.$inferInsert;

/* ------------------------------------------------------------------ */
/* default_pantry_items                                               */
/*                                                                    */
/* The curated "assumed-in-every-kitchen" list seeded into each new   */
/* user's inventory at the end of onboarding. Lives in the DB (not TS)*/
/* so new items / regional variants can be added without redeploy.    */
/* ------------------------------------------------------------------ */

export const defaultPantryItems = pgTable('default_pantry_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  normalizedName: varchar('normalized_name', { length: 100 }).notNull(),
  category: varchar('category', { length: 50 }).notNull(),
  // NULL = universal. Set to 'north_india', 'south_india', etc. to scope.
  region: varchar('region', { length: 30 }),
  // NULL = all diets. Set to a diet_type to EXCLUDE from that diet.
  // e.g. ghee has excludeDiet = 'vegan' so vegans don't get ghee seeded.
  excludeDiet: dietTypeEnum('exclude_diet'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type DefaultPantryItem = typeof defaultPantryItems.$inferSelect;
export type NewDefaultPantryItem = typeof defaultPantryItems.$inferInsert;

/* ------------------------------------------------------------------ */
/* Exported types                                                     */
/* ------------------------------------------------------------------ */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type UserSchedule = typeof userSchedules.$inferSelect;
export type NewUserSchedule = typeof userSchedules.$inferInsert;

export type InventoryItem = typeof inventoryItems.$inferSelect;
export type NewInventoryItem = typeof inventoryItems.$inferInsert;

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;

export type MealLog = typeof mealLogs.$inferSelect;
export type NewMealLog = typeof mealLogs.$inferInsert;

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
