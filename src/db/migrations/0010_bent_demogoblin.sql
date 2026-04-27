ALTER TABLE "public"."bind_tokens" ALTER COLUMN "surface" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "public"."surface_bindings" ALTER COLUMN "surface" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "public"."users" ALTER COLUMN "primary_surface" SET DATA TYPE text;--> statement-breakpoint
-- Purge any WhatsApp-flagged data before narrowing the enum, otherwise the
-- USING cast below errors with "invalid input value for enum surface".
DELETE FROM "public"."bind_tokens" WHERE "surface" = 'whatsapp';--> statement-breakpoint
DELETE FROM "public"."surface_bindings" WHERE "surface" = 'whatsapp';--> statement-breakpoint
UPDATE "public"."users" SET "primary_surface" = NULL WHERE "primary_surface" = 'whatsapp';--> statement-breakpoint
DROP TYPE "public"."surface";--> statement-breakpoint
CREATE TYPE "public"."surface" AS ENUM('telegram');--> statement-breakpoint
ALTER TABLE "public"."bind_tokens" ALTER COLUMN "surface" SET DATA TYPE "public"."surface" USING "surface"::"public"."surface";--> statement-breakpoint
ALTER TABLE "public"."surface_bindings" ALTER COLUMN "surface" SET DATA TYPE "public"."surface" USING "surface"::"public"."surface";--> statement-breakpoint
ALTER TABLE "public"."users" ALTER COLUMN "primary_surface" SET DATA TYPE "public"."surface" USING "primary_surface"::"public"."surface";