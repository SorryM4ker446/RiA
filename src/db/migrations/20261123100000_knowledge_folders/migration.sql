-- Folders the knowledge base keeps in step with: each supported file in the folder is a
-- document, imported again when it changes and removed when it leaves the folder. A
-- folder is only read; adding one grants the assistant nothing. The file rows remember
-- each file's size and modification time, so a scan reads only what changed.
CREATE TABLE "knowledge_folders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "realPath" TEXT NOT NULL,
    "collection" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "knowledge_folders_label_key" ON "knowledge_folders"("label");
CREATE UNIQUE INDEX "knowledge_folders_realPath_key" ON "knowledge_folders"("realPath");

CREATE TABLE "knowledge_folder_files" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "folderId" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "documentId" TEXT,
    "byteSize" INTEGER NOT NULL,
    "modifiedAt" REAL NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "knowledge_folder_files_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "knowledge_folders" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "knowledge_folder_files_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "knowledge_documents" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "knowledge_folder_files_folderId_relativePath_key" ON "knowledge_folder_files"("folderId", "relativePath");
CREATE INDEX "knowledge_folder_files_documentId_idx" ON "knowledge_folder_files"("documentId");
