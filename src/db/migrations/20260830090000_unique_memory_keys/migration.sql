-- Keep the newest entry under its original key and preserve every older value
-- under a collision-free key. No memory rows are deleted during this upgrade.
WITH RECURSIVE ranked AS (
    SELECT "id", "userId", "key",
        ROW_NUMBER() OVER (
            PARTITION BY "userId", "key"
            ORDER BY "updatedAt" DESC, "createdAt" DESC, "id" DESC
        ) AS position
    FROM "memories"
), candidates("id", "userId", "newKey") AS (
    SELECT "id", "userId", "key" || ' [duplicate:' || "id" || ']'
    FROM ranked WHERE position > 1
    UNION ALL
    SELECT candidates."id", candidates."userId", candidates."newKey" || '_'
    FROM candidates
    WHERE EXISTS (
        SELECT 1 FROM "memories"
        WHERE "memories"."userId" = candidates."userId"
          AND "memories"."key" = candidates."newKey"
    )
), available AS (
    SELECT * FROM candidates
    WHERE NOT EXISTS (
        SELECT 1 FROM "memories"
        WHERE "memories"."userId" = candidates."userId"
          AND "memories"."key" = candidates."newKey"
    )
)
UPDATE "memories"
SET "key" = (SELECT "newKey" FROM available WHERE available."id" = "memories"."id")
WHERE "id" IN (SELECT "id" FROM available);

DROP INDEX "memories_userId_key_idx";
CREATE UNIQUE INDEX "memories_userId_key_key" ON "memories"("userId", "key");
