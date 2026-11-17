import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { test } from "node:test";
import { encodeDocumentVector } from "../../src/lib/documents/vectors";

const require = createRequire(import.meta.url);
const { runDesktopMigrations } = require("../../electron-dist/migrations.js");
const { encodeVector } = require("../../electron-dist/migration-steps.js");
const migrationsDirectory = resolve("src/db/migrations");
const migration = "20261120100000_document_vectors";
const silent = { info() {}, warn() {}, error() {} };

test("the migrator writes the same vector bytes as indexing does", () => {
  for (const values of [[3, 4], [0.1, -0.2, 0.3], Array.from({ length: 1024 }, (_, index) => Math.sin(index))]) {
    assert.deepEqual(Buffer.from(encodeVector(values)), Buffer.from(encodeDocumentVector(values)!));
  }
  for (const bad of [[], [0, 0], [1, Number.NaN], "not a vector", new Array(8193).fill(1)]) {
    assert.equal(encodeVector(bad), null); assert.equal(encodeDocumentVector(bad), null);
  }
});

test("upgrading converts JSON vectors to binary in the migration's transaction, clears unreadable ones, and installs the triggers", () => {
  const root = mkdtempSync(join(tmpdir(), "ria-vector-upgrade-"));
  const databaseFile = join(root, "app.db");
  try {
    const before = new DatabaseSync(databaseFile);
    try {
      before.exec("CREATE TABLE desktop_migrations (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
      for (const directory of readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name < migration).sort((a, b) => a.name.localeCompare(b.name))) {
        before.exec(readFileSync(join(migrationsDirectory, directory.name, "migration.sql"), "utf8"));
        before.prepare("INSERT INTO desktop_migrations (name) VALUES (?)").run(directory.name);
      }
      before.exec(`INSERT INTO knowledge_documents (id,filename,collection,format,byteSize,contentHash,pages,characterCount,indexVersion,updatedAt)
        VALUES ('doc','notes.txt','工作','txt',5,'hash','[{"pageNumber":null,"text":"hello"}]',5,4,CURRENT_TIMESTAMP);`);
      const insert = before.prepare(`INSERT INTO document_chunks (id,documentId,chunkKey,ordinal,text,embedding,embeddingModelId,embeddingModelProvider,embeddingContextHash)
        VALUES (?, 'doc', ?, ?, 'hello', ?, 'test/model', 'openrouter', 'context')`);
      insert.run("good", "k0", 0, JSON.stringify([3, 4]));
      insert.run("zero", "k1", 1, JSON.stringify([0, 0]));
      insert.run("broken", "k2", 2, "{not json");
      insert.run("none", "k3", 3, null);
    } finally { before.close(); }

    const result = runDesktopMigrations({ databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: silent });
    assert.ok(result.applied.includes(migration)); assert.ok(result.backupFile, "the usual pre-migration backup is taken first");
    const after = new DatabaseSync(databaseFile);
    try {
      const row = (id: string) => after.prepare("SELECT vector, embedding, embeddingModelId, embeddingContextHash FROM document_chunks WHERE id = ?").get(id) as { vector: Uint8Array | null; embedding: string | null; embeddingModelId: string | null; embeddingContextHash: string | null };
      assert.deepEqual(Buffer.from(row("good").vector!), Buffer.from(encodeDocumentVector([3, 4])!));
      assert.equal(row("good").embedding, null); assert.equal(row("good").embeddingModelId, "test/model"); assert.equal(row("good").embeddingContextHash, "context");
      for (const id of ["zero", "broken"]) assert.deepEqual({ ...row(id) }, { vector: null, embedding: null, embeddingModelId: null, embeddingContextHash: null }, `${id} is cleared to be built again`);
      assert.equal(row("none").vector, null);

      const revision = () => (after.prepare("SELECT vectorRevision FROM knowledge_documents WHERE id = 'doc'").get() as { vectorRevision: number }).vectorRevision;
      const start = revision();
      after.exec("UPDATE document_chunks SET heading = 'Section' WHERE id = 'good'");
      assert.equal(row("good").vector, null, "a changed section clears the vector");
      assert.ok(revision() > start, "and tells the index to reload the document");
      after.prepare("UPDATE document_chunks SET vector = ?, embeddingModelId = 'test/model', embeddingContextHash = 'c' WHERE id = 'good'").run(encodeDocumentVector([1, 0])!);
      after.exec("UPDATE knowledge_documents SET collection = '归档' WHERE id = 'doc'");
      assert.equal(row("good").vector, null, "a collection move clears every vector of the document");
      // A chunk written without a vector leaves the index as it was, so it costs no revision update.
      const beforeInsert = revision();
      after.exec("INSERT INTO document_chunks (id,documentId,chunkKey,ordinal,text) VALUES ('new','doc','k9',9,'more')");
      assert.equal(revision(), beforeInsert);
      after.prepare("INSERT INTO document_chunks (id,documentId,chunkKey,ordinal,text,vector) VALUES ('vectored','doc','k10',10,'more',?)").run(encodeDocumentVector([0, 1])!);
      assert.ok(revision() > beforeInsert, "one written with a vector is reloaded");
      const beforeDelete = revision();
      after.exec("DELETE FROM document_chunks WHERE id = 'new'");
      assert.equal(revision(), beforeDelete);
      after.exec("DELETE FROM document_chunks WHERE id = 'vectored'");
      assert.ok(revision() > beforeDelete);
    } finally { after.close(); }
    assert.deepEqual(runDesktopMigrations({ databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: silent }).applied, []);
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "ria-vector-upgrade-"))) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});

