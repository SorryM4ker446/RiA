ALTER TABLE "chats" ADD COLUMN "historyRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "chats" ADD COLUMN "summaryRevision" INTEGER;
UPDATE "chats" SET "summary" = NULL, "summaryUpToMessageId" = NULL, "summaryModelId" = NULL;
