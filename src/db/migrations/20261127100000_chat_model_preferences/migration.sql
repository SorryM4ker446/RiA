ALTER TABLE "chats" ADD COLUMN "modelPreferences" JSONB;

-- Older desktop windows stored their selection under the service's changing
-- origin. Recover the requested model from the latest recorded chat answer.
WITH latest AS MATERIALIZED (
  SELECT c.id, (
    SELECT CASE WHEN substr(m.content, 1, 27) = '__ASSISTANT_TOOL_MESSAGE__:'
      AND json_valid(substr(m.content, 28)) THEN json_extract(substr(m.content, 28), '$.modelLabel') END
    FROM messages m
    WHERE m.chatId = c.id AND m.role = 'assistant'
    ORDER BY m.createdAt DESC, m.id DESC LIMIT 1
  ) AS label FROM chats c
), models AS (
  SELECT id, substr(label, 1, instr(label, '/') - 1) AS providerId,
    substr(label, instr(label, '/') + 1) AS modelId
  FROM latest WHERE typeof(label) = 'text' AND instr(label, '/') > 0
)
UPDATE chats SET "modelPreferences" = json_object('selectedChatModel', json_object('providerId', models.providerId, 'modelId', models.modelId))
FROM models WHERE chats.id = models.id AND models.providerId IN ('openrouter', 'deepseek') AND length(models.modelId) BETWEEN 1 AND 200;
