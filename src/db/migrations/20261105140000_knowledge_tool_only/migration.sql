-- Nothing from the knowledge base goes into a request on its own any more, so the default
-- knowledge template no longer speaks of evidence sent with the request. A template a
-- person changed keeps what they wrote.
UPDATE "assistant_templates" SET "config" = replace("config",
  'Call searchKnowledge when the evidence sent with the request does not cover the question, and open',
  'Search the knowledge base with searchKnowledge before answering anything that may depend on it, and open')
WHERE "id" LIKE 'builtin_%';
