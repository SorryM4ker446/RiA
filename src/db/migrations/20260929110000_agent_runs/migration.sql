-- Execution records: one row per assistant turn that used tools, one row per
-- step inside it. Bounded by default so a run cannot become an unbounded cost.
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT,
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "maxSteps" INTEGER NOT NULL DEFAULT 8,
    "maxFailures" INTEGER NOT NULL DEFAULT 2,
    "deadlineMs" INTEGER NOT NULL DEFAULT 120000,
    "maxCostUsd" REAL,
    "spentCostUsd" REAL NOT NULL DEFAULT 0,
    "stopReason" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "agent_runs_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "agent_runs_chatId_startedAt_idx" ON "agent_runs"("chatId", "startedAt");
CREATE INDEX "agent_runs_status_startedAt_idx" ON "agent_runs"("status", "startedAt");

CREATE TABLE "agent_steps" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "toolName" TEXT,
    "state" TEXT NOT NULL DEFAULT 'running',
    "input" JSONB,
    "output" JSONB,
    "artifactAssetId" TEXT,
    "errorCode" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "agent_steps_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "agent_steps_runId_position_key" ON "agent_steps"("runId", "position");
CREATE INDEX "agent_steps_runId_position_idx" ON "agent_steps"("runId", "position");
