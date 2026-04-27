/**
 * Onboarding API — profile, schedule, surface bind, complete.
 *
 * All routes require an authenticated user (loaded via auth-middleware).
 */

import { randomBytes } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../config/database.js';
import { env } from '../config/env.js';
import { bindTokens, userSchedules, users } from '../db/schema.js';
import { hasZeptoConnected } from '../providers/grocery/zepto/account.js';
import { createLogger } from '../utils/logger.js';
import { loadUser, requireAuth } from './auth-middleware.js';

const log = createLogger('web-onboarding');

const profileSchema = z.object({
  name: z.string().min(1).max(100),
  dietType: z.enum(['veg', 'non-veg', 'egg', 'vegan']).optional(),
  timezone: z.string().min(1).max(40).optional(),
});

const scheduleSchema = z.object({
  /** When omitted, applies the standard healthy Indian timings. */
  useDefaults: z.boolean().optional(),
  meals: z
    .array(
      z.object({
        mealType: z.enum(['breakfast', 'lunch', 'snack', 'dinner']),
        /** "HH:MM" in user's local timezone */
        remindAt: z.string().regex(/^\d{2}:\d{2}$/),
        enabled: z.boolean().default(true),
      }),
    )
    .optional(),
  nightlySummaryAt: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});

const DEFAULT_MEALS = [
  { mealType: 'breakfast' as const, remindAt: '08:00', enabled: true },
  { mealType: 'lunch' as const, remindAt: '13:00', enabled: true },
  { mealType: 'snack' as const, remindAt: '17:00', enabled: true },
  { mealType: 'dinner' as const, remindAt: '20:30', enabled: true },
];
const DEFAULT_NIGHTLY = '22:00';

const bindSchema = z.object({
  surface: z.enum(['telegram']),
});

function bindTokenString(): string {
  // 16 chars base32-ish, easy to type, hard to guess.
  return randomBytes(12).toString('base64url');
}

export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/me — auth check + return current onboarding state.
  app.get('/api/me', { preHandler: loadUser }, async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'unauthorized' });
    const u = request.user;
    const zeptoConnected = await hasZeptoConnected(u.id);
    return reply.send({
      id: u.id,
      email: u.email,
      name: u.name,
      dietType: u.dietType,
      timezone: u.timezone,
      onboardingComplete: u.onboardingComplete,
      primarySurface: u.primarySurface,
      nightlySummaryAt: u.nightlySummaryAt,
      zeptoConnected,
    });
  });

  // PATCH /api/me/profile
  app.patch('/api/me/profile', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = profileSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
    const u = request.user!;
    await db
      .update(users)
      .set({
        name: parsed.data.name,
        dietType: parsed.data.dietType ?? u.dietType,
        timezone: parsed.data.timezone ?? u.timezone,
        updatedAt: new Date(),
      })
      .where(eq(users.id, u.id));
    return reply.send({ ok: true });
  });

  // PATCH /api/me/schedule
  app.patch('/api/me/schedule', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = scheduleSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
    const u = request.user!;

    const meals =
      parsed.data.useDefaults || !parsed.data.meals?.length
        ? DEFAULT_MEALS
        : parsed.data.meals;
    const nightly = parsed.data.nightlySummaryAt ?? DEFAULT_NIGHTLY;

    // Replace existing schedules: delete + insert. Simpler than upsert
    // when meal_type is the unique key and the user might add/remove meals.
    await db.delete(userSchedules).where(eq(userSchedules.userId, u.id));
    if (meals.length > 0) {
      await db.insert(userSchedules).values(
        meals.map((m) => ({
          userId: u.id,
          mealType: m.mealType,
          remindAt: `${m.remindAt}:00`,
          enabled: m.enabled,
        })),
      );
    }
    await db
      .update(users)
      .set({ nightlySummaryAt: `${nightly}:00`, updatedAt: new Date() })
      .where(eq(users.id, u.id));

    return reply.send({ ok: true, mealsCount: meals.length });
  });

  // POST /api/me/bind/start — mint a one-time token + return deep link.
  app.post('/api/me/bind/start', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = bindSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    const u = request.user!;
    const token = bindTokenString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await db.insert(bindTokens).values({
      token,
      userId: u.id,
      surface: parsed.data.surface,
      expiresAt,
    });

    const base = env.PUBLIC_BASE_URL ?? `http://${request.headers.host ?? 'localhost:3000'}`;
    // /start payload — Telegram passes it as the first /start arg.
    const botUsername = await resolveTelegramBotUsername();
    const deepLink = botUsername
      ? `https://t.me/${botUsername}?start=${token}`
      : `${base}/api/bind/telegram-help?token=${token}`;

    log.info(`bind token issued for user=${u.id} surface=${parsed.data.surface}`);
    return reply.send({ token, deepLink, expiresAt });
  });

  // POST /api/me/onboarding/complete
  app.post('/api/me/onboarding/complete', { preHandler: requireAuth }, async (request, reply) => {
    const u = request.user!;
    await db
      .update(users)
      .set({ onboardingComplete: true, updatedAt: new Date() })
      .where(eq(users.id, u.id));
    return reply.send({ ok: true });
  });
}

let cachedBotUsername: string | null = null;
async function resolveTelegramBotUsername(): Promise<string | null> {
  if (cachedBotUsername) return cachedBotUsername;
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
    const json = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    cachedBotUsername = json.result?.username ?? null;
    return cachedBotUsername;
  } catch (err) {
    log.warn('resolveTelegramBotUsername failed', err);
    return null;
  }
}
