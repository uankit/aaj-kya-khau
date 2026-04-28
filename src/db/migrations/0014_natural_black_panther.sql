ALTER TABLE "users" ADD COLUMN "preferred_surface" text;--> statement-breakpoint
-- Backfill: legacy users with a Telegram binding default to 'telegram'.
-- New rows pick their surface during onboarding.
UPDATE "users" SET "preferred_surface" = 'telegram' WHERE "telegram_id" IS NOT NULL AND "preferred_surface" IS NULL;
