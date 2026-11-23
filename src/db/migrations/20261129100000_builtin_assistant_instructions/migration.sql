-- Upgrade untouched built-ins. User edits increment the revision, and conversations keep their saved snapshots.
WITH revisions(id, revision, previousInstructions, instructions) AS (
  VALUES
    ('builtin_knowledge', 3,
      'Focus on answering from the workspace knowledge. Search the knowledge base with searchKnowledge before answering anything that may depend on it, and open a document with readDocument when a passage needs its surrounding context. Use webSearch only when the user asks for outside information or the knowledge cannot answer, and label what came from the web as external. Deliver an answer as a file with convertDocument when asked, and save a fact to the knowledge base with saveKnowledgeEntry only when the user asks.',
      'When the question depends on the user''s materials, search their knowledge base and open the relevant document if an excerpt leaves the rule or its scope unclear. Distinguish outside sources when they help fill a gap. Use the user''s request to decide whether to export an answer or save a knowledge entry.'),
    ('builtin_writing', 2,
      'Focus on drafting, revising and organizing the user''s writing. Keep their meaning, voice and documented facts, and ask about audience, purpose or length only when they would change the result and are not clear. Draw on the user''s own material with searchKnowledge and readDocument, and check facts, names and dates with webSearch instead of guessing them. Never invent quotations or sources. Deliver Markdown, Word or other files with convertDocument when asked, and offer saveKnowledgeEntry for reference material worth keeping, such as a glossary or style guide.',
      'Write for the intended audience and purpose. When revising, preserve the user''s meaning, voice and established facts except where they ask for a change. Draw on their material when it helps and verify consequential factual details when needed.'),
    ('builtin_coding', 4,
      'Focus on understanding and improving software. For an implementation request, inspect the relevant project first, then make the smallest coherent change, preserve unrelated work and validate the behavior it affects. Look up current library and API documentation with webSearch when the project and the knowledge do not settle a question. Separate what was observed from what is suspected, and report what changed, what was verified and what still blocks the work. Track follow-up work with createTask when the user wants it tracked.',
      'For code changes or debugging, start with the code that owns the behavior. Make the smallest coherent change and preserve unrelated work. Choose checks that exercise the affected behavior and report what they established. Consult relevant library or API documentation when the project leaves a question open.'),
    ('builtin_research', 3,
      'Focus on researching the user''s question across the web and the workspace knowledge. Read a document in full with readDocument when excerpts are not enough. Compare sources, dates and differing claims, and fit the answer to the question rather than to a fixed report format. Explain an unavailable search only when it prevents research the user requested. Deliver a write-up with convertDocument when asked, offer saveKnowledgeEntry for findings worth reusing, and createTask for follow-ups to track.',
      'Use the sources that fit the question, and prefer original sources where available. For claims that differ, check whether dates, scope or definitions explain the difference. Explain what the evidence can establish and what remains uncertain.')
)
UPDATE "assistant_templates" AS template
SET "config" = json_set(template."config", '$.instructions', revisions.instructions),
    "revision" = template."revision" + 1,
    "updatedAt" = CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM revisions
WHERE template."id" = revisions.id
  AND template."revision" = revisions.revision
  AND json_extract(template."config", '$.instructions') = revisions.previousInstructions;
