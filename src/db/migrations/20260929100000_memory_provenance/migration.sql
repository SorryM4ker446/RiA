-- Memories become attributable: where an entry came from, whether the user has
-- accepted it, and when it was last used.
--
-- Existing rows are treated as confirmed manual entries. They were either
-- written by the user through this interface or were created by the assistant
-- before this distinction existed; leaving them unconfirmed would silently stop
-- using everything that was already there, which is not what the change is
-- about. New inferred entries start unconfirmed.
ALTER TABLE "memories" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "memories" ADD COLUMN "confirmed" BOOLEAN NOT NULL DEFAULT 1;
ALTER TABLE "memories" ADD COLUMN "lastUsedAt" DATETIME;
CREATE INDEX "memories_confirmed_updatedAt_idx" ON "memories"("confirmed", "updatedAt");
