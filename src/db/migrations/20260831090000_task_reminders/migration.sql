ALTER TABLE "tasks" ADD COLUMN "timeZone" TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE "tasks" ADD COLUMN "reminderEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tasks" ADD COLUMN "remindedAt" DATETIME;
ALTER TABLE "tasks" ADD COLUMN "repeatRule" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "tasks" ADD COLUMN "repeatAnchor" DATETIME;
ALTER TABLE "tasks" ADD COLUMN "repeatGenerated" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "tasks_userId_reminderEnabled_remindedAt_dueDate_idx" ON "tasks"("userId", "reminderEnabled", "remindedAt", "dueDate");
