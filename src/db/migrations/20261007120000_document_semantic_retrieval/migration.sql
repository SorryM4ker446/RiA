ALTER TABLE "document_chunks" ADD COLUMN "heading" TEXT;
ALTER TABLE "document_chunks" ADD COLUMN "tokenCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "document_chunks" ADD COLUMN "embedding" JSONB;
ALTER TABLE "document_chunks" ADD COLUMN "embeddingModelId" TEXT;
ALTER TABLE "document_chunks" ADD COLUMN "embeddingModelProvider" TEXT;
ALTER TABLE "document_chunks" ADD COLUMN "embeddingContextHash" TEXT;
ALTER TABLE "document_terms" ADD COLUMN "frequency" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX "document_chunks_embeddingModelProvider_embeddingModelId_id_idx"
ON "document_chunks"("embeddingModelProvider", "embeddingModelId", "id");
