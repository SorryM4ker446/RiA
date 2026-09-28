-- A failed catalog refresh used to leave no trace once the page reloaded, so
-- the models page could not tell "this provider is unreachable" from "this
-- provider no longer lists the model". The reason is remembered next to the
-- last good snapshot: a failure must not replace the rows, and it must not
-- vanish either. A successful refresh clears it.
ALTER TABLE "model_catalog_snapshots" ADD COLUMN "lastFailure" TEXT;
ALTER TABLE "model_catalog_snapshots" ADD COLUMN "lastFailureAt" DATETIME;
