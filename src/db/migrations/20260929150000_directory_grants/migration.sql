-- Directory grants: a permission the user gives on this machine, one row per
-- directory they opened to the assistant. Deliberately absent from workspace
-- backups - a path on this machine is not meaningful on another, and a restored
-- archive must not arrive carrying a directory permission nobody granted there.
CREATE TABLE "directory_grants" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "realPath" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "directory_grants_revokedAt_idx" ON "directory_grants"("revokedAt");
