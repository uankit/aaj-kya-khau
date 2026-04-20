CREATE TABLE IF NOT EXISTS "webhook_dedup" (
	"message_sid" varchar(64) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
