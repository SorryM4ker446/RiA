-- A task chooses its own model and working folder, used by every turn in its
-- conversation. A null model means the default chat model at the time of the turn.
ALTER TABLE "scheduled_jobs" ADD COLUMN "modelProvider" TEXT;
ALTER TABLE "scheduled_jobs" ADD COLUMN "modelId" TEXT;
ALTER TABLE "scheduled_jobs" ADD COLUMN "workspaceGrantId" TEXT REFERENCES "directory_grants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A folder chosen in a task's conversation moves onto the task, which now owns it.
UPDATE "scheduled_jobs" SET "workspaceGrantId" = (
  SELECT "workspaceGrantId" FROM "chats" WHERE "chats"."id" = "scheduled_jobs"."chatId"
) WHERE "chatId" IS NOT NULL;
UPDATE "chats" SET "workspaceGrantId" = NULL
  WHERE "id" IN (SELECT "chatId" FROM "scheduled_jobs" WHERE "chatId" IS NOT NULL);

-- A task's conversation is a general-assistant conversation: an assistant
-- template applied to one earlier is taken off, so its bound model and tool
-- list no longer decide what the task's turns use.
UPDATE "chats" SET "assistantConfig" = NULL
  WHERE "assistantConfig" IS NOT NULL
    AND "id" IN (SELECT "chatId" FROM "scheduled_jobs" WHERE "chatId" IS NOT NULL);
