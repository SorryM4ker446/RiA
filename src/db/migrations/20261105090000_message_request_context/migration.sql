-- The reference data a user message was sent with, so later requests repeat it exactly
-- and a provider's prompt cache keeps matching. Older messages simply have none.
ALTER TABLE "messages" ADD COLUMN "requestContext" TEXT;
