-- Tasks become one thing: something that runs at a time, either a prompt the
-- model carries out in the task's own conversation or a built-in action.
ALTER TABLE "scheduled_jobs" ADD COLUMN "title" TEXT NOT NULL DEFAULT '';
ALTER TABLE "scheduled_jobs" ADD COLUMN "prompt" TEXT;
ALTER TABLE "scheduled_jobs" ADD COLUMN "cron" TEXT;
ALTER TABLE "scheduled_jobs" ADD COLUMN "chatId" TEXT REFERENCES "chats"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The daily or weekly time each schedule held, as a cron expression.
UPDATE "scheduled_jobs" SET "cron" =
  CAST(substr("localTime", 4, 2) AS INTEGER) || ' ' || CAST(substr("localTime", 1, 2) AS INTEGER) || ' * * ' ||
  CASE WHEN "interval" = 'weekly' AND "dayOfWeek" IS NOT NULL THEN CAST("dayOfWeek" AS TEXT) ELSE '*' END;

UPDATE "scheduled_jobs" SET "title" = '定时备份' WHERE "kind" = 'scheduledBackup';
UPDATE "scheduled_jobs" SET "title" = '备份提醒' WHERE "kind" = 'backupReminder';
-- The brief and the summary are now ordinary prompts, which can be edited.
-- They are switched off: a run now makes model calls with tools, which the old
-- schedule never did, so whether they run again is the user's decision.
UPDATE "scheduled_jobs" SET "kind" = 'prompt', "enabled" = 0, "title" = '每日简报',
  "prompt" = '用 readWorkspaceActivity 读取上一个完整日的工作区记录，然后用几句话总结发生了什么、有什么值得今天继续跟进。只依据读到的记录，不要编造；记录不完整时照实说明。'
  WHERE "kind" = 'dailyBrief';
UPDATE "scheduled_jobs" SET "kind" = 'prompt', "enabled" = 0, "title" = '每周总结',
  "prompt" = '用 readWorkspaceActivity 读取上一个完整周的工作区记录，然后总结这一周发生了什么、有什么值得下周继续跟进。只依据读到的记录，不要编造；记录不完整时照实说明。'
  WHERE "kind" = 'weeklySummary';

-- To-dos that were not finished are kept as tasks that are switched off, so
-- nothing starts running that the user did not ask to run. One with a deadline
-- keeps it as the time it would run once. Finished ones are not carried over;
-- the backup taken before this migration still holds them.
-- The old time columns are still required until they are dropped below; their values are never read.
INSERT INTO "scheduled_jobs" ("id", "kind", "title", "prompt", "enabled", "cron", "timeZone", "nextRunAt", "createdAt", "updatedAt", "localTime", "interval")
SELECT "id", 'prompt', substr("title", 1, 120),
  CASE WHEN "details" IS NULL OR trim("details") = '' THEN "title" ELSE "title" || char(10) || char(10) || "details" END,
  0, NULL, "timeZone", coalesce("dueDate", "createdAt"), "createdAt", "updatedAt", '00:00', 'daily'
FROM "tasks" WHERE "status" != 'done';

DROP TABLE "tasks";

ALTER TABLE "scheduled_jobs" DROP COLUMN "localTime";
ALTER TABLE "scheduled_jobs" DROP COLUMN "interval";
ALTER TABLE "scheduled_jobs" DROP COLUMN "dayOfWeek";
ALTER TABLE "scheduled_jobs" DROP COLUMN "useModel";

-- Whether a notice has been handed to the desktop to show as a system
-- notification. Existing notices are marked as already shown.
ALTER TABLE "app_notices" ADD COLUMN "notifiedAt" DATETIME;
UPDATE "app_notices" SET "notifiedAt" = "createdAt";
