-- Who a conversation's title is from, so a short model-written title can replace the placeholder
-- the app made from the first message, and nothing else. Conversations that exist already keep
-- their titles ("named", the default): an old one may have been renamed by hand.
-- Additive; older builds ignore the column.
ALTER TABLE "chats" ADD COLUMN "titleSource" TEXT NOT NULL DEFAULT 'named';
