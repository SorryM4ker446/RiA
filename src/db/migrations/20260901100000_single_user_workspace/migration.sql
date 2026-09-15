-- The application becomes a single local workspace: account identity, login
-- sessions and per-account tenant scoping are removed while all locally owned
-- content stays in place.
--
-- This migration runs in two situations:
--   1. an existing installation that still has "users"/"sessions" tables;
--   2. a brand-new database created from the account-scoped baseline.
-- It runs once per database: the migration ledger ("_prisma_migrations" or
-- "desktop_migrations") records it, and both upgrade runners verify afterwards
-- that the workspace schema was reached. It is deliberately not written to be
-- re-applied to an already converted file, because the account tables it
-- consumes are gone by then.
--
-- FOREIGN KEY HANDLING (required)
-- Rebuilding "chats", "media_assets" and "knowledge_documents" means dropping
-- tables that other rows reference, and "users" disappears entirely. With
-- foreign-key enforcement active, SQLite would cascade those drops and delete
-- the user's content. Two things keep that from happening:
--   1. every table that references "users" is rebuilt before "users" is
--      dropped, and messages from accounts that were not adopted are removed
--      while their conversations still exist (step 2);
--   2. the upgrade runners apply this file with enforcement switched off
--      around the migration transaction, because SQLite ignores the pragma
--      below inside an open transaction, and run PRAGMA foreign_key_check
--      afterwards. A database converted with enforcement off is still verified
--      to have no violations.
PRAGMA foreign_keys = OFF;

-- 0. Search triggers are recreated at the end against the rebuilt tables.
DROP TRIGGER IF EXISTS "chats_search_insert";
DROP TRIGGER IF EXISTS "chats_search_update";
DROP TRIGGER IF EXISTS "chats_search_delete";
DROP TRIGGER IF EXISTS "messages_search_insert";
DROP TRIGGER IF EXISTS "messages_search_update";
DROP TRIGGER IF EXISTS "messages_search_delete";

