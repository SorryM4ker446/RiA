-- Copies the application wrote to a place the user chose. Kept apart from the
-- archives the workspace created: only those keep ageing on this machine, and
-- only these are off it. The reminder reads the created ones; this records the
-- exported ones so the page can tell the user which is which.
CREATE TABLE "backup_exports" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "backupId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "exportedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "backup_exports_exportedAt_idx" ON "backup_exports"("exportedAt");
