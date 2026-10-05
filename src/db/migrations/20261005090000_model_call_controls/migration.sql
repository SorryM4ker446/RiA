ALTER TABLE "model_requests" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'unattributed';
ALTER TABLE "model_requests" ADD COLUMN "estimatedUsd" REAL;
CREATE TABLE "model_call_days" (
    "day" TEXT NOT NULL PRIMARY KEY,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "estimatedUsd" REAL NOT NULL DEFAULT 0
);
