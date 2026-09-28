-- Conversation summaries. The original messages are kept: a summary says what
-- the earlier turns were about and which message it covers, so a reader can
-- always go back to the text itself.
ALTER TABLE "chats" ADD COLUMN "summary" TEXT;
ALTER TABLE "chats" ADD COLUMN "summaryUpToMessageId" TEXT;
ALTER TABLE "chats" ADD COLUMN "summaryModelId" TEXT;