test("upgrading moves keyword terms into the full-text index whole, repeated by frequency, and drops the old table", async () => {
  const { searchToken: serverToken } = await import("../../src/lib/documents/lexical");
  const { searchToken } = require("../../electron-dist/migration-steps.js");
  for (const term of ["报销", "sqlite_max_attached", "don't", "3.14", "Ünïcode"]) assert.equal(searchToken(term), serverToken(term), term);
  const root = mkdtempSync(join(tmpdir(), "ria-search-upgrade-"));
  const databaseFile = join(root, "app.db");
  const searchMigration = "20261121100000_document_search";
  try {
    const before = new DatabaseSync(databaseFile);
    try {
      before.exec("CREATE TABLE desktop_migrations (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
      for (const directory of readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name < searchMigration).sort((a, b) => a.name.localeCompare(b.name))) {
        before.exec(readFileSync(join(migrationsDirectory, directory.name, "migration.sql"), "utf8"));
        before.prepare("INSERT INTO desktop_migrations (name) VALUES (?)").run(directory.name);
      }
      before.exec(`INSERT INTO knowledge_documents (id,filename,format,byteSize,contentHash,pages,characterCount,indexVersion,updatedAt)
        VALUES ('doc','limits.txt','txt',5,'hash','[]',5,4,CURRENT_TIMESTAMP);
        INSERT INTO document_chunks (id,documentId,chunkKey,ordinal,text,tokenCount) VALUES ('a','doc','k0',0,'SQLITE_MAX_ATTACHED 报销 报销',3), ('b','doc','k1',1,'other',1);
        INSERT INTO document_terms (chunkId,term,frequency) VALUES ('a','sqlite_max_attached',1), ('a','报销',2), ('b','other',1);`);
    } finally { before.close(); }
    runDesktopMigrations({ databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: silent });
    const after = new DatabaseSync(databaseFile);
    try {
      assert.equal(after.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'document_terms'").get().count, 0);
      const terms = (after.prepare("SELECT terms FROM document_chunk_search WHERE chunkId = 'a'").get() as { terms: string }).terms.split(" ");
      assert.deepEqual(terms.sort(), [searchToken("sqlite_max_attached"), searchToken("报销"), searchToken("报销")].sort());
      const match = (term: string) => (after.prepare(`SELECT s.chunkId AS id FROM document_chunk_search_index f JOIN document_chunk_search s ON s.id = f.rowid WHERE document_chunk_search_index MATCH ? ORDER BY bm25(document_chunk_search_index)`).all(`"${searchToken(term)}"`) as Array<{ id: string }>).map(row => row.id);
      assert.deepEqual(match("sqlite_max_attached"), ["a"], "a term with underscores is matched whole");
      assert.deepEqual(match("报销"), ["a"]);
      after.exec("PRAGMA foreign_keys=ON; DELETE FROM document_chunks WHERE id = 'a'");
      assert.deepEqual(match("报销"), [], "deleting a chunk takes it out of the index");
      assert.deepEqual(match("other"), ["b"]);
    } finally { after.close(); }
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "ria-search-upgrade-"))) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
