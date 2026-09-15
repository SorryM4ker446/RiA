import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Read-only inspection of an on-disk database before the workspace stops being
 * account-scoped. Nothing in this module writes: every connection is opened
 * read-only and the media walk never follows links.
 */

export const LEGACY_INVENTORY_VERSION = 1;

export type LegacyDatasetState =
  | "absent"
  | "unreadable"
  | "empty"
  | "single"
  | "multiple";

export type LegacyOwnerProfile = {
  id: string;
  email: string | null;
  name: string | null;
  createdAt: string | null;
  /** Account with at least one piece of user content, as opposed to a placeholder row. */
  hasBusinessData: boolean;
  counts: {
    chats: number;
    messages: number;
    memories: number;
    tasks: number;
    mediaAssets: number;
    knowledgeDocuments: number;
    modelRequests: number;
    preferences: number;
  };
};

export type MediaSummary = {
  directory: string | null;
  available: boolean;
  fileCount: number;
  totalBytes: number;
  /** True when the walk stopped early at the file or depth limit. */
  truncated: boolean;
  skippedLinks: number;
};

export type LegacyDatasetInventory = {
  databaseFile: string;
  state: LegacyDatasetState;
  byteSize: number;
  tables: string[];
  owners: LegacyOwnerProfile[];
  totalOwners: number;
  media: MediaSummary;
  unreadableReason?: string;
};

export type LocalWorkspaceInventory = {
  version: number;
  generatedAt: string;
  datasets: LegacyDatasetInventory[];
  /** Which dataset the workspace should adopt, or null when the user must choose. */
  decision:
    | { action: "initialize"; reason: string }
    | { action: "migrate"; datasetIndex: number; ownerId: string; reason: string }
    | { action: "choose"; candidates: Array<{ datasetIndex: number; ownerId: string }>; reason: string }
    | { action: "review"; reason: string };
};

const BUSINESS_TABLES = [
  "chats",
  "messages",
  "memories",
  "tasks",
  "media_assets",
  "knowledge_documents",
  "model_requests",
  "account_preferences",
] as const;

type BusinessTable = (typeof BUSINESS_TABLES)[number];

const OWNER_COLUMN: Partial<Record<BusinessTable, string>> = {
  chats: "userId",
  memories: "userId",
  tasks: "userId",
  media_assets: "userId",
  knowledge_documents: "userId",
  model_requests: "userId",
  account_preferences: "userId",
};

const MEDIA_WALK_LIMITS = { maxFiles: 50_000, maxDepth: 8 };

function tableNames(database: DatabaseSync): Set<string> {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name?: string }>;
  return new Set(rows.map((row) => String(row.name)));
}

/** Accepts both Prisma integer milliseconds and SQL text timestamps. */
export function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "bigint") return new Date(Number(value)).toISOString();
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) return new Date(Number(trimmed)).toISOString();
    const parsed = Date.parse(trimmed.includes("T") ? trimmed : `${trimmed.replace(" ", "T")}Z`);
    return Number.isNaN(parsed) ? trimmed : new Date(parsed).toISOString();
  }
  return null;
}

