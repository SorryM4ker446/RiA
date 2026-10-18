import { z } from "zod";
import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { pluginManifestSchema } from "@/lib/plugins/schema";
import type { AnyToolDescriptor } from "../types";

export const readPluginSkill: AnyToolDescriptor = {
  id: "readPluginSkill", displayName: "读取插件技能", description: "按需读取已启用 Skill 的指令与配套参考文件。",
  modelDescription: "Read an enabled plugin skill's bundled guidance. Use packageId from the enabled skill index. Omit path to list bundled files; read SKILL.md first, then relevant references. A response contains at most 12000 characters; continue at nextOffset until null. This tool cannot access local files, network or execute scripts. Do not use for user documents or inactive/uninstalled skills.",
  modeSupport: ["chat"],
  manual: { enabled: false, label: "读取插件技能", placeholder: "", submitLabel: "", primaryFieldKey: "packageId", primaryFieldLabel: "技能", fields: [] },
  inputSchema: z.strictObject({ packageId: z.string().max(100), path: z.string().max(300).optional(), offset: z.number().int().min(0).max(500_000).default(0) }),
  execute: async ({ input, signal }) => {
    signal?.throwIfAborted();
    const row = await db.pluginPackage.findUnique({ where: { packageId: input.packageId } });
    if (!row?.enabled) throw new ApiError({ code: "NOT_FOUND", message: "技能已停用或卸载，请重新选择已启用技能。" });
    const snapshot = pluginManifestSchema.parse(row.manifest).marketplace;
    if (!snapshot) throw new ApiError({ code: "NOT_FOUND", message: "此插件没有 Skill 参考文件。" });
    signal?.throwIfAborted();
    if (!input.path) return { packageId: row.packageId, hash: snapshot.hash, files: snapshot.files.map(file => ({ path: file.path, characters: file.contents.length })), scriptsExecutable: false };
    const file = snapshot.files.find(item => item.path === input.path);
    if (!file) throw new ApiError({ code: "NOT_FOUND", message: "技能中没有此文件，请先查看文件目录。" });
    const end = Math.min(file.contents.length, input.offset + 12_000);
    return { packageId: row.packageId, hash: snapshot.hash, path: file.path, contents: file.contents.slice(input.offset, end), nextOffset: end < file.contents.length ? end : null, scriptsExecutable: false };
  },
  buildAssistantText: ({ output }) => JSON.stringify(output),
  memory: { enabled: false, minQuality: 1, summarize: () => null },
};
