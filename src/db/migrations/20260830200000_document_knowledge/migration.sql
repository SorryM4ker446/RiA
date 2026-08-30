CREATE TABLE "knowledge_documents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "pages" JSONB NOT NULL,
    "characterCount" INTEGER NOT NULL,
    "indexVersion" INTEGER NOT NULL,
    "indexedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "knowledge_documents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "knowledge_documents_userId_filename_key" ON "knowledge_documents"("userId", "filename");
CREATE INDEX "knowledge_documents_userId_updatedAt_id_idx" ON "knowledge_documents"("userId", "updatedAt", "id");
CREATE TABLE "document_chunks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "chunkKey" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "pageNumber" INTEGER,
    "text" TEXT NOT NULL,
    CONSTRAINT "document_chunks_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "knowledge_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "document_chunks_documentId_chunkKey_key" ON "document_chunks"("documentId", "chunkKey");
CREATE INDEX "document_chunks_documentId_ordinal_idx" ON "document_chunks"("documentId", "ordinal");
CREATE TABLE "document_terms" (
    "chunkId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    PRIMARY KEY ("chunkId", "term"),
    CONSTRAINT "document_terms_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "document_chunks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "document_terms_term_chunkId_idx" ON "document_terms"("term", "chunkId");
