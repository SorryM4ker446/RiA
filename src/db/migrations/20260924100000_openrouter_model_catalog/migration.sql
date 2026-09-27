ALTER TABLE "memories" ADD COLUMN "embeddingModelId" TEXT;

CREATE TABLE "model_catalog_snapshots" (
    "providerId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "models" JSONB NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("providerId", "mode")
);
CREATE INDEX "model_catalog_snapshots_fetchedAt_idx" ON "model_catalog_snapshots"("fetchedAt");
