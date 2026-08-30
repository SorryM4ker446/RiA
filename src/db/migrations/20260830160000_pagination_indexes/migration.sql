CREATE INDEX "chats_userId_lastMessageAt_id_idx" ON "chats"("userId", "lastMessageAt", "id");
CREATE INDEX "messages_chatId_createdAt_id_idx" ON "messages"("chatId", "createdAt", "id");
CREATE INDEX "memories_userId_updatedAt_id_idx" ON "memories"("userId", "updatedAt", "id");
DROP INDEX "chats_userId_lastMessageAt_idx";
DROP INDEX "messages_chatId_createdAt_idx";
