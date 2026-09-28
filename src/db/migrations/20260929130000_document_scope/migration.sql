-- Documents gain a topic grouping and conversations gain a scope. Both default
-- to "no grouping" / "everything", so nothing existing changes behaviour.
ALTER TABLE "knowledge_documents" ADD COLUMN "collection" TEXT;
CREATE INDEX "knowledge_documents_collection_idx" ON "knowledge_documents"("collection");
ALTER TABLE "chats" ADD COLUMN "documentScope" TEXT NOT NULL DEFAULT '';
