-- Notices the app keeps in the app, not only on screen. A notification the
-- system refuses to show must not take the message with it, so the reminder
-- centre reads from here. The fingerprint is unique so a notice that repeats
-- updates the row it already has instead of stacking a new one daily.
CREATE TABLE "app_notices" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "href" TEXT,
    "fingerprint" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "app_notices_fingerprint_key" ON "app_notices"("fingerprint");
CREATE INDEX "app_notices_readAt_createdAt_idx" ON "app_notices"("readAt", "createdAt");
