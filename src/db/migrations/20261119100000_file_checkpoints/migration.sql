-- What each turn changed in a workspace file, so the change can be undone. The
-- content itself is kept outside the database, by hash; a row names the hashes
-- before and after and whether the turn created, modified or deleted the file.
-- Rows go with their conversation and execution record.
CREATE TABLE "file_checkpoints" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT NOT NULL,
    "runId" TEXT,
    "grantId" TEXT NOT NULL,
    "root" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "beforeHash" TEXT,
    "afterHash" TEXT,
    "beforeBytes" INTEGER,
    "afterBytes" INTEGER,
    "beforeGitOid" TEXT,
    "restorable" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" DATETIME,
    CONSTRAINT "file_checkpoints_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "file_checkpoints_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "file_checkpoints_chatId_runId_idx" ON "file_checkpoints"("chatId", "runId");
CREATE INDEX "file_checkpoints_grantId_idx" ON "file_checkpoints"("grantId");
CREATE INDEX "file_checkpoints_createdAt_idx" ON "file_checkpoints"("createdAt");

-- How much the undo store may hold, in MiB; absent means the default.
CREATE TABLE "checkpoint_preferences" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'local',
    "limitMb" INTEGER NOT NULL DEFAULT 2048,
    "updatedAt" DATETIME NOT NULL
);
