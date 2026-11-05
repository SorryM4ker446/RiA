-- How MEMORY.md's notes are sorted into topics for a person to look through. Worked out
-- from the notes, so a row without it has its notes sorted again.
ALTER TABLE "memory_documents" ADD COLUMN "topics" TEXT NOT NULL DEFAULT '[]';
