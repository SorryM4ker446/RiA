-- Document vectors move from JSON to binary Float32 (normalised, little-endian).
-- The desktop migrator converts the existing JSON vectors in the same
-- transaction (see electron/migration-steps.ts); the JSON column stays, emptied,
-- so an older build still reads the table.
ALTER TABLE "document_chunks" ADD COLUMN "vector" BLOB;

-- Bumped whenever a document's chunks or their vectors change, so the search
-- index in memory reloads exactly the documents that changed.
ALTER TABLE "knowledge_documents" ADD COLUMN "vectorRevision" INTEGER NOT NULL DEFAULT 0;

-- A vector describes the text it was made from, with its section, file name and
-- collection. Any change to those invalidates it, whichever code path made it.
CREATE TRIGGER "document_chunks_vector_text" AFTER UPDATE OF "text", "heading" ON "document_chunks"
WHEN OLD."text" IS NOT NEW."text" OR OLD."heading" IS NOT NEW."heading"
BEGIN
  UPDATE "document_chunks" SET "vector" = NULL, "embedding" = NULL, "embeddingModelId" = NULL, "embeddingModelProvider" = NULL, "embeddingContextHash" = NULL
  WHERE "id" = NEW."id";
END;

CREATE TRIGGER "knowledge_documents_vector_context" AFTER UPDATE OF "filename", "collection" ON "knowledge_documents"
WHEN OLD."filename" IS NOT NEW."filename" OR OLD."collection" IS NOT NEW."collection"
BEGIN
  UPDATE "document_chunks" SET "vector" = NULL, "embedding" = NULL, "embeddingModelId" = NULL, "embeddingModelProvider" = NULL, "embeddingContextHash" = NULL
  WHERE "documentId" = NEW."id";
  UPDATE "knowledge_documents" SET "vectorRevision" = "vectorRevision" + 1 WHERE "id" = NEW."id";
END;

-- Only rows that carry a vector change what the index holds; a chunk written without one
-- (every new import) costs no revision update, which keeps a large import's transaction short.
CREATE TRIGGER "document_chunks_vector_insert" AFTER INSERT ON "document_chunks"
WHEN NEW."vector" IS NOT NULL
BEGIN
  UPDATE "knowledge_documents" SET "vectorRevision" = "vectorRevision" + 1 WHERE "id" = NEW."documentId";
END;

CREATE TRIGGER "document_chunks_vector_delete" AFTER DELETE ON "document_chunks"
WHEN OLD."vector" IS NOT NULL
BEGIN
  UPDATE "knowledge_documents" SET "vectorRevision" = "vectorRevision" + 1 WHERE "id" = OLD."documentId";
END;

CREATE TRIGGER "document_chunks_vector_update" AFTER UPDATE OF "vector", "embeddingModelId", "embeddingModelProvider", "embeddingContextHash" ON "document_chunks"
BEGIN
  UPDATE "knowledge_documents" SET "vectorRevision" = "vectorRevision" + 1 WHERE "id" = NEW."documentId";
END;