-- 1. Exactly one account is adopted. The upgrade runner pre-fills this when the
-- user had to choose; otherwise the oldest account in the file is kept. When the
-- caller already prefilled the choice the insert keeps it.
CREATE TABLE IF NOT EXISTS "local_workspace_adoption" (
    "ownerId" TEXT NOT NULL PRIMARY KEY,
    "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "local_workspace_adoption" ("ownerId")
SELECT "id" FROM "users" WHERE NOT EXISTS (SELECT 1 FROM "local_workspace_adoption") ORDER BY "createdAt" ASC, "id" ASC LIMIT 1;

-- An empty adoption table (fresh database without accounts) means every filter
-- below keeps all rows.

-- 2. Rows from accounts the user did not adopt stay in the pre-upgrade snapshot
-- and are not carried into the workspace.
DELETE FROM "chats" WHERE (SELECT count(*) FROM "local_workspace_adoption") > 0 AND "userId" NOT IN (SELECT "ownerId" FROM "local_workspace_adoption");
DELETE FROM "memories" WHERE (SELECT count(*) FROM "local_workspace_adoption") > 0 AND "userId" NOT IN (SELECT "ownerId" FROM "local_workspace_adoption");
DELETE FROM "tasks" WHERE (SELECT count(*) FROM "local_workspace_adoption") > 0 AND "userId" NOT IN (SELECT "ownerId" FROM "local_workspace_adoption");
DELETE FROM "media_assets" WHERE (SELECT count(*) FROM "local_workspace_adoption") > 0 AND "userId" NOT IN (SELECT "ownerId" FROM "local_workspace_adoption");
DELETE FROM "knowledge_documents" WHERE (SELECT count(*) FROM "local_workspace_adoption") > 0 AND "userId" NOT IN (SELECT "ownerId" FROM "local_workspace_adoption");
DELETE FROM "model_requests" WHERE (SELECT count(*) FROM "local_workspace_adoption") > 0 AND "userId" NOT IN (SELECT "ownerId" FROM "local_workspace_adoption");
DELETE FROM "account_preferences" WHERE (SELECT count(*) FROM "local_workspace_adoption") > 0 AND "userId" NOT IN (SELECT "ownerId" FROM "local_workspace_adoption");

-- Messages belong to a conversation, so they follow the conversations that were
-- kept. This runs before the rebuild so no message is ever left pointing at a
-- conversation that is no longer in the workspace.
DELETE FROM "messages" WHERE "chatId" NOT IN (SELECT "id" FROM "chats");

-- Association rows do not carry an owner column. Remove references to rows
-- dropped above before rebuilding their parent tables; foreign-key enforcement
-- is disabled for the table rebuild, so SQLite would otherwise leave orphans.
DELETE FROM "chat_tags" WHERE "chatId" NOT IN (SELECT "id" FROM "chats");
DELETE FROM "message_media" WHERE "messageId" NOT IN (SELECT "id" FROM "messages") OR "assetId" NOT IN (SELECT "id" FROM "media_assets");
DELETE FROM "media_generation_inputs" WHERE "assetId" NOT IN (SELECT "id" FROM "media_assets") OR "inputAssetId" NOT IN (SELECT "id" FROM "media_assets");

-- 3. Conversations. Messages are rebuilt in step 5 and reconnect by chat id.
CREATE TABLE IF NOT EXISTS "chats_workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "lastMessageAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT OR REPLACE INTO "chats_workspace" ("id", "title", "pinned", "archived", "lastMessageAt", "createdAt", "updatedAt")
SELECT "id", "title", COALESCE("pinned", 0), COALESCE("archived", 0), "lastMessageAt", "createdAt", "updatedAt" FROM "chats";
DROP TABLE IF EXISTS "chats";
ALTER TABLE "chats_workspace" RENAME TO "chats";
CREATE INDEX IF NOT EXISTS "chats_lastMessageAt_id_idx" ON "chats"("lastMessageAt", "id");
CREATE INDEX IF NOT EXISTS "chats_archived_pinned_lastMessageAt_id_idx" ON "chats"("archived", "pinned", "lastMessageAt", "id");
CREATE INDEX IF NOT EXISTS "chats_pinned_lastMessageAt_id_idx" ON "chats"("pinned", "lastMessageAt", "id");
CREATE INDEX IF NOT EXISTS "chats_createdAt_idx" ON "chats"("createdAt");

-- 4. Memories -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "memories_workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "score" REAL,
    "embedding" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT OR REPLACE INTO "memories_workspace" ("id", "key", "value", "score", "embedding", "createdAt", "updatedAt")
SELECT "id", "key", "value", "score", "embedding", "createdAt", "updatedAt" FROM "memories";
DROP TABLE IF EXISTS "memories";
ALTER TABLE "memories_workspace" RENAME TO "memories";
CREATE UNIQUE INDEX IF NOT EXISTS "memories_key_key" ON "memories"("key");
CREATE INDEX IF NOT EXISTS "memories_updatedAt_id_idx" ON "memories"("updatedAt", "id");

-- 5. Messages -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "messages_workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT NOT NULL,
    "clientMessageId" TEXT,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'success',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "messages_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT OR REPLACE INTO "messages_workspace" ("id", "chatId", "clientMessageId", "role", "content", "status", "createdAt")
SELECT "id", "chatId", "clientMessageId", "role", "content", "status", "createdAt" FROM "messages";
DROP TABLE IF EXISTS "messages";
ALTER TABLE "messages_workspace" RENAME TO "messages";
CREATE UNIQUE INDEX IF NOT EXISTS "messages_chatId_clientMessageId_key" ON "messages"("chatId", "clientMessageId");
CREATE INDEX IF NOT EXISTS "messages_chatId_createdAt_id_idx" ON "messages"("chatId", "createdAt", "id");

-- 6. Tasks ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "tasks_workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "details" TEXT,
    "dueDate" DATETIME,
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "reminderEnabled" BOOLEAN NOT NULL DEFAULT false,
    "remindedAt" DATETIME,
    "repeatRule" TEXT NOT NULL DEFAULT 'none',
    "repeatAnchor" DATETIME,
    "repeatGenerated" BOOLEAN NOT NULL DEFAULT false,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'todo',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT OR REPLACE INTO "tasks_workspace" ("id", "title", "details", "dueDate", "timeZone", "reminderEnabled", "remindedAt", "repeatRule", "repeatAnchor", "repeatGenerated", "priority", "status", "createdAt", "updatedAt")
SELECT "id", "title", "details", "dueDate", COALESCE("timeZone", 'UTC'), COALESCE("reminderEnabled", 0), "remindedAt", COALESCE("repeatRule", 'none'), "repeatAnchor", COALESCE("repeatGenerated", 0), COALESCE("priority", 'medium'), COALESCE("status", 'todo'), "createdAt", "updatedAt" FROM "tasks";
DROP TABLE IF EXISTS "tasks";
ALTER TABLE "tasks_workspace" RENAME TO "tasks";
CREATE INDEX IF NOT EXISTS "tasks_status_createdAt_idx" ON "tasks"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "tasks_reminderEnabled_remindedAt_dueDate_idx" ON "tasks"("reminderEnabled", "remindedAt", "dueDate");
CREATE INDEX IF NOT EXISTS "tasks_dueDate_idx" ON "tasks"("dueDate");

-- 7. Media assets ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "media_assets_workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "relativePath" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "modelId" TEXT,
    "description" TEXT,
    "generation" JSONB,
    "sourceChatId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    CONSTRAINT "media_assets_sourceChatId_fkey" FOREIGN KEY ("sourceChatId") REFERENCES "chats" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT OR REPLACE INTO "media_assets_workspace" ("id", "relativePath", "mediaType", "byteSize", "kind", "modelId", "description", "generation", "sourceChatId", "createdAt", "lastUsedAt", "deletedAt")
SELECT "id", "relativePath", "mediaType", "byteSize", "kind", "modelId", "description", "generation", "sourceChatId", "createdAt", "lastUsedAt", "deletedAt" FROM "media_assets";
DROP TABLE IF EXISTS "media_assets";
ALTER TABLE "media_assets_workspace" RENAME TO "media_assets";
CREATE UNIQUE INDEX IF NOT EXISTS "media_assets_relativePath_key" ON "media_assets"("relativePath");
CREATE INDEX IF NOT EXISTS "media_assets_createdAt_idx" ON "media_assets"("createdAt");
CREATE INDEX IF NOT EXISTS "media_assets_createdAt_id_idx" ON "media_assets"("createdAt", "id");
CREATE INDEX IF NOT EXISTS "media_assets_sourceChatId_idx" ON "media_assets"("sourceChatId");
CREATE INDEX IF NOT EXISTS "media_assets_kind_idx" ON "media_assets"("kind");

-- 8. Knowledge documents --------------------------------------------------------
CREATE TABLE IF NOT EXISTS "knowledge_documents_workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "pages" JSONB NOT NULL,
    "characterCount" INTEGER NOT NULL,
    "indexVersion" INTEGER NOT NULL,
    "indexedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT OR REPLACE INTO "knowledge_documents_workspace" ("id", "filename", "format", "byteSize", "contentHash", "pages", "characterCount", "indexVersion", "indexedAt", "createdAt", "updatedAt")
SELECT "id", "filename", "format", "byteSize", "contentHash", "pages", "characterCount", "indexVersion", COALESCE("indexedAt", "createdAt"), "createdAt", "updatedAt" FROM "knowledge_documents";
DROP TABLE IF EXISTS "knowledge_documents";
ALTER TABLE "knowledge_documents_workspace" RENAME TO "knowledge_documents";
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_documents_filename_key" ON "knowledge_documents"("filename");
CREATE INDEX IF NOT EXISTS "knowledge_documents_updatedAt_id_idx" ON "knowledge_documents"("updatedAt", "id");

-- 9. Model usage ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "model_requests_workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costUsd" REAL,
    "costSource" TEXT NOT NULL,
    "errorCode" TEXT,
    "fallback" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR REPLACE INTO "model_requests_workspace" ("id", "requestId", "mode", "modelId", "status", "durationMs", "inputTokens", "outputTokens", "costUsd", "costSource", "errorCode", "fallback", "createdAt")
SELECT "id", "requestId", "mode", "modelId", "status", "durationMs", "inputTokens", "outputTokens", "costUsd", "costSource", "errorCode", COALESCE("fallback", 0), "createdAt" FROM "model_requests";
DROP TABLE IF EXISTS "model_requests";
ALTER TABLE "model_requests_workspace" RENAME TO "model_requests";
CREATE INDEX IF NOT EXISTS "model_requests_createdAt_id_idx" ON "model_requests"("createdAt", "id");

-- 10. Application preferences become a single row -------------------------------
CREATE TABLE IF NOT EXISTS "account_preferences_workspace" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'local',
    "settings" JSONB NOT NULL,
    "updatedAt" DATETIME NOT NULL
);
INSERT OR REPLACE INTO "account_preferences_workspace" ("id", "settings", "updatedAt")
SELECT 'local', "settings", "updatedAt" FROM "account_preferences" LIMIT 1;
DROP TABLE IF EXISTS "account_preferences";
ALTER TABLE "account_preferences_workspace" RENAME TO "account_preferences";

