import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { runDesktopMigrations } = require("../../electron-dist/migrations.js");
const migrationsDirectory = resolve("src/db/migrations");
test("semantic document migration preserves old evidence and terms with a pre-upgrade backup and idempotent restart", () => {
  const root = mkdtempSync(join(tmpdir(), "private-ai-semantic-upgrade-"));
  const databaseFile = join(root, "app.db");
  const migration = "20261007120000_document_semantic_retrieval";
  try {
    const before = new DatabaseSync(databaseFile);
    try {
      before.exec("CREATE TABLE desktop_migrations (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
      for (const directory of readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name < migration).sort((a, b) => a.name.localeCompare(b.name))) {
        before.exec(readFileSync(join(migrationsDirectory, directory.name, "migration.sql"), "utf8"));
        before.prepare("INSERT INTO desktop_migrations (name) VALUES (?)").run(directory.name);
      }
      before.exec(`INSERT INTO knowledge_documents (id,filename,format,byteSize,contentHash,pages,characterCount,indexVersion,updatedAt)
        VALUES ('doc','notes.txt','txt',5,'old-hash','[{"pageNumber":null,"text":"hello"}]',5,1,CURRENT_TIMESTAMP);
        INSERT INTO document_chunks (id,documentId,chunkKey,ordinal,text) VALUES ('chunk','doc','hash:0',0,'hello');
        INSERT INTO document_terms (chunkId,term) VALUES ('chunk','hello');`);
    } finally { before.close(); }
    const options = { databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} } };
    const result = runDesktopMigrations(options);
    assert.deepEqual(result.applied, [migration]); assert.ok(result.backupFile);
    const backup = new DatabaseSync(result.backupFile, { readOnly: true });
    try {
      assert.equal(backup.prepare("SELECT text FROM document_chunks WHERE id='chunk'").get().text, "hello");
      assert.equal(backup.prepare("PRAGMA table_info(document_chunks)").all().some(row => row.name === "embedding"), false);
    } finally { backup.close(); }
    assert.deepEqual(runDesktopMigrations(options).applied, []);
    const reopened = new DatabaseSync(databaseFile);
    try {
      const chunk = reopened.prepare("SELECT * FROM document_chunks WHERE id='chunk'").get();
      assert.equal(chunk.text, "hello"); assert.equal(chunk.heading, null); assert.equal(chunk.tokenCount, 0); assert.equal(chunk.embedding, null);
      assert.equal(reopened.prepare("SELECT frequency FROM document_terms WHERE chunkId='chunk'").get().frequency, 1);
      reopened.exec("PRAGMA foreign_keys=ON; DELETE FROM knowledge_documents WHERE id='doc'");
      for (const table of ["document_chunks", "document_terms"]) assert.equal(reopened.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    } finally { reopened.close(); }
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "private-ai-semantic-upgrade-"))) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
