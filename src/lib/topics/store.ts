import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { resolveAssistant } from "@/lib/assistants/store";
import { topicConfigSchema, type TopicConfig } from "./schema";
import { encodeDocumentScope } from "@/lib/documents/scope";

export const topicSelect = { id: true, config: true, revision: true, createdAt: true, updatedAt: true, _count: { select: { chats: true, artifacts: true } } } as const;
export async function getTopic(id: string) {
  const row = await db.knowledgeTopic.findUnique({ where: { id }, select: topicSelect });
  if (!row) throw new ApiError({ code: "NOT_FOUND", message: "专题不存在或已删除。" });
  return { ...row, config: topicConfigSchema.parse(row.config) };
}
export async function listTopics() {
  return (await db.knowledgeTopic.findMany({ select: topicSelect, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 50 }))
    .map(row => ({ ...row, config: topicConfigSchema.parse(row.config) }));
}
export async function saveTopic(input: TopicConfig, id?: string, revision?: number) {
  const config = topicConfigSchema.parse(input);
  if (config.assistantTemplateId) await resolveAssistant(config.assistantTemplateId);
  return db.$transaction(async tx => {
    if (id) {
      const result = await tx.knowledgeTopic.updateMany({ where: { id, revision }, data: { config, revision: { increment: 1 } } });
      if (!result.count) throw new ApiError({ code: "CONFLICT", message: "专题已修改或删除，请刷新后重试。" });
      return tx.knowledgeTopic.findUniqueOrThrow({ where: { id }, select: topicSelect });
    }
    if (await tx.knowledgeTopic.count() >= 50) throw new ApiError({ code: "CONFLICT", message: "最多保存 50 个专题。" });
    return tx.knowledgeTopic.create({ data: { config }, select: topicSelect });
  });
}
export async function createTopicChat(id: string, revision: number, title: string) {
  const topic = await getTopic(id);
  const assistant = topic.config.assistantTemplateId ? await resolveAssistant(topic.config.assistantTemplateId) : null;
  return db.$transaction(async tx => {
    const current = await tx.knowledgeTopic.findUnique({ where: { id } });
    if (!current || current.revision !== revision || topic.revision !== revision) throw new ApiError({ code: "CONFLICT", message: "专题已修改，请刷新后创建会话。" });
    return tx.chat.create({ data: { title, topicId: id, documentScope: encodeDocumentScope(topic.config.collections), ephemeral: assistant ? !assistant.usesMemory : false,
      ...(assistant ? { assistantConfig: { ...assistant, collections: topic.config.collections } } : {}) } });
  });
}
