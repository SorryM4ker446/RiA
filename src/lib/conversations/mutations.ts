import { z } from "zod";
import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { truncateTitle } from "@/lib/ai/ui-message";
import { chatTagSchema, conversationSummary } from "@/lib/conversations/query";

export const updateConversationSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  tags: z.array(chatTagSchema).max(8).transform(tags => [...new Set(tags)].sort()).optional(),
}).refine(value => Object.keys(value).length > 0, "At least one field is required");

export const bulkDeleteSchema = z.strictObject({
  ids: z.array(z.string().min(1).max(200)).min(1).max(50).refine(ids => new Set(ids).size === ids.length, "Duplicate conversation IDs"),
  confirm: z.literal(true),
});

export async function updateConversation(userId: string, id: string, input: z.infer<typeof updateConversationSchema>) {
  return db.$transaction(async tx => {
    if (!await tx.chat.findFirst({ where: { id, userId }, select: { id: true } })) throw new ApiError({ code: "NOT_FOUND", message: "Conversation not found" });
    const chat = await tx.chat.update({ where: { id }, data: {
      ...(input.title !== undefined ? { title: truncateTitle(input.title) } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
      ...(input.tags !== undefined ? { tags: { deleteMany: {}, create: input.tags.map(label => ({ label })) } } : {}),
    }, include: { tags: { orderBy: { label: "asc" } }, _count: { select: { messages: true } } } });
    return conversationSummary(chat);
  });
}

export async function deleteConversations(userId: string, ids: string[]) {
  return db.$transaction(async tx => {
    const count = await tx.chat.count({ where: { userId, id: { in: ids } } });
    if (count !== ids.length) throw new ApiError({ code: "NOT_FOUND", message: "One or more conversations are unavailable; no conversations were deleted" });
    // Preserve shared assets and give newly unreferenced files the normal cleanup grace period.
    await tx.mediaAsset.updateMany({ where: { userId, references: { some: { message: { chatId: { in: ids } } } } }, data: { lastUsedAt: new Date() } });
    return (await tx.chat.deleteMany({ where: { userId, id: { in: ids } } })).count;
  });
}
