import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LegacyDatasetInventory, LegacyOwnerProfile } from "./legacy-inventory";

/**
 * A workspace snapshot is taken before any destructive upgrade. It records the
 * database, the business counts that were observed, and the media files the
 * database refers to, so a failed upgrade can be explained, verified and
 * reverted instead of leaving the user with a half-converted workspace.
 */

export const SNAPSHOT_MANIFEST_NAME = "snapshot.json";
export const SNAPSHOT_DATABASE_NAME = "app.db";
export const SNAPSHOT_VERSION = 1;

export type SnapshotMediaEntry = {
  relativePath: string;
  byteSize: number;
  sha256: string | null;
  missing: boolean;
};

export type SnapshotManifest = {
  version: number;
  createdAt: string;
  sourceDatabaseFile: string;
  databaseBytes: number;
  databaseSha256: string;
  decisionReason: string;
  adoptedOwner: LegacyOwnerProfile | null;
  ownerCounts: Record<string, number>;
  tableCounts: Record<string, number>;
  media: {
    directory: string | null;
    fileCount: number;
    totalBytes: number;
    missingCount: number;
    truncated: boolean;
  };
};

export type WorkspaceSnapshot = {
  directory: string;
  manifest: SnapshotManifest;
  databaseFile: string;
};

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function snapshotDirectoryName(now: Date, suffix: string): string {
  const stamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return `${stamp}-${suffix}`;
}

/**
 * Reads table counts and referenced media paths without touching the source
 * database. Missing media is reported, never repaired here.
 */
function readTableCounts(databaseFile: string, tables: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    for (const table of tables) {
      try {
        const row = database.prepare(`SELECT count(*) AS count FROM "${table}"`).get() as { count?: number } | undefined;
        counts[table] = Number(row?.count ?? 0);
      } catch {
        counts[table] = 0;
      }
    }
  } finally {
    database.close();
  }
  return counts;
}

function readMediaEntries(
  databaseFile: string,
  mediaDirectory: string | null,
  limits: { maxFiles: number },
): { entries: SnapshotMediaEntry[]; truncated: boolean } {
  if (!mediaDirectory || !existsSync(mediaDirectory)) return { entries: [], truncated: false };
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  let paths: string[] = [];
  try {
    const hasTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'media_assets'")
      .get() as { name?: string } | undefined;
    if (hasTable?.name === "media_assets") {
      paths = (database.prepare('SELECT "relativePath" FROM "media_assets" ORDER BY "relativePath"').all() as Array<{
        relativePath?: string;
      }>)
        .map((row) => String(row.relativePath ?? ""))
        .filter((value) => value.length > 0);
    }
  } catch {
    paths = [];
  } finally {
    database.close();
  }

  const truncated = paths.length > limits.maxFiles;
  const entries: SnapshotMediaEntry[] = [];
  for (const relativePath of paths.slice(0, limits.maxFiles)) {
    const absolute = join(mediaDirectory, ...relativePath.split("/"));
    if (!existsSync(absolute)) {
      entries.push({ relativePath, byteSize: 0, sha256: null, missing: true });
      continue;
    }
    try {
      entries.push({ relativePath, byteSize: statSync(absolute).size, sha256: sha256File(absolute), missing: false });
    } catch {
      entries.push({ relativePath, byteSize: 0, sha256: null, missing: true });
    }
  }
  return { entries, truncated };
}

