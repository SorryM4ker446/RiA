ALTER TABLE "chats" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "chats" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "chats_userId_archived_pinned_lastMessageAt_id_idx" ON "chats"("userId","archived","pinned","lastMessageAt","id");

CREATE TABLE "chat_tags" (
  "chatId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  PRIMARY KEY ("chatId","label"),
  FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "chat_tags_label_chatId_idx" ON "chat_tags"("label","chatId");

-- SQL-managed indexes cover existing rows and every write path, including regeneration and cascades.
-- Stable application IDs survive SQLite VACUUM, which can reassign implicit rowids.
CREATE VIRTUAL TABLE "chat_title_search" USING fts5(id, text, tokenize='trigram');
CREATE VIRTUAL TABLE "message_text_search" USING fts5(id, text, tokenize='trigram');
INSERT INTO "chat_title_search"(id,text) SELECT id,title FROM "chats";
INSERT INTO "message_text_search"(id,text) SELECT id,CASE
  WHEN substr(content,1,17)='__USER_MESSAGE__:' THEN
    CASE WHEN json_valid(substr(content,18)) THEN
      CASE WHEN json_type(substr(content,18),'$.text')='text' THEN json_extract(substr(content,18),'$.text') ELSE '' END
    ELSE '' END
  WHEN substr(content,1,27)='__ASSISTANT_TOOL_MESSAGE__:' THEN
    CASE WHEN json_valid(substr(content,28)) THEN
      CASE WHEN json_type(substr(content,28),'$.text')='text' THEN json_extract(substr(content,28),'$.text') ELSE '' END
    ELSE '' END
  WHEN substr(content,1,17)='__IMAGE_RESULT__:' THEN
    CASE WHEN json_valid(substr(content,18)) THEN
      CASE WHEN json_type(substr(content,18),'$.text')='text' THEN json_extract(substr(content,18),'$.text') ELSE '' END
    ELSE '' END
  WHEN substr(content,1,17)='__VIDEO_RESULT__:' THEN
    CASE WHEN json_valid(substr(content,18)) THEN
      CASE WHEN json_type(substr(content,18),'$.text')='text' THEN json_extract(substr(content,18),'$.text') ELSE '' END
    ELSE '' END
  WHEN lower(substr(content,1,5))='data:' THEN ''
  ELSE content
END FROM "messages";

CREATE TRIGGER "chats_search_insert" AFTER INSERT ON "chats" BEGIN
  INSERT INTO "chat_title_search"(id,text) VALUES (new.id,new.title);
END;
CREATE TRIGGER "chats_search_update" AFTER UPDATE OF title,id ON "chats" BEGIN
  DELETE FROM "chat_title_search" WHERE length(old.id)>=3 AND rowid IN
    (SELECT rowid FROM "chat_title_search" WHERE id MATCH ('"' || replace(old.id,'"','""') || '"')) AND id=old.id;
  DELETE FROM "chat_title_search" WHERE length(old.id)<3 AND id=old.id;
  INSERT INTO "chat_title_search"(id,text) VALUES (new.id,new.title);
END;
CREATE TRIGGER "chats_search_delete" AFTER DELETE ON "chats" BEGIN
  DELETE FROM "chat_title_search" WHERE length(old.id)>=3 AND rowid IN
    (SELECT rowid FROM "chat_title_search" WHERE id MATCH ('"' || replace(old.id,'"','""') || '"')) AND id=old.id;
  DELETE FROM "chat_title_search" WHERE length(old.id)<3 AND id=old.id;
END;
CREATE TRIGGER "messages_search_insert" AFTER INSERT ON "messages" BEGIN
  INSERT INTO "message_text_search"(id,text) VALUES (new.id,CASE
  WHEN substr(new.content,1,17)='__USER_MESSAGE__:' THEN
    CASE WHEN json_valid(substr(new.content,18)) THEN
      CASE WHEN json_type(substr(new.content,18),'$.text')='text' THEN json_extract(substr(new.content,18),'$.text') ELSE '' END
    ELSE '' END
  WHEN substr(new.content,1,27)='__ASSISTANT_TOOL_MESSAGE__:' THEN
    CASE WHEN json_valid(substr(new.content,28)) THEN
      CASE WHEN json_type(substr(new.content,28),'$.text')='text' THEN json_extract(substr(new.content,28),'$.text') ELSE '' END
    ELSE '' END
  WHEN substr(new.content,1,17)='__IMAGE_RESULT__:' THEN
    CASE WHEN json_valid(substr(new.content,18)) THEN
      CASE WHEN json_type(substr(new.content,18),'$.text')='text' THEN json_extract(substr(new.content,18),'$.text') ELSE '' END
    ELSE '' END
  WHEN substr(new.content,1,17)='__VIDEO_RESULT__:' THEN
    CASE WHEN json_valid(substr(new.content,18)) THEN
      CASE WHEN json_type(substr(new.content,18),'$.text')='text' THEN json_extract(substr(new.content,18),'$.text') ELSE '' END
    ELSE '' END
  WHEN lower(substr(new.content,1,5))='data:' THEN ''
  ELSE new.content
END);
END;
CREATE TRIGGER "messages_search_update" AFTER UPDATE OF content,id ON "messages" BEGIN
  DELETE FROM "message_text_search" WHERE length(old.id)>=3 AND rowid IN
    (SELECT rowid FROM "message_text_search" WHERE id MATCH ('"' || replace(old.id,'"','""') || '"')) AND id=old.id;
  DELETE FROM "message_text_search" WHERE length(old.id)<3 AND id=old.id;
  INSERT INTO "message_text_search"(id,text) VALUES (new.id,CASE
  WHEN substr(new.content,1,17)='__USER_MESSAGE__:' THEN
    CASE WHEN json_valid(substr(new.content,18)) THEN
      CASE WHEN json_type(substr(new.content,18),'$.text')='text' THEN json_extract(substr(new.content,18),'$.text') ELSE '' END
    ELSE '' END
  WHEN substr(new.content,1,27)='__ASSISTANT_TOOL_MESSAGE__:' THEN
    CASE WHEN json_valid(substr(new.content,28)) THEN
      CASE WHEN json_type(substr(new.content,28),'$.text')='text' THEN json_extract(substr(new.content,28),'$.text') ELSE '' END
    ELSE '' END
  WHEN substr(new.content,1,17)='__IMAGE_RESULT__:' THEN
    CASE WHEN json_valid(substr(new.content,18)) THEN
      CASE WHEN json_type(substr(new.content,18),'$.text')='text' THEN json_extract(substr(new.content,18),'$.text') ELSE '' END
    ELSE '' END
  WHEN substr(new.content,1,17)='__VIDEO_RESULT__:' THEN
    CASE WHEN json_valid(substr(new.content,18)) THEN
      CASE WHEN json_type(substr(new.content,18),'$.text')='text' THEN json_extract(substr(new.content,18),'$.text') ELSE '' END
    ELSE '' END
  WHEN lower(substr(new.content,1,5))='data:' THEN ''
  ELSE new.content
END);
END;
CREATE TRIGGER "messages_search_delete" AFTER DELETE ON "messages" BEGIN
  DELETE FROM "message_text_search" WHERE length(old.id)>=3 AND rowid IN
    (SELECT rowid FROM "message_text_search" WHERE id MATCH ('"' || replace(old.id,'"','""') || '"')) AND id=old.id;
  DELETE FROM "message_text_search" WHERE length(old.id)<3 AND id=old.id;
END;
