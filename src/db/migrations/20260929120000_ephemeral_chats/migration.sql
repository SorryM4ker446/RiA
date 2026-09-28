-- Per-conversation memory switch. Existing conversations are unaffected and
-- keep using memory as before.
ALTER TABLE "chats" ADD COLUMN "ephemeral" BOOLEAN NOT NULL DEFAULT 0;
