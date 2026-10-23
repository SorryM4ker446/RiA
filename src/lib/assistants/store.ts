import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { modelInLibrary } from "@/lib/models/preferences";
import { resolveToolDescriptor } from "@/tools/catalog";
import { assistantConfigSchema, isDefaultAssistantId, type AssistantConfig, type AssistantTemplate, type AssistantSnapshot } from "./schema";
import { DEFAULT_ASSISTANTS } from "./defaults";
import type { Prisma } from "@prisma/client";

const CUSTOM_TEMPLATE_LIMIT = 50;
const defaultOrder = DEFAULT_ASSISTANTS.map(template => template.id);

/** The defaults first, in their usual order, then the user's own templates, newest first. */
export async function listAssistants(): Promise<AssistantTemplate[]> {
  const rows = await db.assistantTemplate.findMany({ orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: CUSTOM_TEMPLATE_LIMIT + defaultOrder.length });
  const templates = rows.map(row => ({ id: row.id, revision: row.revision, builtin: isDefaultAssistantId(row.id), config: assistantConfigSchema.parse(row.config) }));
  const rank = (template: AssistantTemplate) => template.builtin ? defaultOrder.indexOf(template.id) : defaultOrder.length;
  return templates.map((template, index) => ({ template, index })).sort((a, b) => rank(a.template) - rank(b.template) || a.index - b.index).map(entry => entry.template);
}
export async function resolveAssistant(id: string, tx: Prisma.TransactionClient = db): Promise<AssistantSnapshot> {
  const row = await tx.assistantTemplate.findUnique({ where: { id } });
  if (!row) throw new ApiError({ code: "NOT_FOUND", message: "助理模板不存在或已删除。" });
  const config = assistantConfigSchema.parse(row.config);
  if (tx === db && config.model && !await modelInLibrary("chat", config.model)) throw new ApiError({ code: "CONFIGURATION_ERROR", message: "模板绑定的模型已移除，请修改模板后使用。" });
  return { ...config, templateId: row.id, templateRevision: row.revision };
}
export async function saveAssistant(input: AssistantConfig, id?: string, revision?: number) {
  const config = assistantConfigSchema.parse(input);
  if ((await Promise.all(config.tools.map(resolveToolDescriptor))).some(tool => !tool)) throw new ApiError({ code: "VALIDATION_ERROR", message: "模板包含不支持的工具。" });
  if (config.model && !await modelInLibrary("chat", config.model)) throw new ApiError({ code: "VALIDATION_ERROR", message: "只能绑定已添加的聊天模型。" });
  return db.$transaction(async tx => {
    if (id) {
      const row = await tx.assistantTemplate.findUnique({ where: { id } });
      if (!row) throw new ApiError({ code: "NOT_FOUND", message: "助理模板不存在或已删除。" });
      const changed = await tx.assistantTemplate.updateMany({ where: { id, revision }, data: { config, revision: { increment: 1 } } });
      if (!changed.count) throw new ApiError({ code: "CONFLICT", message: "模板已被其他操作修改，请刷新后重试。" });
      return tx.assistantTemplate.findUniqueOrThrow({ where: { id } });
    }
    // The defaults do not use up room for the user's own templates.
    if (await tx.assistantTemplate.count({ where: { NOT: { id: { startsWith: "builtin_" } } } }) >= CUSTOM_TEMPLATE_LIMIT) throw new ApiError({ code: "CONFLICT", message: "最多保存 50 个自定义助理模板。" });
    return tx.assistantTemplate.create({ data: { config } });
  });
}
/**
 * Puts back the defaults that are missing, as they were first shipped. A
 * default that is still there keeps the user's edits; only deleted ones return.
 */
export async function restoreDefaultAssistants() {
  return db.$transaction(async tx => {
    const present = new Set((await tx.assistantTemplate.findMany({ where: { id: { in: defaultOrder } }, select: { id: true } })).map(row => row.id));
    const missing = DEFAULT_ASSISTANTS.filter(template => !present.has(template.id));
    for (const template of missing) await tx.assistantTemplate.create({ data: { id: template.id, config: template.config, revision: template.revision } });
    return missing.map(template => template.id);
  });
}
