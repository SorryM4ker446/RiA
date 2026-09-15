import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listKnownLocalDatabases, type AppRuntime } from "./data-paths";
import {
  buildWorkspaceInventory,
  decideWorkspaceAdoption,
  inspectLegacyDataset,
  LEGACY_INVENTORY_VERSION,
  type LegacyOwnerProfile,
  type LocalWorkspaceInventory,
} from "./legacy-inventory";
import {
  createWorkspaceSnapshot,
  listWorkspaceSnapshots,
  restoreWorkspaceSnapshot,
  verifyWorkspaceSnapshot,
  type WorkspaceSnapshot,
} from "./workspace-snapshot";

/**
 * Local workspace upgrade decisions.
 *
 * Before the workspace stops being account-scoped, the previous state is
 * inventoried and snapshotted, one account is adopted, and the adopted account
 * is recorded where the migration can read it. Nothing here deletes data: an
 * account that is not adopted stays in the snapshot.
 */

export const WORKSPACE_ADOPTION_TABLE = "local_workspace_adoption";
export const WORKSPACE_SELECTION_FILE = "workspace-adoption.json";
export const WORKSPACE_SELECTION_ENV = "LOCAL_WORKSPACE_OWNER";

// Keep this in sync with src/lib/local/workspace.ts. Electron code is compiled
// separately and cannot import the Next.js alias-bound module.
const LOCAL_WORKSPACE_ID = "cmt4aw3vg0000v1j0gkv9bhei";
const MEDIA_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

export type WorkspaceUpgradeState = "ready" | "needs-owner-choice";

export type WorkspaceUpgradePlan = {
  state: WorkspaceUpgradeState;
  runtime: AppRuntime;
  databaseFile: string;
  mediaDirectory: string | null;
  backupsDirectory: string;
  inventory: LocalWorkspaceInventory;
  /** True when the database still carries accounts and needs the migration. */
  needsConversion: boolean;
  adoptionOwner: LegacyOwnerProfile | null;
  snapshot: WorkspaceSnapshot | null;
  selectionFile: string;
  message: string;
};

function candidateDatasets(
  runtime: AppRuntime,
  checkoutRoot: string,
  databaseFile: string,
  mediaDirectory: string | null,
  includeOtherWorkspaces: boolean,
) {
  // Only the active workspace is upgraded. Other installations on the machine
  // are reported for the operator, never migrated behind the user's back, and
  // tests keep them out of the plan so results do not depend on the machine.
  void runtime;
  const datasets = [{ databaseFile, mediaDirectory }];
  if (!includeOtherWorkspaces) return datasets;
  for (const candidate of new Set(listKnownLocalDatabases(checkoutRoot))) {
    if (candidate !== databaseFile && existsSync(candidate)) {
      datasets.push({ databaseFile: candidate, mediaDirectory: null });
    }
  }
  return datasets;
}

/**
 * Other installations found on the machine. Read-only context for the operator;
 * the upgrade itself only ever touches the active database.
 */
export function describeOtherWorkspaces(input: {
  checkoutRoot: string;
  databaseFile: string;
}): ReturnType<typeof inspectLegacyDataset>[] {
  return listKnownLocalDatabases(input.checkoutRoot)
    .filter((candidate) => candidate !== input.databaseFile && existsSync(candidate))
    .map((candidate) => inspectLegacyDataset({ databaseFile: candidate, mediaDirectory: null }));
}

function isConverted(inventory: ReturnType<typeof inspectLegacyDataset>): boolean {
  return !inventory.tables.includes("users");
}

function sanitizeOwnerId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 100) return null;
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Plans the upgrade for one runtime. The plan is a pure decision plus (when a
 * conversion is pending) a verified snapshot, so an operator can inspect it
 * before the migration runs.
 */
