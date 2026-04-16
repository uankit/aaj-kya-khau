import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { users, type User } from '../db/schema.js';
import { env } from '../config/env.js';

/** Fetches a user by phone, or creates a blank onboarding row if they're new. */
export async function getOrCreateUserByPhone(phone: string): Promise<User> {
  const existing = await db.query.users.findFirst({ where: eq(users.phone, phone) });
  if (existing) return existing;

  const [created] = await db
    .insert(users)
    .values({
      phone,
      timezone: env.DEFAULT_TIMEZONE,
      onboardingStep: 'ask_name',
      onboardingComplete: false,
    })
    .returning();
  if (!created) throw new Error('Failed to create user');
  return created;
}
