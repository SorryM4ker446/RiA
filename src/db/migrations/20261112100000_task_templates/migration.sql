-- A task made from a template remembers which one. While its name or prompt is
-- empty it has not been rewritten, and the template's wording in the interface
-- language is used each time it is shown or run.
ALTER TABLE "scheduled_jobs" ADD COLUMN "template" TEXT;

-- The interface language, saved when the user chooses it, so work that runs
-- with nobody looking is worded in it too.
CREATE TABLE "interface_preferences" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'local',
  "locale" TEXT NOT NULL,
  "updatedAt" DATETIME NOT NULL
);

-- The brief and the summary carried over from earlier versions, and any task
-- still worded exactly as one of them, follow the template from now on.
UPDATE "scheduled_jobs" SET "template" = 'dailyBrief', "prompt" = NULL
  WHERE "kind" = 'prompt' AND "prompt" IN (
    '用 readWorkspaceActivity 读取上一个完整日的工作区记录，然后用几句话总结发生了什么、有什么值得今天继续跟进。只依据读到的记录，不要编造；记录不完整时照实说明。',
    'Use readWorkspaceActivity to read the workspace''s record for the last complete day, then say in a few sentences what happened and what is worth following up today. Rely only on what the record shows and invent nothing; if the record is incomplete, say so.');
UPDATE "scheduled_jobs" SET "template" = 'weeklySummary', "prompt" = NULL
  WHERE "kind" = 'prompt' AND "prompt" IN (
    '用 readWorkspaceActivity 读取上一个完整周的工作区记录，然后总结这一周发生了什么、有什么值得下周继续跟进。只依据读到的记录，不要编造；记录不完整时照实说明。',
    'Use readWorkspaceActivity to read the workspace''s record for the last complete week, then summarise what happened and what is worth following up next week. Rely only on what the record shows and invent nothing; if the record is incomplete, say so.');
UPDATE "scheduled_jobs" SET "title" = '' WHERE "template" = 'dailyBrief' AND "title" IN ('每日简报', 'Daily brief');
UPDATE "scheduled_jobs" SET "title" = '' WHERE "template" = 'weeklySummary' AND "title" IN ('每周总结', 'Weekly summary');
