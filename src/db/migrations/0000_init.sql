CREATE TYPE "public"."confidence" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."diet_type" AS ENUM('veg', 'non-veg', 'egg', 'vegan');--> statement-breakpoint
CREATE TYPE "public"."inventory_source" AS ENUM('invoice', 'manual');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."meal_type" AS ENUM('breakfast', 'lunch', 'snack', 'dinner');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'system');--> statement-breakpoint
CREATE TYPE "public"."onboarding_step" AS ENUM('ask_name', 'ask_diet', 'ask_breakfast_time', 'ask_lunch_time', 'ask_snack_time', 'ask_dinner_time', 'complete');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"raw_name" varchar(255),
	"normalized_name" varchar(100) NOT NULL,
	"category" varchar(50),
	"quantity" varchar(50),
	"is_available" boolean DEFAULT true NOT NULL,
	"source" "inventory_source" DEFAULT 'manual' NOT NULL,
	"invoice_id" uuid,
	"confidence" "confidence" DEFAULT 'high' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"media_url" text,
	"raw_text" text,
	"parsed_items" jsonb,
	"item_count" integer DEFAULT 0 NOT NULL,
	"status" "invoice_status" DEFAULT 'processing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meal_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"meal_type" "meal_type" NOT NULL,
	"description" text NOT NULL,
	"items_used" jsonb,
	"was_junk" boolean,
	"suggested_by_bot" boolean DEFAULT false NOT NULL,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"tool_calls" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"meal_type" "meal_type" NOT NULL,
	"remind_at" time NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" varchar(20) NOT NULL,
	"name" varchar(100),
	"diet_type" "diet_type",
	"timezone" varchar(40) DEFAULT 'Asia/Kolkata' NOT NULL,
	"onboarding_complete" boolean DEFAULT false NOT NULL,
	"onboarding_step" "onboarding_step" DEFAULT 'ask_name' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "meal_logs" ADD CONSTRAINT "meal_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_schedules" ADD CONSTRAINT "user_schedules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_user_available_idx" ON "inventory_items" USING btree ("user_id","is_available");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_user_name_idx" ON "inventory_items" USING btree ("user_id","normalized_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meal_logs_user_logged_idx" ON "meal_logs" USING btree ("user_id","logged_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_user_created_idx" ON "messages" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_schedules_user_meal_unique" ON "user_schedules" USING btree ("user_id","meal_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_phone_unique" ON "users" USING btree ("phone");