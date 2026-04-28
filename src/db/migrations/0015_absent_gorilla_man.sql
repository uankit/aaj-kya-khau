CREATE TABLE IF NOT EXISTS "web_push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "web_push_subscriptions" ADD CONSTRAINT "web_push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "web_push_subs_user_idx" ON "web_push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "web_push_subs_endpoint_unique" ON "web_push_subscriptions" USING btree ("endpoint");