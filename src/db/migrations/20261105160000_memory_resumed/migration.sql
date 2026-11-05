-- When long-term memory was last turned back on for a conversation. What was said before
-- that is not read for notes, so what was said with it off stays out of them.
ALTER TABLE "chats" ADD COLUMN "memoryResumedAt" DATETIME;
