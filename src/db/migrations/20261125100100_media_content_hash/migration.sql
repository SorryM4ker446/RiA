-- The SHA-256 of a media file's bytes, so attaching the same image again reuses
-- the asset already in the library instead of storing another copy. Existing
-- assets have none until one is compared, when it is computed from the file.
-- Additive; older builds ignore the column.
ALTER TABLE "media_assets" ADD COLUMN "contentHash" TEXT;
CREATE INDEX "media_assets_mediaType_byteSize_idx" ON "media_assets"("mediaType", "byteSize");