export function planWorkspaceUpgrade(input: {
  runtime: AppRuntime;
  checkoutRoot: string;
  databaseFile: string;
  mediaDirectory: string | null;
  backupsDirectory: string;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
  /** Include databases of other installations as read-only context. */
  includeOtherWorkspaces?: boolean;
}): WorkspaceUpgradePlan {
  const environment = input.environment ?? process.env;
  // The selection file lives here, so the directory exists before any write.
  mkdirSync(input.backupsDirectory, { recursive: true });
  const databases = candidateDatasets(
    input.runtime,
    input.checkoutRoot,
    input.databaseFile,
    input.mediaDirectory,
    input.includeOtherWorkspaces ?? true,
  );
  const inventory = buildWorkspaceInventory({
    datasets: databases,
    ...(input.now ? { now: () => input.now as Date } : {}),
  });
  const active = inventory.datasets[0];
  const selectionFile = join(input.backupsDirectory, WORKSPACE_SELECTION_FILE);
  const base = {
    runtime: input.runtime,
    databaseFile: input.databaseFile,
    mediaDirectory: input.mediaDirectory,
    backupsDirectory: input.backupsDirectory,
    inventory,
    selectionFile,
  };

  if (isConverted(active)) {
    return {
      ...base,
      state: "ready",
      needsConversion: false,
      adoptionOwner: null,
      snapshot: null,
      message: "数据库已经是单用户工作区，无需转换。",
    };
  }

  // A recorded choice (file first, then environment) wins over the automatic
  // decision, so an operator can steer a database that holds several accounts.
  const rawRequested = readRecordedOwner(selectionFile) ?? environment[WORKSPACE_SELECTION_ENV];
  const requestedOwner = sanitizeOwnerId(rawRequested);
  if (rawRequested && !requestedOwner) {
    return {
      ...base,
      state: "needs-owner-choice",
      needsConversion: true,
      adoptionOwner: null,
      snapshot: null,
      message: `旧账户 ID 含不支持的字符，已拒绝：请使用只包含字母、数字、下划线和短横线的 ID。`,
    };
  }
  const ownerById = active.owners.find((owner) => owner.id === requestedOwner);
  if (requestedOwner && !ownerById) {
    return {
      ...base,
      state: "needs-owner-choice",
      needsConversion: true,
      adoptionOwner: null,
      snapshot: null,
      message: `已配置的旧账户 ${requestedOwner} 不在当前数据文件中，请重新选择一个可用账户。`,
    };
  }

  if (ownerById) {
    return {
      ...base,
      state: "ready",
      needsConversion: true,
      adoptionOwner: ownerById,
      snapshot: null,
      message: `将沿用已选择的旧账户 ${ownerById.id}。`,
    };
  }

  // Other database files are context for the operator only. The active file
  // must be planned independently, otherwise an unrelated installation can
  // block or redirect this workspace's upgrade.
  const decision = decideWorkspaceAdoption([active]);
  if (decision.action === "choose") {
    return {
      ...base,
      state: "needs-owner-choice",
      needsConversion: true,
      adoptionOwner: null,
      snapshot: null,
      message: `旧数据中有多个账户存在内容，需要先选择一个：${decision.candidates
        .map((candidate) => candidate.ownerId)
        .join("、")}。可在 ${selectionFile} 写入 {"ownerId":"..."} 或设置 ${WORKSPACE_SELECTION_ENV}。`,
    };
  }

  if (decision.action === "review") {
    return {
      ...base,
      state: "needs-owner-choice",
      needsConversion: true,
      adoptionOwner: null,
      snapshot: null,
      message: decision.reason,
    };
  }

  const adoptionOwner = active.owners.find((owner) => owner.id === (decision.action === "migrate" ? decision.ownerId : "")) ?? null;
  return {
    ...base,
    state: "ready",
    needsConversion: true,
    adoptionOwner,
    snapshot: null,
    message: decision.reason,
  };
}

function readRecordedOwner(selectionFile: string): string | null {
  if (!existsSync(selectionFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(selectionFile, "utf8")) as { ownerId?: unknown };
    return typeof parsed.ownerId === "string" ? parsed.ownerId : null;
  } catch {
    return null;
  }
}

export function writeRecordedOwner(selectionFile: string, ownerId: string) {
  mkdirSync(dirname(selectionFile), { recursive: true });
  writeFileSync(selectionFile, `${JSON.stringify({ version: LEGACY_INVENTORY_VERSION, ownerId }, null, 2)}\n`, "utf8");
}

/**
 * Takes the pre-upgrade snapshot, records the adopted account in the backups
 * directory, and writes the same choice into the database so the migration can
 * read it. Safe to call more than once.
 */
