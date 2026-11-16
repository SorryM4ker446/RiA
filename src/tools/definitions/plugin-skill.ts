import { z } from "zod";
import { ApiError } from "@/lib/server/api-error";
import { activeSkillPackages } from "@/lib/plugins/store";
import type { AnyToolDescriptor } from "../types";

import { t } from "@/lib/locale";
export const readPluginSkill: AnyToolDescriptor = {
  id: "readPluginSkill", displayName: "读取插件技能", description: "用到时才加载已启用技能的说明。",
  modelDescription: "Load an enabled plugin skill listed in the skill index. Omit path to get the package's skill instructions and, for marketplace skills, its bundled files; then read SKILL.md and relevant references by path. A file response contains at most 12000 characters; continue at nextOffset until null. This tool cannot access local files, network or execute scripts. Do not use for user documents or inactive/uninstalled skills.",
  modeSupport: ["chat"],
  surface: { category: "context", user: null, template: "always" },
  inputSchema: z.strictObject({ packageId: z.string().max(100), path: z.string().max(300).optional(), offset: z.number().int().min(0).max(500_000).default(0) }),
  execute: async ({ input, signal }) => {
    signal?.throwIfAborted();
    const active = (await activeSkillPackages()).find(item => item.row.packageId === input.packageId);
    if (!active) throw new ApiError({ code: "NOT_FOUND", message: t("server.skills.notReady") });
    const { row, manifest } = active;
    const snapshot = manifest.marketplace;
    signal?.throwIfAborted();
    if (!input.path) return {
      packageId: row.packageId,
      skills: manifest.skills.map(skill => ({ name: skill.name, whenToUse: skill.description, instructions: skill.instructions })),
      ...(snapshot ? { hash: snapshot.hash, files: snapshot.files.map(file => ({ path: file.path, characters: file.contents.length })) } : {}),
      scriptsExecutable: false,
    };
    if (!snapshot) throw new ApiError({ code: "NOT_FOUND", message: t("server.skills.noReferenceFiles") });
    const file = snapshot.files.find(item => item.path === input.path);
    if (!file) throw new ApiError({ code: "NOT_FOUND", message: t("server.skills.fileMissing") });
    const end = Math.min(file.contents.length, input.offset + 12_000);
    return { packageId: row.packageId, hash: snapshot.hash, path: file.path, contents: file.contents.slice(input.offset, end), nextOffset: end < file.contents.length ? end : null, scriptsExecutable: false };
  },
};
