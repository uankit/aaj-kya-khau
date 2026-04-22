CREATE TYPE "public"."account_status" AS ENUM('active', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."oauth_provider" AS ENUM('zepto', 'swiggy_instamart');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connected_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "oauth_provider" NOT NULL,
	"access_token_ciphertext" text NOT NULL,
	"refresh_token_ciphertext" text,
	"token_expires_at" timestamp with time zone,
	"scopes" text,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_pending_states" (
	"state" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "oauth_provider" NOT NULL,
	"code_verifier" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_pending_states" ADD CONSTRAINT "oauth_pending_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connected_accounts_user_provider_unique" ON "connected_accounts" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_pending_states_created_at_idx" ON "oauth_pending_states" USING btree ("created_at");