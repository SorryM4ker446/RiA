import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { resolveGrant } from "@/lib/local-files/safe-path";
import { terminalRuntimeAllowed } from "./schema";
import { stopTerminalCommandsForGrant } from "./runtime";

export async function setTerminalPermission(id: string, enabled: boolean, revision: string) {
  if (!terminalRuntimeAllowed()) throw new ApiError({ code: "FORBIDDEN", message: "终端权限仅可在 Windows 桌面应用中开启。" });
  const grant = await db.directoryGrant.findUnique({ where: { id } });
  if (!grant || grant.revokedAt) throw new ApiError({ code: "NOT_FOUND", message: "此目录授权已撤销。" });
  if (enabled) {
    const resolved = await resolveGrant({ label: grant.label, path: grant.path });
    if (resolved.isFile || resolved.realPath !== grant.realPath) throw new ApiError({ code: "FORBIDDEN", message: "请选择一个有效目录并重新授权。" });
  }
  const result = await db.directoryGrant.updateMany({
    where: { id, revokedAt: null, updatedAt: new Date(revision) },
    data: { terminalEnabled: enabled, updatedAt: new Date(Math.max(Date.now(), grant.updatedAt.getTime() + 1)) },
  });
  if (!result.count) throw new ApiError({ code: "CONFLICT", message: "目录权限已变化，请刷新后重试。" });
  // Every permission change invalidates pending approvals and active commands.
  stopTerminalCommandsForGrant(id);
}
