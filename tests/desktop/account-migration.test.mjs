import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { test } from "node:test";

const { runDesktopMigrations } = createRequire(import.meta.url)("../../electron-dist/migrations.js");

const SINGLE_USER_MIGRATION = "20260901100000_single_user_workspace";

/** Every account-scoped migration that a pre-upgrade installation has applied. */
function accountScopedMigrations(migrationsDirectory) {
  return readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name < SINGLE_USER_MIGRATION)
    .map((entry) => entry.name)
    .sort();
}

test("workspace upgrade keeps content, drops the account schema and leaves the old schema in the snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "private-ai-account-upgrade-"));
  const databaseFile = join(root, "app.db");
  const migrationsDirectory = resolve("src/db/migrations");
  const backupDirectory = join(root, "backups");
  const options = {
    databaseFile,
    migrationsDirectory,
    backupsDirectory: backupDirectory,
    logger: { info() {}, warn() {}, error() {} },
  };
  try {
    const before = accountScopedMigrations(migrationsDirectory);
    const old = new DatabaseSync(databaseFile);
    try {
      old.exec('CREATE TABLE "desktop_migrations" (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)');
      for (const name of before) {
        old.exec(readFileSync(join(migrationsDirectory, name, "migration.sql"), "utf8"));
        old.prepare('INSERT INTO "desktop_migrations" ("name") VALUES (?)').run(name);
      }
      // Two accounts: the older one holds the content that must survive.
      old.exec(`
        INSERT INTO "users" ("id","email","createdAt","updatedAt") VALUES
          ('owner-keep','keep@example.invalid','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
          ('owner-other','other@example.invalid','2026-06-01T00:00:00Z','2026-06-01T00:00:00Z');
        INSERT INTO "chats" ("id","userId","title","updatedAt") VALUES
          ('chat','owner-keep','History','2026-01-01T00:00:00Z'),
          ('chat-other','owner-other','Other history','2026-06-01T00:00:00Z');
        INSERT INTO "messages" ("id","chatId","role","content") VALUES
          ('message','chat','user','Preserved content'),
          ('message-other','chat-other','user','Other content');
        INSERT INTO "media_assets" ("id","userId","relativePath","mediaType","byteSize","kind") VALUES
          ('asset','owner-keep','legacy/asset.png','image/png',5,'attachment'),
          ('asset-other','owner-other','legacy/asset-other.png','image/png',5,'attachment');
        INSERT INTO "chat_tags" ("chatId","label") VALUES
          ('chat','kept'),
          ('chat-other','dropped');
        INSERT INTO "message_media" ("messageId","assetId") VALUES
          ('message','asset'),
          ('message-other','asset-other');
        INSERT INTO "media_generation_inputs" ("assetId","inputAssetId") VALUES
          ('asset','asset-other');
        INSERT INTO "account_preferences" ("userId","settings","updatedAt") VALUES
          ('owner-keep','{"version":1,"defaultMode":"image"}','2026-01-01T00:00:00Z');
        INSERT INTO "model_requests" ("id","userId","requestId","mode","modelId","status","durationMs","costSource") VALUES
          ('usage','owner-keep','request','chat','offline/model','success',12,'unknown');
      `);
    } finally {
      old.close();
    }

    const applied = runDesktopMigrations(options);
    assert.ok(applied.applied.includes(SINGLE_USER_MIGRATION));
    assert.ok(applied.backupFile && existsSync(applied.backupFile));

    // The snapshot still contains the pre-upgrade schema and every account.
    const backup = new DatabaseSync(applied.backupFile, { readOnly: true });
    try {
      assert.equal(backup.prepare("SELECT content FROM messages WHERE id='message'").get().content, "Preserved content");
      assert.equal(backup.prepare("SELECT count(*) AS count FROM users").get().count, 2);
      assert.equal(
        backup.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='account_preferences'").get().count,
        1,
      );
    } finally {
      backup.close();
    }

    const upgraded = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      // The adopted account's content is untouched; the other account is not
      // carried into the workspace.
      assert.equal(upgraded.prepare("SELECT content FROM messages WHERE id='message'").get().content, "Preserved content");
      assert.equal(upgraded.prepare("SELECT count(*) AS count FROM chats").get().count, 1);
      assert.equal(upgraded.prepare("SELECT count(*) AS count FROM messages").get().count, 1);
      assert.equal(upgraded.prepare('SELECT "id" FROM "chats"').get().id, "chat");

      // Account tables and owner columns are gone from every business table.
      const tables = upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((row) => row.name);
      assert.equal(tables.includes("users"), false);
      assert.equal(tables.includes("sessions"), false);
      for (const table of ["chats", "memories", "tasks", "media_assets", "knowledge_documents", "model_requests", "messages"]) {
        const columns = upgraded.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name);
        assert.equal(columns.includes("userId"), false, `${table} still has userId`);
      }

      // Preferences become a single local row and usage keeps its values.
      const preferences = upgraded.prepare('SELECT "id","settings" FROM "account_preferences"').all();
      assert.equal(preferences.length, 1);
      assert.equal(preferences[0].id, "local");
      assert.equal(JSON.parse(preferences[0].settings).defaultMode, "image");
      assert.equal(upgraded.prepare('SELECT "durationMs" FROM "model_requests"').get().durationMs, 12);
      assert.equal(upgraded.prepare('SELECT count(*) AS count FROM "chat_tags"').get().count, 1);
      assert.equal(upgraded.prepare('SELECT count(*) AS count FROM "message_media"').get().count, 1);
      assert.equal(upgraded.prepare('SELECT count(*) AS count FROM "media_generation_inputs"').get().count, 0);

      assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(upgraded.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally {
      upgraded.close();
    }

    // The search index follows the rebuilt conversation table.
    const writable = new DatabaseSync(databaseFile);
    try {
      writable.exec('INSERT INTO "chats" ("id","title","updatedAt") VALUES (\'chat-search\',\'升级后的搜索验证\',CURRENT_TIMESTAMP)');
      const indexed = writable.prepare("SELECT count(*) AS count FROM chat_title_search").get().count;
      assert.ok(indexed >= 1);
    } finally {
      writable.close();
    }

    assert.deepEqual(runDesktopMigrations(options).applied, []);
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !basename(root).startsWith("private-ai-account-upgrade-")) {
      throw new Error("Unexpected test directory");
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
