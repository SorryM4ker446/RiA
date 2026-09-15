import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../../src/db/migrations", import.meta.url));

/** Link creation needs different privileges per platform; skip when denied. */
function createLink(target, linkPath) {
  try {
    symlinkSync(target, linkPath, "junction");
    return true;
  } catch {
    try {
      symlinkSync(target, linkPath, "dir");
      return true;
    } catch {
      return false;
    }
  }
}

export function migrationNames() {
  return readdirSync(MIGRATIONS_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * The migration that removes account scoping. Fixtures reproduce the state
 * before it, so it is excluded unless a test asks for it explicitly.
 */
export const SINGLE_USER_WORKSPACE_MIGRATION = "20260901100000_single_user_workspace";

export const ACCOUNT_SCOPED_MIGRATIONS = migrationNames().filter(
  (name) => name < SINGLE_USER_WORKSPACE_MIGRATION,
);

/**
 * Migrations that come after `name` but still belong to the account-scoped
 * schema. Feature migrations can be exercised on their own without also
 * converting the database to a single-user workspace.
 */
export function accountScopedMigrationsFrom(name) {
  return ACCOUNT_SCOPED_MIGRATIONS.filter((migration) => migration >= name);
}

/**
 * Applies the real migration files, so fixtures always match what the
 * application would create. A subset can be requested to reproduce an older
 * installation.
 */
export function applyMigrations(databaseFile, options = {}) {
  const { upTo = null, includeWorkspaceMigration = false } = options;
  const pool = includeWorkspaceMigration ? migrationNames() : ACCOUNT_SCOPED_MIGRATIONS;
  const selected = upTo ? pool.filter((name) => name <= upTo) : pool;
  const database = new DatabaseSync(databaseFile);
  try {
    for (const name of selected) {
      database.exec(readFileSync(join(MIGRATIONS_DIRECTORY, name, "migration.sql"), "utf8"));
    }
  } finally {
    database.close();
  }
  return selected;
}

const OWNER_DEFAULTS = {
  email: null,
  name: null,
  chats: 0,
  messagesPerChat: 1,
  memories: 0,
  tasks: 0,
  mediaAssets: 0,
  documents: 0,
  modelRequests: 0,
  preferences: null,
  sessions: 0,
};

let sequence = 0;

function nextId(prefix) {
  sequence += 1;
  return `${prefix}-${String(sequence).padStart(4, "0")}`;
}

/**
 * Builds a synthetic account-scoped workspace: users with optional business
 * content and optional media files on disk. Everything is written under the
 * caller-provided temporary root; no real user data is read or written.
 */
export function createLegacyWorkspace(root, options = {}) {
  const {
    databaseFile = join(root, "app.db"),
    mediaDirectory = join(root, "media"),
    owners = [],
    withMediaFiles = true,
    schema = "latest",
    corruptOwners = false,
    mediaLinks = [],
  } = options;

  mkdirSync(root, { recursive: true });
  if (withMediaFiles) mkdirSync(mediaDirectory, { recursive: true });
  for (const link of mediaLinks) {
    const linkPath = join(mediaDirectory, ...String(link.path).split("/"));
    mkdirSync(dirname(linkPath), { recursive: true });
    createLink(link.target, linkPath);
  }

  const names = migrationNames();
  const upTo = schema === "latest" ? null : schema;
  applyMigrations(databaseFile, { upTo });

  const database = new DatabaseSync(databaseFile);
  const createdOwners = [];
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    const hasAccountPreferences = names
      .filter((name) => !upTo || name <= upTo)
      .includes("20260831150000_account_preferences_and_model_usage");

    for (const rawOwner of owners) {
      const owner = { ...OWNER_DEFAULTS, ...rawOwner };
      const ownerId = owner.id ?? nextId("owner");
      createdOwners.push({ id: ownerId, email: owner.email, plan: owner });

      database
        .prepare('INSERT INTO "users" ("id", "email", "name", "updatedAt") VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
        .run(ownerId, owner.email ?? `${ownerId}@example.invalid`, owner.name);

      for (let index = 0; index < owner.sessions; index += 1) {
        database
          .prepare(
            'INSERT INTO "sessions" ("id", "userId", "tokenHash", "expiresAt") VALUES (?, ?, ?, ?)',
          )
          .run(nextId("session"), ownerId, nextId("token"), Date.now() + 86_400_000);
      }

      for (let chatIndex = 0; chatIndex < owner.chats; chatIndex += 1) {
        const chatId = nextId("chat");
        database
          .prepare(
            'INSERT INTO "chats" ("id", "userId", "title", "updatedAt") VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
          )
          .run(chatId, ownerId, `${owner.name ?? ownerId} 的会话 ${chatIndex + 1}`);
        for (let messageIndex = 0; messageIndex < owner.messagesPerChat; messageIndex += 1) {
          database
            .prepare(
              'INSERT INTO "messages" ("id", "chatId", "role", "content") VALUES (?, ?, ?, ?)',
            )
            .run(nextId("message"), chatId, messageIndex % 2 === 0 ? "user" : "assistant", `消息内容 ${messageIndex + 1}`);
        }
      }

      for (let index = 0; index < owner.memories; index += 1) {
        database
          .prepare(
            'INSERT INTO "memories" ("id", "userId", "key", "value", "updatedAt") VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
          )
          .run(nextId("memory"), ownerId, `key-${index}`, `value-${index}`);
      }

      for (let index = 0; index < owner.tasks; index += 1) {
        database
          .prepare(
            'INSERT INTO "tasks" ("id", "userId", "title", "updatedAt") VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
          )
          .run(nextId("task"), ownerId, `任务 ${index + 1}`);
      }

      for (let index = 0; index < owner.mediaAssets; index += 1) {
        const assetId = nextId("asset");
        const relativePath = `${createHash("sha256").update(ownerId).digest("hex")}/${assetId}.png`;
        database
          .prepare(
            'INSERT INTO "media_assets" ("id", "userId", "relativePath", "mediaType", "byteSize", "kind") VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(assetId, ownerId, relativePath, "image/png", 5, "attachment");
        if (withMediaFiles) {
          const absolute = join(mediaDirectory, ...relativePath.split("/"));
          mkdirSync(join(absolute, ".."), { recursive: true });
          writeFileSync(absolute, `asset-${assetId}`);
        }
      }

      for (let index = 0; index < owner.documents; index += 1) {
        database
          .prepare(
            'INSERT INTO "knowledge_documents" ("id", "userId", "filename", "format", "byteSize", "contentHash", "pages", "characterCount", "indexVersion", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
          )
          .run(nextId("document"), ownerId, `doc-${index}.txt`, "txt", 5, `hash-${index}`, "[]", 5, 1);
      }

      if (hasAccountPreferences && owner.preferences) {
        database
          .prepare('INSERT INTO "account_preferences" ("userId", "settings", "updatedAt") VALUES (?, ?, CURRENT_TIMESTAMP)')
          .run(ownerId, JSON.stringify(owner.preferences));
      }

      if (hasAccountPreferences) {
        for (let index = 0; index < owner.modelRequests; index += 1) {
          database
            .prepare(
              'INSERT INTO "model_requests" ("id", "userId", "requestId", "mode", "modelId", "status", "durationMs", "costSource") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .run(nextId("usage"), ownerId, nextId("request"), "chat", "offline/model", "success", 100, "unknown");
        }
      }
    }

    if (corruptOwners) database.exec('DROP TABLE "users";');
  } finally {
    database.close();
  }

  return { databaseFile, mediaDirectory, owners: createdOwners };
}

export function readOwnerCounts(databaseFile, ownerId) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const count = (sql, ...parameters) => Number(database.prepare(sql).get(...parameters)?.count ?? 0);
    return {
      chats: count('SELECT count(*) AS count FROM "chats" WHERE "userId" = ?', ownerId),
      memories: count('SELECT count(*) AS count FROM "memories" WHERE "userId" = ?', ownerId),
      tasks: count('SELECT count(*) AS count FROM "tasks" WHERE "userId" = ?', ownerId),
      mediaAssets: count('SELECT count(*) AS count FROM "media_assets" WHERE "userId" = ?', ownerId),
    };
  } finally {
    database.close();
  }
}

export function tableExists(databaseFile, tableName) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName);
    return row?.name === tableName;
  } finally {
    database.close();
  }
}
