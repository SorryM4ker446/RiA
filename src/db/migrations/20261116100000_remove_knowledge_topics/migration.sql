-- Knowledge topics are removed, and with them the only thing that narrowed a
-- conversation's search other than its template: a topic conversation's own
-- scope. Every conversation now searches the whole library unless a template
-- narrows it, so the scope column goes too. What topics held is kept as
-- ordinary conversations.

-- Each finished result becomes a conversation named after its topic and
-- title: its brief as the user's message, the result as the answer.
INSERT INTO "chats" ("id", "title", "approvalRule", "lastMessageAt", "createdAt", "updatedAt")
SELECT 'result-' || a."id",
  substr(coalesce(json_extract(t."config", '$.name'), '') || ' · ' || a."title", 1, 200),
  coalesce((SELECT "defaultRule" FROM "approval_preferences" WHERE "id" = 'local'), 'ask'),
  a."updatedAt", a."createdAt", a."updatedAt"
FROM "knowledge_artifacts" a JOIN "knowledge_topics" t ON t."id" = a."topicId"
WHERE a."content" IS NOT NULL AND a."status" IN ('ready', 'needs_review');

INSERT INTO "messages" ("id", "chatId", "role", "content", "status", "createdAt")
SELECT 'result-' || a."id" || '-1-brief', 'result-' || a."id", 'user', coalesce(json_extract(a."metadata", '$.brief'), a."title"), 'success', a."createdAt"
FROM "knowledge_artifacts" a WHERE a."content" IS NOT NULL AND a."status" IN ('ready', 'needs_review');
INSERT INTO "messages" ("id", "chatId", "role", "content", "status", "createdAt")
SELECT 'result-' || a."id" || '-2-answer', 'result-' || a."id", 'assistant', a."content", 'success', a."updatedAt"
FROM "knowledge_artifacts" a WHERE a."content" IS NOT NULL AND a."status" IN ('ready', 'needs_review');

-- "chats" is rebuilt without "topicId" and "documentScope": SQLite cannot drop
-- a column that is a foreign key in place. Foreign keys are off while a
-- migration runs, so dropping the old table touches none of the rows that
-- point at it.
CREATE TABLE "new_chats" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "lastMessageAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "ephemeral" BOOLEAN NOT NULL DEFAULT 0,
    "summary" TEXT,
    "summaryUpToMessageId" TEXT,
    "summaryModelId" TEXT,
    "historyRevision" INTEGER NOT NULL DEFAULT 0,
    "summaryRevision" INTEGER,
    "assistantConfig" JSONB,
    "workspaceGrantId" TEXT,
    "summaryState" TEXT,
    "memoryExtractedAt" DATETIME,
    "memoryResumedAt" DATETIME,
    "approvalRule" TEXT NOT NULL DEFAULT 'ask',
    CONSTRAINT "chats_workspaceGrantId_fkey" FOREIGN KEY ("workspaceGrantId") REFERENCES "directory_grants" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_chats" ("id", "title", "pinned", "archived", "lastMessageAt", "createdAt", "updatedAt", "ephemeral", "summary", "summaryUpToMessageId", "summaryModelId", "historyRevision", "summaryRevision", "assistantConfig", "workspaceGrantId", "summaryState", "memoryExtractedAt", "memoryResumedAt", "approvalRule") SELECT "id", "title", "pinned", "archived", "lastMessageAt", "createdAt", "updatedAt", "ephemeral", "summary", "summaryUpToMessageId", "summaryModelId", "historyRevision", "summaryRevision", "assistantConfig", "workspaceGrantId", "summaryState", "memoryExtractedAt", "memoryResumedAt", "approvalRule" FROM "chats";
DROP TABLE "chats";
ALTER TABLE "new_chats" RENAME TO "chats";
CREATE INDEX "chats_archived_pinned_lastMessageAt_id_idx" ON "chats"("archived", "pinned", "lastMessageAt", "id");
CREATE INDEX "chats_createdAt_idx" ON "chats"("createdAt");
CREATE INDEX "chats_lastMessageAt_id_idx" ON "chats"("lastMessageAt", "id");
CREATE INDEX "chats_pinned_lastMessageAt_id_idx" ON "chats"("pinned", "lastMessageAt", "id");
CREATE TRIGGER "chats_search_delete" AFTER DELETE ON "chats" BEGIN
  DELETE FROM "chat_title_search" WHERE length(old.id)>=3 AND rowid IN
    (SELECT rowid FROM "chat_title_search" WHERE id MATCH ('"' || replace(old.id,'"','""') || '"')) AND id=old.id;
  DELETE FROM "chat_title_search" WHERE length(old.id)<3 AND id=old.id;
END;
CREATE TRIGGER "chats_search_insert" AFTER INSERT ON "chats" BEGIN
  INSERT INTO "chat_title_search"(id,text) VALUES (new.id,new.title);
END;
CREATE TRIGGER "chats_search_update" AFTER UPDATE OF title,id ON "chats" BEGIN
  DELETE FROM "chat_title_search" WHERE length(old.id)>=3 AND rowid IN
    (SELECT rowid FROM "chat_title_search" WHERE id MATCH ('"' || replace(old.id,'"','""') || '"')) AND id=old.id;
  DELETE FROM "chat_title_search" WHERE length(old.id)<3 AND id=old.id;
  INSERT INTO "chat_title_search"(id,text) VALUES (new.id,new.title);
END;

DROP TABLE "knowledge_artifacts";
DROP TABLE "knowledge_topics";
PRAGMA foreign_key_check;
