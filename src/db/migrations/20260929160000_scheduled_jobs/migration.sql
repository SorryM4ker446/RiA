-- Scheduled work the user asked for: a backup reminder, or a backup to be
-- created on a time. One local process runs these, so a due job is claimed
-- rather than merely seen. Disabled by default: a schedule that starts on its
-- own is a background process nobody asked for.
CREATE TABLE "scheduled_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "localTime" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "interval" TEXT NOT NULL DEFAULT 'daily',
    "dayOfWeek" INTEGER,
    "nextRunAt" DATETIME NOT NULL,
    "lastRunAt" DATETIME,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "scheduled_jobs_enabled_nextRunAt_idx" ON "scheduled_jobs"("enabled", "nextRunAt");
