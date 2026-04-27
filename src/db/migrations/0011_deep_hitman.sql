DROP TABLE "surface_bindings" CASCADE;--> statement-breakpoint
ALTER TABLE "bind_tokens" DROP COLUMN IF EXISTS "surface";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "primary_surface";--> statement-breakpoint
DROP TYPE "public"."surface";