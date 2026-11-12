-- Several conversations can answer at once now, and model work past the limit
-- waits for a place instead of being refused. Settings still at the earlier
-- defaults move to the new ones: 8 calls at once (was 4) and 1000 automatic task
-- runs a day (was 20). A value someone chose is kept.
UPDATE "account_preferences"
SET "settings" = json_set("settings", '$.callLimits.maxConcurrent', 8)
WHERE json_valid("settings") AND json_extract("settings", '$.callLimits.maxConcurrent') = 4;

UPDATE "account_preferences"
SET "settings" = json_set("settings", '$.callLimits.backgroundDailyCalls', 1000)
WHERE json_valid("settings") AND json_extract("settings", '$.callLimits.backgroundDailyCalls') = 20;
