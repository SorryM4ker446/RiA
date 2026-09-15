import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DesktopLogger } from "./logger";
import type { DesktopPaths } from "./paths";
import { planWorkspaceUpgrade, prepareWorkspaceUpgrade, type WorkspaceUpgradePlan } from "./workspace-upgrade-core";

/**
 * Prepares the desktop database for the workspace upgrade: inventory, snapshot
 * and the adopted account. The packaged application cannot print a prompt, so a
 * database that holds content in more than one account stops here with an
 * actionable message instead of merging anything silently.
 */
export function runWorkspaceUpgrade(input: {
  desktopPaths: DesktopPaths;
  logger: DesktopLogger;
  environment?: NodeJS.ProcessEnv;
}): WorkspaceUpgradePlan {
  const environment = input.environment ?? process.env;
  const mediaDirectory = existsSync(input.desktopPaths.mediaDirectory) ? input.desktopPaths.mediaDirectory : null;
  const plan = planWorkspaceUpgrade({
    runtime: "desktop",
    checkoutRoot: input.desktopPaths.projectRoot,
    databaseFile: input.desktopPaths.databaseFile,
    mediaDirectory,
    backupsDirectory: input.desktopPaths.backupsDirectory,
    environment,
  });

  if (!plan.needsConversion) return plan;

  if (plan.state === "needs-owner-choice") {
    input.logger.error("Workspace upgrade needs an account choice", { message: plan.message });
    throw new Error(
      `本地数据需要先选择要保留的旧账户，桌面应用不会自动合并。${plan.message} 选择文件：${join(
        plan.backupsDirectory,
        "workspace-adoption.json",
      )}`,
    );
  }

  const prepared = prepareWorkspaceUpgrade(plan);
  input.logger.info("Prepared workspace upgrade", {
    adoptedOwner: prepared.adoptionOwner?.id ?? null,
    snapshot: prepared.snapshot?.directory ?? null,
  });
  return prepared;
}