-- 11. Sessions and accounts disappear entirely.
DROP TABLE IF EXISTS "sessions";
DROP TABLE IF EXISTS "users";
DROP TABLE IF EXISTS "local_workspace_adoption";

-- 12. Search indexes stay in step with the rebuilt tables.
CREATE TRIGGER IF NOT EXISTS "chats_search_insert" AFTER INSERT ON "chats" BEGIN
  INSERT INTO "chat_title_search"(id,text) VALUES (new.id,new.title);
END;
CREATE TRIGGER IF NOT EXISTS "chats_search_update" AFTER UPDATE OF title,id ON "chats" BEGIN
  DELETE FROM "chat_title_search" WHERE length(old.id)>=3 AND rowid IN
    (SELECT rowid FROM "chat_title_search" WHERE id MATCH ('"' || replace(old.id,'"','""') || '"')) AND id=old.id;
  DELETE FROM "chat_title_search" WHERE length(old.id)<3 AND id=old.id;
  INSERT INTO "chat_title_search"(id,text) VALUES (new.id,new.title);
END;
CREATE TRIGGER IF NOT EXISTS "chats_search_delete" AFTER DELETE ON "chats" BEGIN
  DELETE FROM "chat_title_search" WHERE length(old.id)>=3 AND rowid IN
    (SELECT rowid FROM "chat_title_search" WHERE id MATCH ('"' || replace(old.id,'"','""') || '"')) AND id=old.id;
  DELETE FROM "chat_title_search" WHERE length(old.id)<3 AND id=old.id;
