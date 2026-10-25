-- Creating a task no longer leaves a memory suggestion behind: the task itself
-- is kept on the tasks page. Suggestions it left earlier that were never
-- accepted are removed. Accepted entries, and suggestions from other tools,
-- stay as they are. Running this again finds nothing more to remove.
DELETE FROM "memories"
WHERE substr("key", 1, 16) = 'tool:createTask:'
  AND "source" = 'assistant'
  AND "confirmed" = 0;
