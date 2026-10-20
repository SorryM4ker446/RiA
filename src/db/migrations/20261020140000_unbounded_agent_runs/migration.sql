-- Preserve historical budgets; new runs have no aggregate time or count caps.
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_agent_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT,
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "maxSteps" INTEGER,
    "maxFailures" INTEGER,
    "deadlineMs" INTEGER,
    "maxCostUsd" REAL,
    "spentCostUsd" REAL NOT NULL DEFAULT 0,
    "stopReason" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "agent_runs_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_agent_runs" ("id", "chatId", "goal", "status", "maxSteps", "maxFailures", "deadlineMs", "maxCostUsd", "spentCostUsd", "stopReason", "startedAt", "finishedAt", "updatedAt")
SELECT "id", "chatId", "goal", "status", "maxSteps", "maxFailures", "deadlineMs", "maxCostUsd", "spentCostUsd", "stopReason", "startedAt", "finishedAt", "updatedAt" FROM "agent_runs";
DROP TABLE "agent_runs";
ALTER TABLE "new_agent_runs" RENAME TO "agent_runs";
CREATE INDEX "agent_runs_chatId_startedAt_idx" ON "agent_runs"("chatId", "startedAt");
CREATE INDEX "agent_runs_status_startedAt_idx" ON "agent_runs"("status", "startedAt");

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
