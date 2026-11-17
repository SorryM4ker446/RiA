-- Keyword search moves from one row per chunk and term (document_terms) to SQLite's
-- full-text index, one row per chunk. The terms are the ones RiA already extracts;
-- each is written as its UTF-8 bytes in hexadecimal, repeated by its frequency, so
-- the index's own tokenizer never splits or folds a term and BM25 sees the same term
-- frequencies and chunk lengths as before. The desktop migrator fills the table from
-- document_terms in the same transaction (electron/migration-steps.ts).
CREATE TABLE "document_chunk_search" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "chunkId" TEXT NOT NULL,
    "terms" TEXT NOT NULL,
    CONSTRAINT "document_chunk_search_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "document_chunks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "document_chunk_search_chunkId_key" ON "document_chunk_search"("chunkId");

-- External content: the index reads its text from the table above and is kept in step
-- by these triggers. It is keyed by that table's own INTEGER PRIMARY KEY, which VACUUM
-- never renumbers, unlike the implicit rowid of document_chunks.
CREATE VIRTUAL TABLE "document_chunk_search_index" USING fts5("terms", content='document_chunk_search', content_rowid='id', tokenize='ascii');

CREATE TRIGGER "document_chunk_search_insert" AFTER INSERT ON "document_chunk_search" BEGIN
  INSERT INTO "document_chunk_search_index" ("rowid", "terms") VALUES (NEW."id", NEW."terms");
END;
CREATE TRIGGER "document_chunk_search_delete" AFTER DELETE ON "document_chunk_search" BEGIN
  INSERT INTO "document_chunk_search_index" ("document_chunk_search_index", "rowid", "terms") VALUES ('delete', OLD."id", OLD."terms");
END;
CREATE TRIGGER "document_chunk_search_update" AFTER UPDATE ON "document_chunk_search" BEGIN
  INSERT INTO "document_chunk_search_index" ("document_chunk_search_index", "rowid", "terms") VALUES ('delete', OLD."id", OLD."terms");
  INSERT INTO "document_chunk_search_index" ("rowid", "terms") VALUES (NEW."id", NEW."terms");
END;
