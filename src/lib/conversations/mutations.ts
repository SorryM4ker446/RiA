import { z } from "zod";
import { db } from "@/db";
import { pruneTerminalLogs } from "@/lib/terminal/logs";
import { activeTerminalSessionIds } from "@/lib/terminal/runtime";
import { ApiError } from "@/lib/server/api-error";
import { truncateTitle } from "@/lib/ai/ui-message";
import { chatTagSchema, conversationSummary } from "@/lib/conversations/query";
import { encodeDocumentScope } from "@/lib/documents/scope";
import { Prisma } from "@prisma/client";
import { assistantIdSchema, readAssistantSnapshot } from "@/lib/assistants/schema";
import { resolveAssistant } from "@/lib/assistants/store";
import { assertSelectableWorkspace } from "@/lib/local-files/workspace";

export const updateConversationSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  ephemeral: z.boolean().optional(),
  documentScope: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  // One granted folder, or null to work without one.
  workspaceGrantId: z.string().trim().min(1).max(200).nullable().optional(),
  assistantTemplateId: assistantIdSchema.nullable().optional(),
  tags: z.array(chatTagSchema).max(8).transform(tags => [...new Set(tags)].sort()).optional(),
}).refine(value => Object.keys(value).length > 0, "At least one field is required")
  .refine(value => value.assistantTemplateId === undefined || (value.ephemeral === undefined && value.documentScope === undefined), "Apply a template separately from memory and collection overrides");

export const bulkDeleteSchema = z.strictObject({
  ids: z.array(z.string().min(1).max(200)).min(1).max(50).refine(ids => new Set(ids).size === ids.length, "Duplicate conversation IDs"),
  confirm: z.literal(true),
});

export async function updateConversation(id: string, input: z.infer<typeof updateConversationSchema>) {
  const selectedAssistant = input.assistantTemplateId ? await resolveAssistant(input.assistantTemplateId) : null;
  if (input.workspaceGrantId !== undefined) await assertSelectableWorkspace(input.workspaceGrantId);
  return db.$transaction(async tx => {
    const current = await tx.chat.findFirst({ where: { id }, select: { title: true, assistantConfig: true } });
    if (!current) throw new ApiError({ code: "NOT_FOUND", message: "Conversation not found" });
    const assistant = selectedAssistant;
    // Only a placeholder or the previous template's default name follows the
    // template. A conversation renamed by the user keeps its own title.
    const previousAssistant = readAssistantSnapshot(current.assistantConfig);
    const followsTemplate = ["new chat", "新会话", "untitled"].includes(current.title.trim().toLowerCase())
      || (previousAssistant !== null && current.title === truncateTitle(previousAssistant.name));
    const title = input.title ?? (input.assistantTemplateId !== undefined && followsTemplate ? assistant?.name ?? "New Chat" : undefined);
    const chat = await tx.chat.update({ where: { id }, data: {
      ...(input.assistantTemplateId !== undefined ? {
        assistantConfig: assistant ?? Prisma.DbNull,
        ...(assistant ? { documentScope: encodeDocumentScope(assistant.collections), ephemeral: !assistant.usesMemory } : {}),
        historyRevision: { increment: 1 }, summary: null, summaryUpToMessageId: null, summaryModelId: null, summaryRevision: null,
      } : {}),
      ...(title !== undefined ? { title: truncateTitle(title) } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
      ...(input.ephemeral !== undefined ? { ephemeral: input.ephemeral } : {}),
      ...(input.documentScope !== undefined ? { documentScope: encodeDocumentScope(input.documentScope) } : {}),
      ...(input.workspaceGrantId !== undefined ? { workspaceGrantId: input.workspaceGrantId } : {}),
      ...(input.tags !== undefined ? { tags: { deleteMany: {}, create: input.tags.map(label => ({ label })) } } : {}),
    }, include: { tags: { orderBy: { label: "asc" } }, _count: { select: { messages: true } } } });
    return conversationSummary(chat);
  });
}

export async function deleteConversations(ids: string[]) {
  const deleted = await db.$transaction(async tx => {
    const count = await tx.chat.count({ where: { id: { in: ids } } });
    if (count !== ids.length) throw new ApiError({ code: "NOT_FOUND", message: "One or more conversations are unavailable; no conversations were deleted" });
    // Preserve shared assets and give newly unreferenced files the normal cleanup grace period.
    await tx.mediaAsset.updateMany({ where: { references: { some: { message: { chatId: { in: ids } } } } }, data: { lastUsedAt: new Date() } });
    return (await tx.chat.deleteMany({ where: { id: { in: ids } } })).count;
  });
  // Runs cascade with their conversations; remove the terminal logs they owned.
  await pruneTerminalLogs(activeTerminalSessionIds()).catch(() => console.error("terminal.log.prune.failed"));
  return deleted;
}
