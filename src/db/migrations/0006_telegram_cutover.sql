-- Cutover from Twilio/WhatsApp (phone) to Telegram (telegram_id).
-- Any existing users with phone values are dropped; this is expected
-- since we're fully replacing the messaging transport.

-- 1. Drop unique index on phone
DROP INDEX IF EXISTS "users_phone_unique";

-- 2. Clear existing users (they had phone-based identity, no way to link them to Telegram)
DELETE FROM "users";

-- 3. Drop old phone column
ALTER TABLE "users" DROP COLUMN IF EXISTS "phone";

-- 4. Add telegram_id column
ALTER TABLE "users" ADD COLUMN "telegram_id" varchar(30) NOT NULL;

-- 5. Add unique index on telegram_id
CREATE UNIQUE INDEX "users_telegram_id_unique" ON "users" USING btree ("telegram_id");
