CREATE TABLE "plugin_packages" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "packageId" TEXT NOT NULL,
  "manifest" JSONB NOT NULL,
  "digest" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "plugin_packages_packageId_key" ON "plugin_packages"("packageId");
ALTER TABLE "extensions" ADD COLUMN "pluginId" TEXT REFERENCES "plugin_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "extensions" ADD COLUMN "pluginKey" TEXT;
CREATE UNIQUE INDEX "extensions_pluginId_pluginKey_key" ON "extensions"("pluginId", "pluginKey");
