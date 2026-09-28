-- Model references become provider-qualified: the same model reached through
-- two providers is two entries with separate credentials, pricing and
-- availability, so a bare id is no longer enough to identify one.
--
-- Existing rows keep their meaning. Every model this application has called so
-- far was reached through OpenRouter, and these columns record that rather than
-- leaving it to be guessed later. `media_assets.modelProvider` stays NULL
-- instead of being backfilled: an asset with no recorded provenance keeps
-- saying so, and the read path already treats that as OpenRouter.
ALTER TABLE "model_requests" ADD COLUMN "modelProvider" TEXT NOT NULL DEFAULT 'openrouter';
ALTER TABLE "media_assets" ADD COLUMN "modelProvider" TEXT;
ALTER TABLE "memories" ADD COLUMN "embeddingModelProvider" TEXT;
-- Vectors written before this column existed were produced by OpenRouter, and
-- this application has never called another provider for embeddings. Recording
-- that keeps semantic recall working; leaving it NULL would have silently
-- dropped every existing memory out of semantic matching.
UPDATE "memories" SET "embeddingModelProvider" = 'openrouter' WHERE "embeddingModelId" IS NOT NULL;
CREATE INDEX "memories_embeddingModelProvider_embeddingModelId_idx" ON "memories"("embeddingModelProvider", "embeddingModelId");