END;
CREATE TRIGGER IF NOT EXISTS "messages_search_insert" AFTER INSERT ON "messages" BEGIN
  INSERT INTO "message_text_search"(id,text) VALUES (new.id,CASE
  WHEN substr(new.content,1,17)='__USER_MESSAGE__:' THEN
    CASE WHEN json_valid(substr(new.content,18)) THEN
      CASE WHEN json_type(substr(new.content,18),'$.text')='text' THEN json_extract(substr(new.content,18),'$.text') ELSE '' END
    ELSE '' END
  WHEN substr(new.content,1,27)='__ASSISTANT_TOOL_MESSAGE__:' THEN
    CASE WHEN json_valid(substr(new.content,28)) THEN
      CASE WHEN json_type(substr(new.content,28),'$.text')='text' THEN json_extract(substr(new.content,28),'$.text') ELSE '' END
    ELSE '' END
  WHEN substr(new.content,1,17)='__IMAGE_RESULT__:' THEN
    CASE WHEN json_valid(substr(new.content,18)) THEN
      CASE WHEN json_type(substr(new.content,18),'$.text')='text' THEN json_extract(substr(new.content,18),'$.text') ELSE '' END
    ELSE '' END
  WHEN substr(new.content,1,17)='__VIDEO_RESULT__:' THEN
    CASE WHEN json_valid(substr(new.content,18)) THEN
      CASE WHEN json_type(substr(new.content,18),'$.text')='text' THEN json_extract(substr(new.content,18),'$.text') ELSE '' END
    ELSE '' END
  WHEN lower(substr(new.content,1,5))='data:' THEN ''
  ELSE new.content
END);
END;
CREATE TRIGGER IF NOT EXISTS "messages_search_update" AFTER UPDATE OF content,id ON "messages" BEGIN
  DELETE FROM "message_text_search" WHERE length(old.id)>=3 AND rowid IN
    (SELECT rowid FROM "message_text_search" WHERE id MATCH ('"' || replace(old.id,'"','""') || '"')) AND id=old.id;
  DELETE FROM "message_text_search" WHERE length(old.id)<3 AND id=old.id;
  INSERT INTO "message_text_search"(id,text) VALUES (new.id,CASE
  WHEN substr(new.content,1,17)='__USER_MESSAGE__:' THEN
    CASE WHEN json_valid(substr(new.content,18)) THEN
      CASE WHEN json_type(substr(new.content,18),'$.text')='text' THEN json_extract(substr(new.content,18),'$.text') ELSE '' END
    ELSE '' END
  WHEN substr(new.content,1,27)='__ASSISTANT_TOOL_MESSAGE__:' THEN
    CASE WHEN json_valid(substr(new.content,28)) THEN
      CASE WHEN json_type(substr(new.content,28),'$.text')='text' THEN json_extract(substr(new.content,28),'$.text') ELSE '' END
    ELSE '' END
  WHEN substr(new.content,1,17)='__IMAGE_RESULT__:' THEN
    CASE WHEN json_valid(substr(new.content,18)) THEN
      CASE WHEN json_type(substr(new.content,18),'$.text')='text' THEN json_extract(substr(new.content,18),'$.text') ELSE '' END
    ELSE '' END
  WHEN substr(new.content,1,17)='__VIDEO_RESULT__:' THEN
    CASE WHEN json_valid(substr(new.content,18)) THEN
      CASE WHEN json_type(substr(new.content,18),'$.text')='text' THEN json_extract(substr(new.content,18),'$.text') ELSE '' END
    ELSE '' END
  WHEN lower(substr(new.content,1,5))='data:' THEN ''
  ELSE new.content
END);
END;
CREATE TRIGGER IF NOT EXISTS "messages_search_delete" AFTER DELETE ON "messages" BEGIN
  DELETE FROM "message_text_search" WHERE length(old.id)>=3 AND rowid IN
    (SELECT rowid FROM "message_text_search" WHERE id MATCH ('"' || replace(old.id,'"','""') || '"')) AND id=old.id;
  DELETE FROM "message_text_search" WHERE length(old.id)<3 AND id=old.id;
END;

PRAGMA foreign_keys = ON;
