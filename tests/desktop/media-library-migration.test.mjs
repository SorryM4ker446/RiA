import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { test } from "node:test";

const { runDesktopMigrations } = createRequire(import.meta.url)("../../electron-dist/migrations.js");
const migrationsDirectory = resolve("src/db/migrations");
test("media library migration preserves old assets and references, backs up metadata and cascades generation links", () => {
  const root = mkdtempSync(join(tmpdir(), "private-ai-media-upgrade-"));
  const databaseFile = join(root, "app.db");
  const migration = "20260831120000_media_library";
  const options = { databaseFile, migrationsDirectory, backupsDirectory: join(root, "backups"), logger: { info() {}, warn() {}, error() {} } };
  try {
    const old = new DatabaseSync(databaseFile);
    try {
      old.exec("CREATE TABLE desktop_migrations (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
      for (const entry of readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name < migration).sort((a, b) => a.name.localeCompare(b.name))) {
        old.exec(readFileSync(join(migrationsDirectory, entry.name, "migration.sql"), "utf8"));
        old.prepare("INSERT INTO desktop_migrations (name) VALUES (?)").run(entry.name);
      }
      old.exec(`INSERT INTO users (id,email,updatedAt) VALUES ('owner','media-upgrade@example.invalid',CURRENT_TIMESTAMP);
        INSERT INTO chats (id,userId,title,updatedAt) VALUES ('chat','owner','Source',CURRENT_TIMESTAMP);
        INSERT INTO messages (id,chatId,role,content) VALUES ('message','chat','user','Attachment');
        INSERT INTO media_assets (id,userId,relativePath,mediaType,byteSize,kind) VALUES ('input','owner','owner/input.png','image/png',8,'attachment');
        INSERT INTO message_media (messageId,assetId) VALUES ('message','input');`);
    } finally { old.close(); }
    const applied = runDesktopMigrations(options);
    assert.deepEqual(applied.applied, readdirSync(migrationsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name >= migration).map(entry => entry.name).sort());
    const backup = new DatabaseSync(applied.backupFile, { readOnly: true });
    try { assert.equal(backup.prepare("SELECT relativePath FROM media_assets").get().relativePath, "owner/input.png"); assert.equal(backup.prepare("PRAGMA table_info(media_assets)").all().some(column => column.name === "generation"), false); }
    finally { backup.close(); }
    const db = new DatabaseSync(databaseFile);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      assert.deepEqual({ ...db.prepare("SELECT generation,sourceChatId FROM media_assets").get() }, { generation: null, sourceChatId: null });
      assert.equal(db.prepare("SELECT count(*) AS count FROM message_media").get().count, 1);
      db.prepare("INSERT INTO media_assets (id,userId,relativePath,mediaType,byteSize,kind,generation,sourceChatId) VALUES ('output','owner','owner/output.png','image/png',8,'generated-image',?,'chat')").run('{"version":1,"type":"image","prompt":"Retained"}');
      db.exec("INSERT INTO media_generation_inputs VALUES ('output','input'); DELETE FROM chats WHERE id='chat'");
      assert.equal(db.prepare("SELECT sourceChatId FROM media_assets WHERE id='output'").get().sourceChatId, null);
      assert.equal(db.prepare("SELECT count(*) AS count FROM media_assets").get().count, 2);
    } finally { db.close(); }
    assert.deepEqual(runDesktopMigrations(options).applied, []);
    const reopened = new DatabaseSync(databaseFile);
    try {
      reopened.exec("PRAGMA foreign_keys=ON");
      assert.equal(reopened.prepare("SELECT inputAssetId FROM media_generation_inputs").get().inputAssetId, "input");
      assert.match(reopened.prepare("SELECT generation FROM media_assets WHERE id='output'").get().generation, /Retained/);
      reopened.exec("DELETE FROM users WHERE id='owner'");
      assert.equal(reopened.prepare("SELECT count(*) AS count FROM media_generation_inputs").get().count, 0);
      assert.equal(reopened.prepare("SELECT count(*) AS count FROM media_assets").get().count, 0);
    } finally { reopened.close(); }
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "private-ai-media-upgrade-"))) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
