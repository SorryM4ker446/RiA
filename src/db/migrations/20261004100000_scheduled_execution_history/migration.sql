CREATE TABLE "scheduled_runs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "jobId" TEXT,
  "kind" TEXT NOT NULL,
  "trigger" TEXT NOT NULL DEFAULT 'scheduled',
  "retryOf" TEXT,
  "requestId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "errorCode" TEXT,
  "chatId" TEXT,
  "backupId" TEXT,
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" DATETIME,
  CONSTRAINT "scheduled_runs_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "scheduled_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "scheduled_runs_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "scheduled_runs_retryOf_key" ON "scheduled_runs"("retryOf");
CREATE INDEX "scheduled_runs_startedAt_id_idx" ON "scheduled_runs"("startedAt", "id");
CREATE INDEX "scheduled_runs_jobId_startedAt_idx" ON "scheduled_runs"("jobId", "startedAt");
CREATE INDEX "scheduled_runs_status_startedAt_idx" ON "scheduled_runs"("status", "startedAt");
