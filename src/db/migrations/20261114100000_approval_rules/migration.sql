-- What the model may do in a workspace without asking becomes a rule of each
-- conversation and each task, rather than a setting of the folder: "ask" before
-- file edits and terminal commands, "acceptEdits" to make file edits and ask
-- before commands, "full" to do both.
ALTER TABLE "chats" ADD COLUMN "approvalRule" TEXT NOT NULL DEFAULT 'ask';
ALTER TABLE "scheduled_jobs" ADD COLUMN "approvalRule" TEXT NOT NULL DEFAULT 'ask';

-- A conversation or task working in a folder that ran commands without asking
-- keeps doing so. Everything else asks, as before.
UPDATE "chats" SET "approvalRule" = 'full'
  WHERE "workspaceGrantId" IN (SELECT "id" FROM "directory_grants" WHERE "terminalEnabled" = 1 AND "terminalApprovalMode" = 'full-access');
UPDATE "scheduled_jobs" SET "approvalRule" = 'full'
  WHERE "workspaceGrantId" IN (SELECT "id" FROM "directory_grants" WHERE "terminalEnabled" = 1 AND "terminalApprovalMode" = 'full-access');

-- The rule a new conversation starts with. One row, written when it is first changed.
CREATE TABLE "approval_preferences" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'local',
  "defaultRule" TEXT NOT NULL DEFAULT 'ask',
  "updatedAt" DATETIME NOT NULL
);

-- A granted folder is a folder the model may work in, terminal included; there
-- is no separate switch for the terminal any more.
ALTER TABLE "directory_grants" DROP COLUMN "terminalEnabled";
ALTER TABLE "directory_grants" DROP COLUMN "terminalApprovalMode";