function countAll(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT count(*) AS count FROM "${table}"`).get() as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function messagesForOwner(database: DatabaseSync, ownerId: string): number {
  const row = database
    .prepare('SELECT count(*) AS count FROM "messages" m JOIN "chats" c ON c."id" = m."chatId" WHERE c."userId" = ?')
    .get(ownerId) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function countForOwner(database: DatabaseSync, table: BusinessTable, ownerId: string): number {
  const column = OWNER_COLUMN[table];
  if (!column) return countAll(database, table);
  const row = database
    .prepare(`SELECT count(*) AS count FROM "${table}" WHERE "${column}" = ?`)
    .get(ownerId) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

export function summarizeMediaDirectory(
  directory: string | null,
  limits: { maxFiles: number; maxDepth: number } = MEDIA_WALK_LIMITS,
): MediaSummary {
  const summary: MediaSummary = {
    directory,
    available: false,
    fileCount: 0,
    totalBytes: 0,
    truncated: false,
    skippedLinks: 0,
  };
  if (!directory || !existsSync(directory)) return summary;

  const rootStat = lstatSync(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return summary;
  summary.available = true;

  const pending: Array<{ path: string; depth: number }> = [{ path: directory, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    if (current.depth > limits.maxDepth) {
      summary.truncated = true;
      continue;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = join(current.path, entry.name);
      if (entry.isSymbolicLink()) {
        summary.skippedLinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        pending.push({ path: entryPath, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        summary.totalBytes += statSync(entryPath).size;
      } catch {
        continue;
      }
      summary.fileCount += 1;
      if (summary.fileCount >= limits.maxFiles) {
        summary.truncated = true;
        return summary;
      }
    }
  }
  return summary;
}

export function inspectLegacyDataset(input: {
  databaseFile: string;
  mediaDirectory?: string | null;
  mediaLimits?: { maxFiles: number; maxDepth: number };
}): LegacyDatasetInventory {
  const empty = (state: LegacyDatasetState, reason?: string): LegacyDatasetInventory => ({
    databaseFile: input.databaseFile,
    state,
    byteSize: 0,
    tables: [],
    owners: [],
    totalOwners: 0,
    media: summarizeMediaDirectory(input.mediaDirectory ?? null, input.mediaLimits),
    ...(reason ? { unreadableReason: reason } : {}),
  });

  if (!existsSync(input.databaseFile)) return empty("absent");

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(input.databaseFile, { readOnly: true });
  } catch (error) {
    return empty("unreadable", error instanceof Error ? error.message : String(error));
  }

  try {
    const tables = tableNames(database);
    if (tables.size === 0) return empty("empty");
    if (!tables.has("users")) {
      // A database without the account tables is already workspace-scoped.
      return {
        ...empty("empty"),
        byteSize: statSync(input.databaseFile).size,
        tables: [...tables].sort(),
      };
    }

    const ownerRows = database
      .prepare('SELECT "id", "email", "name", "createdAt" FROM "users"')
      .all() as Array<{ id?: string; email?: string | null; name?: string | null; createdAt?: unknown }>;

    const owners: LegacyOwnerProfile[] = ownerRows
      .map((row) => String(row.id ?? ""))
      .filter((id) => id.length > 0)
      .map((id) => {
        const row = ownerRows.find((candidate) => String(candidate.id) === id);
        const counts = {
          chats: tables.has("chats") ? countForOwner(database, "chats", id) : 0,
          messages: tables.has("messages") && tables.has("chats") ? messagesForOwner(database, id) : 0,
          memories: tables.has("memories") ? countForOwner(database, "memories", id) : 0,
          tasks: tables.has("tasks") ? countForOwner(database, "tasks", id) : 0,
          mediaAssets: tables.has("media_assets") ? countForOwner(database, "media_assets", id) : 0,
          knowledgeDocuments: tables.has("knowledge_documents")
            ? countForOwner(database, "knowledge_documents", id)
            : 0,
          modelRequests: tables.has("model_requests") ? countForOwner(database, "model_requests", id) : 0,
          preferences: tables.has("account_preferences") ? countForOwner(database, "account_preferences", id) : 0,
        };
        return {
          id,
          email: typeof row?.email === "string" ? row.email : null,
          name: typeof row?.name === "string" ? row.name : null,
          createdAt: normalizeTimestamp(row?.createdAt),
          hasBusinessData: Object.values(counts).some((count) => count > 0),
          counts,
        };
      });

    const state: LegacyDatasetState = owners.length === 0 ? "empty" : owners.length === 1 ? "single" : "multiple";
    return {
      databaseFile: input.databaseFile,
      state,
      byteSize: statSync(input.databaseFile).size,
      tables: [...tables].sort(),
      owners,
      totalOwners: owners.length,
      media: summarizeMediaDirectory(input.mediaDirectory ?? null, input.mediaLimits),
    };
  } catch (error) {
    return empty("unreadable", error instanceof Error ? error.message : String(error));
  } finally {
    database.close();
  }
}

/**
 * Chooses what the workspace should adopt. Empty placeholder accounts never
 * force a choice on the user; real content in more than one account does.
 */
export function decideWorkspaceAdoption(
  datasets: LegacyDatasetInventory[],
): LocalWorkspaceInventory["decision"] {
  const unreadable = datasets.filter((dataset) => dataset.state === "unreadable");
  if (unreadable.length > 0) {
    return {
      action: "review",
      reason: `无法读取 ${unreadable.length} 个数据文件，请检查文件权限后再试。`,
    };
  }

  const present = datasets
    .map((dataset, index) => ({ dataset, index }))
    .filter(({ dataset }) => dataset.state !== "absent");

  if (present.length === 0) return { action: "initialize", reason: "未发现旧数据，直接初始化本地工作区。" };

  const withContent = datasets
    .map((dataset, index) => ({
      dataset,
      index,
      owners: dataset.owners.filter((owner) => owner.hasBusinessData),
    }))
    .filter((entry) => entry.owners.length > 0);

  if (withContent.length === 0) {
    const preferred = present.find(({ dataset }) => dataset.owners.length > 0) ?? present[0];
    const owner = preferred.dataset.owners[0];
    if (!owner) {
      return { action: "initialize", reason: "旧数据中没有业务内容，直接初始化本地工作区。" };
    }
    return {
      action: "migrate",
      datasetIndex: preferred.index,
      ownerId: owner.id,
      reason: "旧数据仅包含占位账户且没有业务内容，直接沿用该数据集。",
    };
  }

  // Several accounts with real content, whether they share a file or not, must
  // never be merged silently.
  const candidates = withContent.flatMap((entry) =>
    entry.owners.map((owner) => ({ datasetIndex: entry.index, ownerId: owner.id })),
  );
  if (candidates.length > 1) {
    return {
      action: "choose",
      candidates,
      reason: "存在多个含业务内容的旧账户，需要用户明确选择要保留哪一个。",
    };
  }

  const only = withContent[0];
  return {
    action: "migrate",
    datasetIndex: only.index,
    ownerId: only.owners[0].id,
    reason: "仅有一个账户包含业务内容，按该账户迁移。",
  };
}

export function buildWorkspaceInventory(input: {
  datasets: Array<{ databaseFile: string; mediaDirectory?: string | null }>;
  now?: () => Date;
}): LocalWorkspaceInventory {
  const datasets = input.datasets.map((dataset) => inspectLegacyDataset(dataset));
  return {
    version: LEGACY_INVENTORY_VERSION,
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    datasets,
    decision: decideWorkspaceAdoption(datasets),
  };
}
