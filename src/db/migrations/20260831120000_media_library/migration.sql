ALTER TABLE "media_assets" ADD COLUMN "generation" JSONB;
ALTER TABLE "media_assets" ADD COLUMN "sourceChatId" TEXT REFERENCES "chats"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "media_assets_userId_createdAt_id_idx" ON "media_assets"("userId","createdAt","id");
CREATE INDEX "media_assets_sourceChatId_idx" ON "media_assets"("sourceChatId");
CREATE TABLE "media_generation_inputs" (
  "assetId" TEXT NOT NULL,
  "inputAssetId" TEXT NOT NULL,
  PRIMARY KEY ("assetId","inputAssetId"),
  FOREIGN KEY ("assetId") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("inputAssetId") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "media_generation_inputs_inputAssetId_idx" ON "media_generation_inputs"("inputAssetId");
