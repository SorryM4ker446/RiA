-- A task decides more of what its runs do: whether its conversation uses
-- long-term memory, which outcomes notify, and how hard the model reasons.
-- A task may also run only when started by hand, with no next time at all,
-- which needs "nextRunAt" to allow null; SQLite cannot relax NOT NULL in place,
-- so the table is rebuilt. Foreign keys are off while a migration runs, so
-- dropping the old table does not touch the runs that point at it.
CREATE TABLE "new_scheduled_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "prompt" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "cron" TEXT,
    "timeZone" TEXT NOT NULL,
    "catchUp" BOOLEAN NOT NULL DEFAULT true,
    "template" TEXT,
    "chatId" TEXT,
    "modelProvider" TEXT,
    "modelId" TEXT,
    "workspaceGrantId" TEXT,
    "approvalRule" TEXT NOT NULL DEFAULT 'ask',
    "usesMemory" BOOLEAN NOT NULL DEFAULT false,
    "notify" TEXT NOT NULL DEFAULT 'all',
    "reasoningEffort" TEXT,
    "nextRunAt" DATETIME,
    "lastRunAt" DATETIME,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "scheduled_jobs_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "scheduled_jobs_workspaceGrantId_fkey" FOREIGN KEY ("workspaceGrantId") REFERENCES "directory_grants" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- A task whose conversation already had memory switched on keeps it on.
INSERT INTO "new_scheduled_jobs" ("id", "kind", "title", "prompt", "enabled", "cron", "timeZone", "catchUp", "template", "chatId", "modelProvider", "modelId", "workspaceGrantId", "approvalRule", "usesMemory", "nextRunAt", "lastRunAt", "lastStatus", "lastError", "createdAt", "updatedAt")
SELECT j."id", j."kind", j."title", j."prompt", j."enabled", j."cron", j."timeZone", j."catchUp", j."template", j."chatId", j."modelProvider", j."modelId", j."workspaceGrantId", j."approvalRule",
  coalesce((SELECT c."ephemeral" = 0 FROM "chats" c WHERE c."id" = j."chatId"), 0),
  j."nextRunAt", j."lastRunAt", j."lastStatus", j."lastError", j."createdAt", j."updatedAt"
FROM "scheduled_jobs" j;

DROP TABLE "scheduled_jobs";
ALTER TABLE "new_scheduled_jobs" RENAME TO "scheduled_jobs";
CREATE INDEX "scheduled_jobs_enabled_nextRunAt_idx" ON "scheduled_jobs"("enabled", "nextRunAt");
PRAGMA foreign_key_check;