export function createWorkspaceSnapshot(input: {
  databaseFile: string;
  mediaDirectory: string | null;
  backupsDirectory: string;
  inventory: LegacyDatasetInventory;
  adoptedOwner: LegacyOwnerProfile | null;
  decisionReason: string;
  suffix: string;
  now?: Date;
  limits?: { maxMediaFiles: number };
}): WorkspaceSnapshot {
  if (!existsSync(input.databaseFile)) throw new Error("Cannot snapshot a database that does not exist.");

  const now = input.now ?? new Date();
  const directory = join(input.backupsDirectory, snapshotDirectoryName(now, input.suffix));
  mkdirSync(directory, { recursive: true });

  const databaseTarget = join(directory, SNAPSHOT_DATABASE_NAME);
  copyFileSync(input.databaseFile, databaseTarget);
  const databaseBytes = statSync(databaseTarget).size;
  const databaseSha256 = sha256File(databaseTarget);

  const media = readMediaEntries(input.databaseFile, input.mediaDirectory, {
    maxFiles: input.limits?.maxMediaFiles ?? 50_000,
  });
  if (media.entries.length > 0 || media.truncated) {
    writeFileSync(
      join(directory, "media-index.json"),
      `${JSON.stringify({ version: SNAPSHOT_VERSION, entries: media.entries, truncated: media.truncated }, null, 2)}\n`,
      "utf8",
    );
  }

  const manifest: SnapshotManifest = {
    version: SNAPSHOT_VERSION,
    createdAt: now.toISOString(),
    sourceDatabaseFile: input.databaseFile,
    databaseBytes,
    databaseSha256,
    decisionReason: input.decisionReason,
    adoptedOwner: input.adoptedOwner,
    ownerCounts: input.inventory.owners.reduce<Record<string, number>>((accumulator, owner) => {
      accumulator[owner.id] = Object.values(owner.counts).reduce((total, count) => total + count, 0);
      return accumulator;
    }, {}),
    tableCounts: readTableCounts(databaseTarget, input.inventory.tables),
    media: {
      directory: input.mediaDirectory,
      fileCount: media.entries.length,
      totalBytes: media.entries.reduce((total, entry) => total + entry.byteSize, 0),
      missingCount: media.entries.filter((entry) => entry.missing).length,
      truncated: media.truncated,
    },
  };

  writeFileSync(join(directory, SNAPSHOT_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return { directory, manifest, databaseFile: databaseTarget };
}

export function readSnapshotManifest(directory: string): SnapshotManifest {
  const manifestFile = join(directory, SNAPSHOT_MANIFEST_NAME);
  if (!existsSync(manifestFile)) throw new Error(`Snapshot manifest is missing: ${manifestFile}`);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as SnapshotManifest;
  if (manifest.version !== SNAPSHOT_VERSION) {
    throw new Error(`Unsupported snapshot version: ${manifest.version}`);
  }
  return manifest;
}

export function verifyWorkspaceSnapshot(directory: string): {
  ok: boolean;
  problems: string[];
  manifest: SnapshotManifest;
} {
  const manifest = readSnapshotManifest(directory);
  const problems: string[] = [];
  const databaseFile = join(directory, SNAPSHOT_DATABASE_NAME);
  if (!existsSync(databaseFile)) {
    problems.push("快照中缺少数据库文件。");
    return { ok: false, problems, manifest };
  }
  const bytes = statSync(databaseFile).size;
  if (bytes !== manifest.databaseBytes) problems.push(`快照数据库大小不一致：期望 ${manifest.databaseBytes}，实际 ${bytes}。`);
  const digest = sha256File(databaseFile);
  if (digest !== manifest.databaseSha256) problems.push("快照数据库校验值不一致，文件可能已损坏。");

  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (integrity?.integrity_check !== "ok") {
      problems.push(`快照数据库完整性检查失败：${integrity?.integrity_check ?? "未知结果"}。`);
    }
  } catch (error) {
    problems.push(`无法读取快照数据库：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    database.close();
  }
  return { ok: problems.length === 0, problems, manifest };
}

/**
 * Restores the database inside a snapshot over the live workspace. The live
 * file is replaced atomically, and the file it replaced is kept beside the
 * snapshot so a failed restore can be reversed again.
 */
export function restoreWorkspaceSnapshot(input: {
  snapshotDirectory: string;
  targetDatabaseFile: string;
  now?: Date;
}): { restoredFrom: string; replacedBackupFile: string | null } {
  const verification = verifyWorkspaceSnapshot(input.snapshotDirectory);
  if (!verification.ok) {
    throw new Error(`快照未通过校验，已取消恢复：${verification.problems.join(" ")}`);
  }

  mkdirSync(dirname(input.targetDatabaseFile), { recursive: true });
  let replacedBackupFile: string | null = null;
  if (existsSync(input.targetDatabaseFile)) {
    const now = input.now ?? new Date();
    replacedBackupFile = `${input.targetDatabaseFile}.${snapshotDirectoryName(now, "before-restore")}.bak`;
    copyFileSync(input.targetDatabaseFile, replacedBackupFile);
  }

  for (const sidecar of [`${input.targetDatabaseFile}-wal`, `${input.targetDatabaseFile}-shm`]) {
    if (existsSync(sidecar)) rmSync(sidecar, { force: true });
  }

  const staging = `${input.targetDatabaseFile}.restore-${process.pid}`;
  copyFileSync(join(input.snapshotDirectory, SNAPSHOT_DATABASE_NAME), staging);
  renameSync(staging, input.targetDatabaseFile);
  // Ensure the restored file is durable before callers reopen it.
  const handle = openSync(input.targetDatabaseFile, "r");
  closeSync(handle);
  return { restoredFrom: input.snapshotDirectory, replacedBackupFile };
}

/** Newest snapshot in a backups directory, ignoring unrelated files. */
export function listWorkspaceSnapshots(backupsDirectory: string): string[] {
  if (!existsSync(backupsDirectory)) return [];
  return readdirSync(backupsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(backupsDirectory, entry.name, SNAPSHOT_MANIFEST_NAME)))
    .map((entry) => join(backupsDirectory, entry.name))
    .sort();
}

export function snapshotSummaryLine(snapshot: WorkspaceSnapshot): string {
  const manifest = snapshot.manifest;
  return `${basename(snapshot.directory)}: ${manifest.tableCounts.chats ?? 0} 个会话，${manifest.tableCounts.messages ?? 0} 条消息，${manifest.media.fileCount} 个媒体引用`;
}
