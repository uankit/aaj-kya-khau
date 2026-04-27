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
import { relations, sql } from 'drizzle-orm';

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

export const surfaceEnum = pgEnum('surface', ['telegram']);

/* ------------------------------------------------------------------ */
/* users                                                              */
/* ------------------------------------------------------------------ */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Email is the primary identity for web-onboarded users. Nullable to
     * preserve compatibility with users created before web onboarding shipped
     * (Telegram-only flow). Once the legacy chat-onboarding path is deleted,
     * make this NOT NULL.
     */
    email: varchar('email', { length: 200 }),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    /**
     * Legacy: now nullable. New users sign up by email; telegram_id is
     * populated when they bind a Telegram surface. surface_bindings is the
     * new source of truth; we keep this column for the duration of the
     * migration to avoid breaking old code paths.
     */
    telegramId: varchar('telegram_id', { length: 30 }),
    /**
     * Where proactive sends (nudges, summaries) should land. Nullable until
     * the user binds at least one surface. Set on first bind, can be changed
     * later in settings.
     */
    primarySurface: surfaceEnum('primary_surface'),
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
    // Telegram ID is unique only when set. Postgres treats NULLs as distinct,
    // so this works as a "unique-when-not-null" index naturally.
    telegramIdUnique: uniqueIndex('users_telegram_id_unique').on(table.telegramId),
    // Same for email: unique partial index, NULLs ignored.
    emailUnique: uniqueIndex('users_email_unique')
      .on(table.email)
      .where(sql`${table.email} IS NOT NULL`),
  }),
);

export const usersRelations = relations(users, ({ many }) => ({
  schedules: many(userSchedules),
  inventory: many(inventoryItems),
  invoices: many(invoices),
  mealLogs: many(mealLogs),
  messages: many(messages),
  surfaceBindings: many(surfaceBindings),
}));

/* ------------------------------------------------------------------ */
/* surface_bindings — which chat surfaces are linked to a user.       */
/*                                                                    */
/* Replaces the single users.telegram_id column with an n-to-one      */
/* model: a user can have a Telegram binding AND a WhatsApp binding   */
/* simultaneously. Inbound messages on either surface look up the     */
/* user via (surface, external_id).                                   */
/* ------------------------------------------------------------------ */

export const surfaceBindings = pgTable(
  'surface_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    surface: surfaceEnum('surface').notNull(),
    /** Telegram chat_id, WhatsApp E.164 number (no "whatsapp:" prefix). */
    externalId: varchar('external_id', { length: 80 }).notNull(),
    boundAt: timestamp('bound_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One binding per (user, surface). Adding a second Telegram binding for
    // the same user replaces the existing one (handle in code).
    userSurfaceUnique: uniqueIndex('surface_bindings_user_surface_unique').on(
      table.userId,
      table.surface,
    ),
    // External IDs are globally unique within a surface — one Telegram chat
    // can't be bound to two users.
    surfaceExternalUnique: uniqueIndex('surface_bindings_surface_external_unique').on(
      table.surface,
      table.externalId,
    ),
  }),
);

export const surfaceBindingsRelations = relations(surfaceBindings, ({ one }) => ({
  user: one(users, { fields: [surfaceBindings.userId], references: [users.id] }),
}));

/* ------------------------------------------------------------------ */
/* bind_tokens — one-time tokens minted on the web during onboarding, */
/* consumed when the user first messages the chosen surface.          */
/* ------------------------------------------------------------------ */

export const bindTokens = pgTable(
  'bind_tokens',
  {
    token: varchar('token', { length: 32 }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    surface: surfaceEnum('surface').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index('bind_tokens_user_idx').on(table.userId),
    expiresIdx: index('bind_tokens_expires_idx').on(table.expiresAt),
  }),
);

/* ------------------------------------------------------------------ */
/* magic_link_tokens — email-based passwordless sign-in.              */
/*                                                                    */
/* Issued when a user submits their email; consumed when they click   */
/* the link. On consumption: find-or-create users row, set            */
/* email_verified_at, mint a session cookie.                          */
/* ------------------------------------------------------------------ */

export const magicLinkTokens = pgTable(
  'magic_link_tokens',
  {
    token: varchar('token', { length: 64 }).primaryKey(),
    email: varchar('email', { length: 200 }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailIdx: index('magic_link_tokens_email_idx').on(table.email),
    expiresIdx: index('magic_link_tokens_expires_idx').on(table.expiresAt),
  }),
);

/* ------------------------------------------------------------------ */
/* web_sessions — server-side session cookies for the web UI.         */
/*                                                                    */
/* Stored hashed: the cookie value the browser holds is the raw       */
/* token; we hash it before lookup. Compromise of the DB doesn't      */
/* leak active session tokens.                                        */
/* ------------------------------------------------------------------ */