export function prepareWorkspaceUpgrade(plan: WorkspaceUpgradePlan): WorkspaceUpgradePlan {
  if (!plan.needsConversion || plan.state !== "ready") return plan;

  const owner = plan.adoptionOwner;
  if (!owner) {
    // No accounts at all: the migration finds nothing to adopt and keeps every
    // row, so no snapshot is required.
    return plan;
  }

  const active = plan.inventory.datasets[0];
  const digest = digestOf(plan.databaseFile);

  // The snapshot is an exact copy of the whole database file, so a repeat run
  // adopts the same account without recording an identical second snapshot.
  const existing = listWorkspaceSnapshots(plan.backupsDirectory)
    .map((directory) => ({ directory, verification: verifyWorkspaceSnapshot(directory) }))
    .find(
      ({ verification }) =>
        verification.ok &&
        verification.manifest.sourceDatabaseFile === plan.databaseFile &&
        (verification.manifest.databaseSha256 === digest || verification.manifest.adoptedOwner?.id === owner.id),
    );

  if (existing) {
    migrateLegacyWorkspaceFiles({
      databaseFile: plan.databaseFile,
      mediaDirectory: plan.mediaDirectory,
      backupsDirectory: plan.backupsDirectory,
      ownerId: owner.id,
    });
    recordAdoptionInDatabase(plan.databaseFile, owner.id);
    writeRecordedOwner(plan.selectionFile, owner.id);
    return { ...plan, message: `${plan.message} 复用已有快照 ${existing.directory}。` };
  }

  const snapshot = createWorkspaceSnapshot({
    databaseFile: plan.databaseFile,
    mediaDirectory: plan.mediaDirectory,
    backupsDirectory: plan.backupsDirectory,
    inventory: active,
    adoptedOwner: owner,
    decisionReason: plan.message,
    suffix: "pre-upgrade",
  });
  const verification = verifyWorkspaceSnapshot(snapshot.directory);
  if (!verification.ok) {
    throw new Error(`升级前快照校验失败：${verification.problems.join(" ")}`);
  }
  migrateLegacyWorkspaceFiles({
    databaseFile: plan.databaseFile,
    mediaDirectory: plan.mediaDirectory,
    backupsDirectory: plan.backupsDirectory,
    ownerId: owner.id,
  });
  recordAdoptionInDatabase(plan.databaseFile, owner.id);
  writeRecordedOwner(plan.selectionFile, owner.id);
  return { ...plan, snapshot, message: `${plan.message} 已创建升级前快照 ${snapshot.directory}。` };
}

