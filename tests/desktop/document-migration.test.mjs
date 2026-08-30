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
test("desktop document migration backs up existing data and retains document indexes on restart", () => {
  const root = mkdtempSync(join(tmpdir(), "private-ai-document-upgrade-"));
  const databaseFile = join(root, "app.db");
  const migration = "20260830200000_document_knowledge";
  try {
    const before = new DatabaseSync(databaseFile);
    try {
      before.exec('CREATE TABLE desktop_migrations (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)');
      for (const directory of readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name < migration).sort((a, b) => a.name.localeCompare(b.name))) {
        before.exec(readFileSync(join(migrationsDirectory, directory.name, "migration.sql"), "utf8"));
        before.prepare("INSERT INTO desktop_migrations (name) VALUES (?)").run(directory.name);
      }
      before.exec("INSERT INTO users (id,email,updatedAt) VALUES ('owner','migration@example.invalid',CURRENT_TIMESTAMP); INSERT INTO chats (id,userId,title,updatedAt) VALUES ('chat','owner','Retained chat',CURRENT_TIMESTAMP)");
    } finally { before.close(); }
    const options = { databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} } };
    const applied = runDesktopMigrations(options);
    assert.deepEqual(applied.applied, [migration]);
    assert.ok(applied.backupFile);
    const backup = new DatabaseSync(applied.backupFile, { readOnly: true });
    try {
      assert.equal(backup.prepare("SELECT title FROM chats").get().title, "Retained chat");
      assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'knowledge_documents'").get().count, 0);
    } finally { backup.close(); }
    const updated = new DatabaseSync(databaseFile);
    try {
      updated.exec(`INSERT INTO knowledge_documents (id,userId,filename,format,byteSize,contentHash,pages,characterCount,indexVersion,updatedAt)
        VALUES ('doc','owner','notes.txt','txt',5,'hash','[{"pageNumber":null,"text":"hello"}]',5,1,CURRENT_TIMESTAMP);
        INSERT INTO document_chunks (id,documentId,chunkKey,ordinal,text) VALUES ('chunk','doc','hash:0',0,'hello');
        INSERT INTO document_terms (chunkId,term) VALUES ('chunk','hello');`);
    } finally { updated.close(); }
    assert.deepEqual(runDesktopMigrations(options).applied, []);
    const reopened = new DatabaseSync(databaseFile);
    try {
      reopened.exec("PRAGMA foreign_keys=ON");
      assert.equal(reopened.prepare("SELECT term FROM document_terms").get().term, "hello");
      assert.equal(reopened.prepare("SELECT title FROM chats").get().title, "Retained chat");
      reopened.exec("DELETE FROM users WHERE id = 'owner'");
      for (const table of ["knowledge_documents", "document_chunks", "document_terms"]) assert.equal(reopened.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    } finally { reopened.close(); }
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "private-ai-document-upgrade-"))) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
