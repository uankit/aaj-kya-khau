ALTER TABLE "users" ADD COLUMN "pantry_seed_status" text DEFAULT 'idle';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pantry_seed_count" integer;