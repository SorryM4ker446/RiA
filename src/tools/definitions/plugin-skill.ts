import { z } from "zod";
import { ApiError } from "@/lib/server/api-error";
import { activeSkillPackages } from "@/lib/plugins/store";
import type { AnyToolDescriptor } from "../types";

export const readPluginSkill: AnyToolDescriptor = {
  id: "readPluginSkill", displayName: "读取插件技能", description: "按需读取已启用 Skill 的指令与配套参考文件。",
  modelDescription: "Load an enabled plugin skill listed in the skill index. Omit path to get the package's skill instructions and, for marketplace skills, its bundled files; then read SKILL.md and relevant references by path. A file response contains at most 12000 characters; continue at nextOffset until null. This tool cannot access local files, network or execute scripts. Do not use for user documents or inactive/uninstalled skills.",
  modeSupport: ["chat"],
  manual: { enabled: false, label: "读取插件技能", placeholder: "", submitLabel: "", primaryFieldKey: "packageId", primaryFieldLabel: "技能", fields: [] },
  inputSchema: z.strictObject({ packageId: z.string().max(100), path: z.string().max(300).optional(), offset: z.number().int().min(0).max(500_000).default(0) }),
  execute: async ({ input, signal }) => {
    signal?.throwIfAborted();
    const active = (await activeSkillPackages()).find(item => item.row.packageId === input.packageId);
    if (!active) throw new ApiError({ code: "NOT_FOUND", message: "技能已停用、卸载或连接未就绪，请重新选择已启用技能。" });
    const { row, manifest } = active;
    const snapshot = manifest.marketplace;
    signal?.throwIfAborted();
    if (!input.path) return {
      packageId: row.packageId,
      skills: manifest.skills.map(skill => ({ name: skill.name, whenToUse: skill.description, instructions: skill.instructions })),
      ...(snapshot ? { hash: snapshot.hash, files: snapshot.files.map(file => ({ path: file.path, characters: file.contents.length })) } : {}),
      scriptsExecutable: false,
    };
    if (!snapshot) throw new ApiError({ code: "NOT_FOUND", message: "此插件没有 Skill 参考文件。" });
    const file = snapshot.files.find(item => item.path === input.path);
    if (!file) throw new ApiError({ code: "NOT_FOUND", message: "技能中没有此文件，请先查看文件目录。" });
    const end = Math.min(file.contents.length, input.offset + 12_000);
    return { packageId: row.packageId, hash: snapshot.hash, path: file.path, contents: file.contents.slice(input.offset, end), nextOffset: end < file.contents.length ? end : null, scriptsExecutable: false };
  },
  buildAssistantText: ({ output }) => JSON.stringify(output),
  memory: { enabled: false, minQuality: 1, summarize: () => null },
};
