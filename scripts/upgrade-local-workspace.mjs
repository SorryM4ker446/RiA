import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checkoutRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

const { resolveAppRuntime, resolveLocalDataPaths } = await import("../electron/data-paths.ts");
const { planWorkspaceUpgrade, prepareWorkspaceUpgrade, restoreLatestWorkspaceSnapshot, writeRecordedOwner } =
  await import("../electron/workspace-upgrade-core.ts");
const { LEGACY_INVENTORY_VERSION } = await import("../electron/legacy-inventory.ts");

function printUsage() {
  const runtime = resolveAppRuntime();
  const paths = resolveLocalDataPaths(runtime, checkoutRoot);
  console.log(`用法：node --import ./tests/helpers/register-typescript.mjs scripts/upgrade-local-workspace.mjs [选项]

不带选项时只报告升级计划，不修改任何文件。

选项：
  --status              只报告状态（默认行为）
  --prepare             创建升级前快照并记录要沿用的旧账户
  --adopt <ownerId>     指定要沿用的旧账户，然后按 --prepare 执行
  --restore             用最新的升级前快照恢复数据库
  --json                以 JSON 输出

当前运行时：${runtime}
数据库：${paths.databaseFile}
备份目录：${paths.backupsDirectory}`);
}

function parseArguments(argv) {
  const options = { mode: "status", adopt: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--status") options.mode = "status";
    else if (token === "--prepare") options.mode = "prepare";
    else if (token === "--restore") options.mode = "restore";
    else if (token === "--json") options.json = true;
    else if (token === "--adopt") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        console.error("--adopt 需要一个旧账户 ID。");
        process.exit(1);
      }
      options.adopt = next;
      options.mode = "prepare";
      index += 1;
    } else if (token === "--help" || token === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`未知参数：${token}`);
      process.exit(1);
    }
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const runtime = resolveAppRuntime();
const paths = resolveLocalDataPaths(runtime, checkoutRoot);
const mediaDirectory = existsSync(paths.mediaDirectory) ? paths.mediaDirectory : null;

const planInput = {
  runtime,
  checkoutRoot,
  databaseFile: paths.databaseFile,
  mediaDirectory,
  backupsDirectory: paths.backupsDirectory,
};

function summarize(plan) {
  return {
    state: plan.state,
    needsConversion: plan.needsConversion,
    databaseFile: plan.databaseFile,
    backupDirectory: plan.backupsDirectory,
    adoptionOwner: plan.adoptionOwner ? { id: plan.adoptionOwner.id, email: plan.adoptionOwner.email } : null,
    snapshot: plan.snapshot ? plan.snapshot.directory : null,
    message: plan.message,
    datasets: plan.inventory.datasets.map((dataset) => ({
      databaseFile: dataset.databaseFile,
      state: dataset.state,
      owners: dataset.owners.map((owner) => ({ id: owner.id, hasBusinessData: owner.hasBusinessData })),
    })),
  };
}

if (options.mode === "restore") {
  const restored = restoreLatestWorkspaceSnapshot({
    databaseFile: paths.databaseFile,
    backupsDirectory: paths.backupsDirectory,
  });
  if (options.json) console.log(JSON.stringify(restored, null, 2));
  else {
    console.log(`已从快照恢复：${restored.restoredFrom}`);
    if (restored.replacedBackupFile) console.log(`恢复前的数据库已另存为：${restored.replacedBackupFile}`);
  }
  process.exit(0);
}

if (options.adopt) {
  writeRecordedOwner(`${paths.backupsDirectory}/workspace-adoption.json`, options.adopt);
}

const plan = planWorkspaceUpgrade(planInput);

if (options.mode === "status") {
  if (options.json) console.log(JSON.stringify({ ...summarize(plan), inventoryVersion: LEGACY_INVENTORY_VERSION }, null, 2));
  else {
    console.log(`本地工作区升级计划（${runtime}）`);
    console.log(`  数据库：${plan.databaseFile}`);
    console.log(`  状态：${plan.needsConversion ? "需要转换" : "无需转换"}`);
    console.log(`  ${plan.message}`);
    for (const dataset of plan.inventory.datasets) {
      console.log(`  - ${dataset.databaseFile}：${dataset.state}，${dataset.owners.length} 个旧账户`);
      for (const owner of dataset.owners) {
        console.log(`      ${owner.id} <${owner.email ?? "无邮箱"}> ${owner.hasBusinessData ? "有内容" : "无内容"}`);
      }
    }
  }
  process.exit(plan.state === "ready" ? 0 : 2);
}

const prepared = prepareWorkspaceUpgrade(plan);
if (options.json) console.log(JSON.stringify(summarize(prepared), null, 2));
else {
  console.log(prepared.message);
  if (prepared.snapshot) console.log(`升级前快照：${prepared.snapshot.directory}`);
  console.log("下一步：运行迁移以完成转换。");
}
process.exit(prepared.state === "ready" ? 0 : 2);
