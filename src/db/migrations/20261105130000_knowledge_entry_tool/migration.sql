-- The tool that saves to the knowledge base was called saveMemory, and "memory" now means
-- MEMORY.md alone. The default templates say so. Anything a person wrote stays as it is;
-- a template or conversation still naming the old id reads under the new one.
UPDATE "assistant_templates" SET "config" = replace(replace(replace(replace("config",
  '"saveMemory"', '"saveKnowledgeEntry"'),
  'keep a lasting fact with saveMemory only when the user wants it kept', 'save a fact to the knowledge base with saveKnowledgeEntry only when the user asks'),
  'offer saveMemory for lasting style preferences such as tone, terminology or formatting', 'offer saveKnowledgeEntry for reference material worth keeping, such as a glossary or style guide'),
  'offer saveMemory for findings worth reusing', 'offer saveKnowledgeEntry for findings worth reusing')
WHERE "id" LIKE 'builtin_%';
