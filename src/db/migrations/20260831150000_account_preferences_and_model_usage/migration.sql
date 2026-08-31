CREATE TABLE "account_preferences" (
  "userId" TEXT NOT NULL PRIMARY KEY,
  "settings" JSONB NOT NULL,
  "updatedAt" DATETIME NOT NULL,
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "model_requests" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
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
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "model_requests_userId_createdAt_id_idx" ON "model_requests"("userId","createdAt","id");
