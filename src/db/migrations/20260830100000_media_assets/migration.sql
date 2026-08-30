CREATE TABLE "media_assets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "modelId" TEXT,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    CONSTRAINT "media_assets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "media_assets_relativePath_key" ON "media_assets"("relativePath");
CREATE INDEX "media_assets_userId_createdAt_idx" ON "media_assets"("userId", "createdAt");

CREATE TABLE "message_media" (
    "messageId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    PRIMARY KEY ("messageId", "assetId"),
    CONSTRAINT "message_media_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "message_media_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "media_assets" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "message_media_assetId_idx" ON "message_media"("assetId");
