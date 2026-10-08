CREATE TABLE "knowledge_topics" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "config" JSONB NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
ALTER TABLE "chats" ADD COLUMN "topicId" TEXT REFERENCES "knowledge_topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "chats_topicId_lastMessageAt_id_idx" ON "chats"("topicId", "lastMessageAt", "id");
CREATE TABLE "knowledge_artifacts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "topicId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "topicRevision" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "errorCode" TEXT,
  "content" TEXT,
  "metadata" JSONB NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "knowledge_artifacts_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "knowledge_topics"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "knowledge_artifacts_topicId_createdAt_id_idx" ON "knowledge_artifacts"("topicId", "createdAt", "id");
