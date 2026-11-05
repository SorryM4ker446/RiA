-- What goes with a conversation's summary besides its text: tool calls it stands
-- in for, and the files and skills to put back after a fold. Existing summaries
-- stay valid with nothing recorded here.
ALTER TABLE "chats" ADD COLUMN "summaryState" TEXT;
