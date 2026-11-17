-- Text recognition for the pages of a scanned PDF that carry no text layer. One row per
-- document: which pages are still to be read, the text read so far (saved after every
-- page, so an interrupted run carries on), and how it stands. The PDF itself waits in
-- the cache folder until the text is in the document.
CREATE TABLE "document_ocr" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "pages" JSONB NOT NULL,
    "results" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "document_ocr_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "knowledge_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "document_ocr_documentId_key" ON "document_ocr"("documentId");
CREATE INDEX "document_ocr_status_createdAt_idx" ON "document_ocr"("status", "createdAt");
