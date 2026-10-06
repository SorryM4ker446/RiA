ALTER TABLE "scheduled_jobs" ADD COLUMN "useModel" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "workspace_activity_state" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'local',
  "recordingStartedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completeSince" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "workspace_activity_state" ("id") VALUES ('local');
CREATE TABLE "workspace_events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "workspace_events_occurredAt_id_idx" ON "workspace_events"("occurredAt", "id");
CREATE TABLE "workspace_reviews" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "period" TEXT NOT NULL,
  "timeZone" TEXT NOT NULL,
  "startAt" DATETIME NOT NULL,
  "endAt" DATETIME NOT NULL,
  "facts" JSONB NOT NULL,
  "chatId" TEXT,
  "modelStatus" TEXT NOT NULL DEFAULT 'disabled',
  "modelError" TEXT,
  "modelText" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workspace_reviews_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "workspace_reviews_chatId_key" ON "workspace_reviews"("chatId");
CREATE UNIQUE INDEX "workspace_reviews_period_timeZone_startAt_key" ON "workspace_reviews"("period", "timeZone", "startAt");
CREATE INDEX "workspace_reviews_createdAt_id_idx" ON "workspace_reviews"("createdAt", "id");
