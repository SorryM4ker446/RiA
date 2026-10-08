import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { modelInLibrary } from "@/lib/models/preferences";
import { getToolDescriptor } from "@/tools/catalog";
import { assistantConfigSchema, type AssistantConfig, type AssistantTemplate, type AssistantSnapshot } from "./schema";
import type { Prisma } from "@prisma/client";

const builtin = (id: string, name: string, description: string, instructions: string, tools: string[]): AssistantTemplate => ({
  id, revision: 1, builtin: true, config: assistantConfigSchema.parse({ name, description, instructions, tools }),
});
export const builtinAssistants = [
  builtin("builtin_knowledge", "知识问答助理", "结合资料回答，保留条件、例外和引用。", "Use the scoped knowledge evidence to answer. Combine passages where needed. Preserve conditions, exceptions, numbers and units. Cite each supported claim. Explain conflicting documents and explicitly state missing evidence. Do not replace missing workspace facts with general knowledge.", ["searchKnowledge"]),
  builtin("builtin_writing", "写作助理", "润色和组织文字，保留原意与事实。", "Help draft, revise and organize writing. Preserve the user's intended meaning and documented facts. Mark assumptions and ask for missing audience or purpose when necessary. Do not invent quotations or sources.", []),
  builtin("builtin_coding", "代码助理", "解释代码、排查问题、提出可验证的修改。", "Help understand and improve software. Separate observed behavior from hypotheses. Explain the failure mechanism, propose the smallest coherent change and provide relevant validation steps. Never claim code was executed unless a tool actually executed it.", ["searchKnowledge", "listLocalFiles", "readLocalFile"]),
  builtin("builtin_research", "资料研究助理", "比较资料与观点，区分事实和推断。", "Research the user's question using available documents and permitted web search. Compare sources, dates and differing claims. Clearly distinguish documented facts from inference and cite the evidence actually obtained. Disclose missing or unavailable searches.", ["searchKnowledge", "webSearch"]),
];

export async function listAssistants(): Promise<AssistantTemplate[]> {
  const custom = await db.assistantTemplate.findMany({ orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 50 });
  return [...builtinAssistants, ...custom.map(row => ({ id: row.id, revision: row.revision, builtin: false, config: assistantConfigSchema.parse(row.config) }))];
}
export async function resolveAssistant(id: string, tx: Prisma.TransactionClient = db): Promise<AssistantSnapshot> {
  const built = builtinAssistants.find(item => item.id === id);
  const row = built ?? await tx.assistantTemplate.findUnique({ where: { id } });
  if (!row) throw new ApiError({ code: "NOT_FOUND", message: "助理模板不存在或已删除。" });
  const config = assistantConfigSchema.parse(row.config);
  if (tx === db && config.model && !await modelInLibrary("chat", config.model)) throw new ApiError({ code: "CONFIGURATION_ERROR", message: "模板绑定的模型已移除，请修改模板后使用。" });
  return { ...config, templateId: row.id, templateRevision: row.revision };
}
export async function saveAssistant(input: AssistantConfig, id?: string, revision?: number) {
  const config = assistantConfigSchema.parse(input);
  if (config.tools.some(tool => !getToolDescriptor(tool))) throw new ApiError({ code: "VALIDATION_ERROR", message: "模板包含不支持的工具。" });
  if (config.model && !await modelInLibrary("chat", config.model)) throw new ApiError({ code: "VALIDATION_ERROR", message: "只能绑定已添加的聊天模型。" });
  if (id?.startsWith("builtin_")) throw new ApiError({ code: "VALIDATION_ERROR", message: "内置模板只读，请先复制为自定义模板。" });
  return db.$transaction(async tx => {
    if (id) {
      const row = await tx.assistantTemplate.findUnique({ where: { id } });
      if (!row) throw new ApiError({ code: "NOT_FOUND", message: "助理模板不存在或已删除。" });
      const changed = await tx.assistantTemplate.updateMany({ where: { id, revision }, data: { config, revision: { increment: 1 } } });
      if (!changed.count) throw new ApiError({ code: "CONFLICT", message: "模板已被其他操作修改，请刷新后重试。" });
      return tx.assistantTemplate.findUniqueOrThrow({ where: { id } });
    }
    if (await tx.assistantTemplate.count() >= 50) throw new ApiError({ code: "CONFLICT", message: "最多保存 50 个自定义助理模板。" });
    return tx.assistantTemplate.create({ data: { config } });
  });
}
