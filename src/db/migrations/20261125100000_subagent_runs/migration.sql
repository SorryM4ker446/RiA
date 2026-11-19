-- Task sub-agents as records of their own: a background one outlives the step
-- that started it, so its status, report and whether the model has heard it are
-- kept here. Additive; older builds ignore the table.
CREATE TABLE "subagent_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT NOT NULL,
    "runId" TEXT,
    "toolCallId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "background" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'running',
    "report" TEXT,
    "notRun" JSONB,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "subagent_runs_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "subagent_runs_chatId_startedAt_idx" ON "subagent_runs"("chatId", "startedAt");
CREATE INDEX "subagent_runs_status_idx" ON "subagent_runs"("status");
