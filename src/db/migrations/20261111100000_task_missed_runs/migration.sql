-- Whether a task whose time passed while RiA was not running, or was too busy
-- to start it, still runs once when it can (the default, and what every task
-- did until now) or waits for its next time instead.
ALTER TABLE "scheduled_jobs" ADD COLUMN "catchUp" BOOLEAN NOT NULL DEFAULT true;

-- When a run was due, for a run that started on its own, and how many later
-- times of the same task passed before it finished without a run of their own.
ALTER TABLE "scheduled_runs" ADD COLUMN "scheduledFor" DATETIME;
ALTER TABLE "scheduled_runs" ADD COLUMN "missedCount" INTEGER NOT NULL DEFAULT 0;