export const webSessions = pgTable(
  'web_sessions',
  {
    /** SHA-256 hex of the raw session token. */
    tokenHash: varchar('token_hash', { length: 64 }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index('web_sessions_user_idx').on(table.userId),
    expiresIdx: index('web_sessions_expires_idx').on(table.expiresAt),
  }),
);

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
/* agent_tasks                                                        */
/*                                                                    */
/* Durable working memory for agentic workflows that span turns.      */
/* Example: Zepto order search → user picks/confirms → checkout.       */
/* Chat history is still useful for tone, but workflow state lives     */
/* here so short replies like "yes" can resume the right task.         */
/* ------------------------------------------------------------------ */

export const agentTasks = pgTable(
  'agent_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 50 }).notNull(),
    status: varchar('status', { length: 40 }).notNull().default('active'),
    state: jsonb('state').notNull().default({}),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userStatusIdx: index('agent_tasks_user_status_idx').on(table.userId, table.status),
    expiresAtIdx: index('agent_tasks_expires_at_idx').on(table.expiresAt),
  }),
);

export const agentTasksRelations = relations(agentTasks, ({ one }) => ({
  user: one(users, { fields: [agentTasks.userId], references: [users.id] }),
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
/* webhook_dedup                                                      */
/*                                                                    */
/* DB-backed deduplication of Telegram webhook deliveries. Telegram    */
/* retries an unresponded webhook aggressively, so in-memory dedup     */
/* (lost on every deploy) is not enough. The PK on message_sid column  */
/* (which we reuse to hold the Telegram update_id) combined with       */
/* INSERT ... ON CONFLICT DO NOTHING gives us atomic                   */
/* "has this been seen before?" checks.                                */
/*                                                                    */
/* Rows older than 24h are pruned opportunistically on insert.        */
/* ------------------------------------------------------------------ */

export const webhookDedup = pgTable(
  'webhook_dedup',
  {
    messageSid: varchar('message_sid', { length: 64 }).primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Cleanup queries filter by created_at — this index keeps that fast
    // even after the table has seen millions of rows.
    createdAtIdx: index('webhook_dedup_created_at_idx').on(table.createdAt),
  }),
);

export type WebhookDedup = typeof webhookDedup.$inferSelect;

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

export type AgentTask = typeof agentTasks.$inferSelect;
export type NewAgentTask = typeof agentTasks.$inferInsert;

/* ------------------------------------------------------------------ */
/* connected_accounts — OAuth-linked external grocery accounts        */
/*                                                                    */
/* One row per (user, provider). Access/refresh tokens are stored     */
/* AES-256-GCM encrypted. Decryption only happens inside the MCP      */
/* adapter layer; tokens never leave this module in plaintext and are */
/* never returned from any agent tool call.                           */
/* ------------------------------------------------------------------ */

export const oauthProviderEnum = pgEnum('oauth_provider', ['zepto', 'swiggy_instamart']);

export const accountStatusEnum = pgEnum('account_status', ['active', 'expired', 'revoked']);

export const connectedAccounts = pgTable(
  'connected_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: oauthProviderEnum('provider').notNull(),
    accessTokenCiphertext: text('access_token_ciphertext').notNull(),
    refreshTokenCiphertext: text('refresh_token_ciphertext'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    scopes: text('scopes'),
    status: accountStatusEnum('status').notNull().default('active'),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  },
  (table) => ({
    userProviderUnique: uniqueIndex('connected_accounts_user_provider_unique').on(
      table.userId,
      table.provider,
    ),
  }),
);

export const connectedAccountsRelations = relations(connectedAccounts, ({ one }) => ({
  user: one(users, { fields: [connectedAccounts.userId], references: [users.id] }),
}));

export type ConnectedAccount = typeof connectedAccounts.$inferSelect;
export type NewConnectedAccount = typeof connectedAccounts.$inferInsert;

/* ------------------------------------------------------------------ */
/* oauth_pending_states — ephemeral state for in-flight OAuth flows   */
/*                                                                    */
/* When a user taps "Connect Zepto" we stash {userId, code_verifier}  */
/* keyed by a random `state` param. On callback we look up the state  */
/* and finish the PKCE exchange. Rows are pruned opportunistically.   */
/* ------------------------------------------------------------------ */

export const oauthPendingStates = pgTable(
  'oauth_pending_states',
  {
    state: varchar('state', { length: 64 }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: oauthProviderEnum('provider').notNull(),
    codeVerifier: varchar('code_verifier', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    createdAtIdx: index('oauth_pending_states_created_at_idx').on(table.createdAt),
  }),
);

/* ------------------------------------------------------------------ */
/* Type exports for the new identity tables                           */
/* ------------------------------------------------------------------ */

export type SurfaceBinding = typeof surfaceBindings.$inferSelect;
export type NewSurfaceBinding = typeof surfaceBindings.$inferInsert;
export type BindToken = typeof bindTokens.$inferSelect;
export type NewBindToken = typeof bindTokens.$inferInsert;
export type MagicLinkToken = typeof magicLinkTokens.$inferSelect;
export type WebSession = typeof webSessions.$inferSelect;

/** Enum value type — 'telegram' | 'whatsapp'. */
export type Surface = (typeof surfaceEnum.enumValues)[number];
