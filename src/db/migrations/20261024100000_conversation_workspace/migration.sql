-- Each conversation may choose one granted folder to work in. Withdrawing the
-- grant deletes its row, which clears the choice rather than the conversation.
ALTER TABLE "chats" ADD COLUMN "workspaceGrantId" TEXT REFERENCES "directory_grants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
