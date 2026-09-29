-- One row per granted folder. Two grant requests for the same directory could
-- both read the table and both find nothing before either inserted, so the
-- folder appeared twice in the settings list and revoking one of the two looked
-- like it had done nothing. The unique constraint is what settles the race; the
-- request that loses it revives the row the winner created.
--
-- Existing duplicates are collapsed first so an installation that already has
-- them can still apply this. A row is only deleted when another row for the
-- same folder is strictly better by this order: still in force before
-- withdrawn, then used most recently, then granted most recently. The survivor
-- is therefore never a withdrawal in place of a permission that was live.
-- Nothing is lost that mattered: a grant is a permission on this machine and is
-- deliberately absent from every backup.
DELETE FROM "directory_grants" AS g
WHERE EXISTS (
    SELECT 1
    FROM "directory_grants" AS k
    WHERE k."realPath" = g."realPath"
      AND k."id" <> g."id"
      AND (
        (k."revokedAt" IS NULL) > (g."revokedAt" IS NULL)
        OR (
          (k."revokedAt" IS NULL) = (g."revokedAt" IS NULL)
          AND (
            COALESCE(k."lastUsedAt", '') > COALESCE(g."lastUsedAt", '')
            OR (
              COALESCE(k."lastUsedAt", '') = COALESCE(g."lastUsedAt", '')
              AND (
                k."createdAt" > g."createdAt"
                OR (k."createdAt" = g."createdAt" AND k."id" > g."id")
              )
            )
          )
        )
      )
);
CREATE UNIQUE INDEX "directory_grants_realPath_key" ON "directory_grants"("realPath");