function hashedWorkspaceDirectory(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

function assertDirectory(path: string, label: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} 不安全：${path}`);
}

function copyLegacyBackupFiles(source: string, target: string) {
  if (!existsSync(source)) return;
  assertDirectory(source, "旧备份目录");
  mkdirSync(target, { recursive: true });
  assertDirectory(target, "新备份目录");
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    const sourceFile = join(source, entry.name);
    const targetFile = join(target, entry.name);
    if (existsSync(targetFile)) {
      if (!lstatSync(targetFile).isFile() || lstatSync(targetFile).isSymbolicLink()) {
        throw new Error(`新备份文件不安全：${targetFile}`);
      }
      continue;
    }
    copyFileSync(sourceFile, targetFile);
  }
}

/**
 * The old account-scoped storage used sha256(ownerId) in both the database
 * path and the backup directory. Move the adopted account's references to the
 * stable workspace hash before the SQL migration removes the owner column.
 * Files are copied, not moved, so the verified snapshot remains a complete
 * recovery point if a later migration fails.
 */
function migrateLegacyWorkspaceFiles(input: {
  databaseFile: string;
  mediaDirectory: string | null;
  backupsDirectory: string;
  ownerId: string;
}) {
  const oldDirectoryName = hashedWorkspaceDirectory(input.ownerId);
  const newDirectoryName = hashedWorkspaceDirectory(LOCAL_WORKSPACE_ID);

  if (input.mediaDirectory && existsSync(input.mediaDirectory)) {
    assertDirectory(input.mediaDirectory, "媒体根目录");
    const oldMediaDirectory = join(input.mediaDirectory, oldDirectoryName);
    const newMediaDirectory = join(input.mediaDirectory, newDirectoryName);
    const database = new DatabaseSync(input.databaseFile);
    try {
      const table = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'media_assets'")
        .get() as { name?: string } | undefined;
      if (table?.name === "media_assets") {
        const assets = database
          .prepare('SELECT "id", "mediaType", "relativePath" FROM "media_assets" WHERE "userId" = ?')
          .all(input.ownerId) as Array<{ id?: string; mediaType?: string; relativePath?: string }>;
        const updates: Array<{ id: string; relativePath: string }> = [];
        for (const asset of assets) {
          const extension = asset.mediaType ? MEDIA_EXTENSIONS[asset.mediaType] : undefined;
          const id = String(asset.id ?? "");
          const oldRelativePath = String(asset.relativePath ?? "");
          if (!extension || !id || oldRelativePath !== `${oldDirectoryName}/${id}.${extension}`) continue;
          const filename = `${id}.${extension}`;
          const sourceFile = join(oldMediaDirectory, filename);
          const targetFile = join(newMediaDirectory, filename);
          if (existsSync(sourceFile)) {
            if (!lstatSync(sourceFile).isFile() || lstatSync(sourceFile).isSymbolicLink()) {
              throw new Error(`旧媒体文件不安全：${sourceFile}`);
            }
            mkdirSync(newMediaDirectory, { recursive: true });
            if (existsSync(targetFile)) {
              const targetStat = lstatSync(targetFile);
              if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error(`新媒体文件不安全：${targetFile}`);
            } else {
              copyFileSync(sourceFile, targetFile);
            }
          }
          updates.push({ id, relativePath: `${newDirectoryName}/${filename}` });
        }
        if (updates.length > 0) {
          database.exec("BEGIN IMMEDIATE;");
          try {
            const update = database.prepare('UPDATE "media_assets" SET "relativePath" = ? WHERE "id" = ? AND "userId" = ?');
            for (const updateRow of updates) update.run(updateRow.relativePath, updateRow.id, input.ownerId);
            database.exec("COMMIT;");
          } catch (error) {
            database.exec("ROLLBACK;");
            throw error;
          }
        }
      }
    } finally {
      database.close();
    }
  }

  copyLegacyBackupFiles(
    join(input.backupsDirectory, oldDirectoryName),
    join(input.backupsDirectory, newDirectoryName),
  );
}

/**
 * The migration reads the adopted account from this table. Writing it here, not
 * in SQL, keeps the choice explicit and auditable.
 */
export function recordAdoptionInDatabase(databaseFile: string, ownerId: string) {
  const database = new DatabaseSync(databaseFile);
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS "${WORKSPACE_ADOPTION_TABLE}" (
      "ownerId" TEXT NOT NULL PRIMARY KEY,
      "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`);
    database.prepare(`DELETE FROM "${WORKSPACE_ADOPTION_TABLE}"`).run();
    database.prepare(`INSERT INTO "${WORKSPACE_ADOPTION_TABLE}" ("ownerId") VALUES (?)`).run(ownerId);
  } finally {
    database.close();
  }
}

/** Removes the temporary adoption table left for the migration to consume. */
export function clearRecordedAdoption(databaseFile: string) {
  if (!existsSync(databaseFile)) return;
  const database = new DatabaseSync(databaseFile);
  try {
    database.exec(`DROP TABLE IF EXISTS "${WORKSPACE_ADOPTION_TABLE}";`);
  } finally {
    database.close();
  }
}

function digestOf(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Reverts the live database to the newest verified pre-upgrade snapshot. */
export function restoreLatestWorkspaceSnapshot(input: {
  databaseFile: string;
  backupsDirectory: string;
}): { restoredFrom: string; replacedBackupFile: string | null } {
  const snapshots = listWorkspaceSnapshots(input.backupsDirectory);
  const usable = snapshots.filter((directory) => verifyWorkspaceSnapshot(directory).ok);
  if (usable.length === 0) throw new Error("没有可用的升级前快照。");
  for (const directory of [...usable].reverse()) {
    const manifest = verifyWorkspaceSnapshot(directory).manifest;
    if (manifest.sourceDatabaseFile === input.databaseFile) {
      return restoreWorkspaceSnapshot({ snapshotDirectory: directory, targetDatabaseFile: input.databaseFile });
    }
  }
  throw new Error("没有找到与该数据库匹配的升级前快照。");
}
