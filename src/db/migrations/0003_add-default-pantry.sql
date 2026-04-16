CREATE TABLE IF NOT EXISTS "default_pantry_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"normalized_name" varchar(100) NOT NULL,
	"category" varchar(50) NOT NULL,
	"region" varchar(30),
	"exclude_diet" "diet_type",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
