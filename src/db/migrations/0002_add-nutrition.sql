CREATE TYPE "public"."activity_level" AS ENUM('sedentary', 'lightly_active', 'moderately_active', 'very_active');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('male', 'female');--> statement-breakpoint
CREATE TYPE "public"."health_goal" AS ENUM('lose', 'maintain', 'gain');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nutrition_foods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"calories_per_100g" integer NOT NULL,
	"protein_per_100g" integer NOT NULL,
	"carbs_per_100g" integer NOT NULL,
	"fat_per_100g" integer NOT NULL,
	"fiber_per_100g" integer DEFAULT 0 NOT NULL,
	"serving_size_g" integer DEFAULT 100 NOT NULL,
	"serving_description" varchar(100),
	"category" varchar(50) NOT NULL,
	"source" varchar(50) DEFAULT 'IFCT 2017' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meal_logs" ADD COLUMN "estimated_calories" integer;--> statement-breakpoint
ALTER TABLE "meal_logs" ADD COLUMN "estimated_protein_g" integer;--> statement-breakpoint
ALTER TABLE "meal_logs" ADD COLUMN "estimated_carbs_g" integer;--> statement-breakpoint
ALTER TABLE "meal_logs" ADD COLUMN "estimated_fat_g" integer;--> statement-breakpoint
ALTER TABLE "meal_logs" ADD COLUMN "estimated_fiber_g" integer;--> statement-breakpoint
ALTER TABLE "meal_logs" ADD COLUMN "nutrition_breakdown" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "age" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "gender" "gender";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "height_cm" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "weight_kg" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "activity_level" "activity_level";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "health_goal" "health_goal";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bmr" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tdee" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "daily_calories_target" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "daily_protein_target_g" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "daily_carbs_target_g" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "daily_fat_target_g" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "daily_fiber_target_g" integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nutrition_foods_name_idx" ON "nutrition_foods" USING btree ("name");