-- Whether a conversation has an answer the user has not opened yet. Set when a
-- turn ends in it (other than one the user stopped there), cleared when it is
-- opened. Conversations from before start as read.
ALTER TABLE "chats" ADD COLUMN "unread" BOOLEAN NOT NULL DEFAULT false;
