import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checkoutRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

const { resolveLocalDataPaths, resolveAppRuntime } = await import("../electron/data-paths.ts");
const { buildWorkspaceInventory } = await import("../electron/legacy-inventory.ts");

const KNOWN_FLAGS = new Set(["--json", "--help", "-h"]);

function fail(message) {
  console.error(`本地数据盘点失败：${message}`);
  process.exit(1);
}

function parseArguments(argv) {
  const databases = [];
  const mediaDirectories = [];
  let json = false;
  let pending = null;

  for (const token of argv) {
    if (pending) {
      if (token.startsWith("--")) fail(`参数 ${pending} 缺少取值`);
      if (pending === "--database") databases.push(token);
      else mediaDirectories.push(token);
      pending = null;
      continue;
    }
    if (token === "--database" || token === "--media") {
      pending = token;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      printUsage();
      process.exit(0);
    }
    if (token.startsWith("--")) fail(`未知参数 ${token}`);
    if (KNOWN_FLAGS.has(token)) continue;
    // A bare path is treated as another database.
    databases.push(token);
  }
  if (pending) fail(`参数 ${pending} 缺少取值`);
  if (databases.length !== mediaDirectories.length) {
    fail("每个 --database 都需要一个对应的 --media 目录，请成对提供");
  }
  return { databases, mediaDirectories, json };
}

function printUsage() {
  const paths = resolveLocalDataPaths(resolveAppRuntime(), checkoutRoot);
  console.log(`用法：node scripts/inventory-local-data.mjs [--json] [--database <文件> --media <目录>]...

不带参数时盘点本机已知的本地数据位置（只读，不修改任何文件）：
  运行时      ${paths.runtime}
  数据库      ${paths.databaseFile}
  媒体目录    ${paths.mediaDirectory}

显式给出 --database/--media 时只盘点这些位置，按顺序成对出现。`);
}

function toAbsolute(value) {
  return isAbsolute(value) ? value : resolve(checkoutRoot, value);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const STATE_LABELS = {
  absent: "不存在",
  unreadable: "无法读取",
  empty: "空数据库",
  single: "单个旧账户",
  multiple: "多个旧账户",
};

const DECISION_LABELS = {
  initialize: "直接初始化",
  migrate: "可直接迁移",
  choose: "需要用户选择",
  review: "需要人工检查",
};

function printReport(report) {
  console.log(`本地数据盘点（只读，未修改任何文件）  生成时间 ${report.generatedAt}`);
  report.datasets.forEach((dataset, index) => {
    console.log(`\n[${index}] ${dataset.databaseFile}`);
    console.log(`    状态：${STATE_LABELS[dataset.state] ?? dataset.state}  大小：${formatBytes(dataset.byteSize)}`);
    if (dataset.unreadableReason) console.log(`    原因：${dataset.unreadableReason}`);
    if (dataset.state === "absent") return;
    for (const owner of dataset.owners) {
      const counts = owner.counts;
      const summary = [
        `会话 ${counts.chats}`,
        `消息 ${counts.messages}`,
        `记忆 ${counts.memories}`,
        `任务 ${counts.tasks}`,
        `媒体 ${counts.mediaAssets}`,
        `文档 ${counts.knowledgeDocuments}`,
        `用量 ${counts.modelRequests}`,
        `偏好 ${counts.preferences}`,
      ].join("  ");
      const marker = owner.hasBusinessData ? "有内容" : "无内容（占位账户）";
      console.log(`    - ${owner.id} <${owner.email ?? "无邮箱"}> 创建于 ${owner.createdAt ?? "未知"}  ${marker}`);
      console.log(`      ${summary}`);
    }
    if (dataset.owners.length === 0 && dataset.state !== "empty") console.log("    - 没有账户记录");
    if (dataset.media.directory) {
      const media = dataset.media;
      console.log(
        `    媒体目录：${media.available ? `${media.fileCount} 个文件，共 ${formatBytes(media.totalBytes)}${media.truncated ? "（已截断统计）" : ""}` : "不可用"}${
          media.skippedLinks ? `，跳过 ${media.skippedLinks} 个链接` : ""
        }`,
      );
      console.log(`      ${media.directory}`);
    }
  });

  const decision = report.decision;
  console.log(`\n结论：${DECISION_LABELS[decision.action] ?? decision.action}`);
  console.log(`  ${decision.reason}`);
  if (decision.action === "migrate") {
    console.log(`  将保留：数据集 [${decision.datasetIndex}] 的账户 ${decision.ownerId}`);
  }
  if (decision.action === "choose") {
    for (const candidate of decision.candidates) {
      console.log(`  候选：数据集 [${candidate.datasetIndex}] 的账户 ${candidate.ownerId}`);
    }
  }
}

const options = parseArguments(process.argv.slice(2));

const ALL_RUNTIMES = ["web", "desktop", "test"];

/**
 * Known locations are keyed by database file, and each one keeps the media
 * directory that belongs to its own runtime instead of the active runtime.
 */
function describeKnownWorkspaces() {
  const byDatabase = new Map();
  for (const runtime of ALL_RUNTIMES) {
    const paths = resolveLocalDataPaths(runtime, checkoutRoot);
    byDatabase.set(paths.databaseFile, {
      databaseFile: paths.databaseFile,
      mediaDirectory: existsSync(paths.mediaDirectory) ? paths.mediaDirectory : null,
    });
  }
  const active = resolveAppRuntime();
  const ordered = [resolveLocalDataPaths(active, checkoutRoot).databaseFile, ...byDatabase.keys()];
  const seen = new Set();
  return ordered
    .filter((databaseFile) => {
      if (seen.has(databaseFile)) return false;
      seen.add(databaseFile);
      return true;
    })
    .map((databaseFile) => byDatabase.get(databaseFile));
}

let datasets;
if (options.databases.length > 0) {
  datasets = options.databases.map((databaseFile, index) => ({
    databaseFile: toAbsolute(databaseFile),
    mediaDirectory: toAbsolute(options.mediaDirectories[index]),
  }));
} else {
  datasets = describeKnownWorkspaces();
}

const report = buildWorkspaceInventory({ datasets });

if (options.json) console.log(JSON.stringify(report, null, 2));
else printReport(report);
