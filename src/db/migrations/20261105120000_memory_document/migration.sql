-- MEMORY.md, written from conversations by a tool the model calls, which a person can
-- read and delete from. Conversations note when they last asked for it.
CREATE TABLE "memory_documents" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'local',
    "content" TEXT NOT NULL DEFAULT '',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "deletedRevision" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);
ALTER TABLE "chats" ADD COLUMN "memoryExtractedAt" DATETIME;

-- Candidates written from tool results are no longer made. Those nobody accepted held
-- raw records of no use; any that were accepted are a person's decision and stay.
DELETE FROM "memories" WHERE "confirmed" = 0 AND "source" = 'assistant' AND "key" LIKE 'tool:%';
