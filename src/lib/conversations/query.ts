import { conversationCollections } from "@/lib/conversations/document-scope";
import { encodeDocumentScope } from "@/lib/documents/scope";
import { createHash } from "node:crypto";
import { Prisma, type Chat } from "@prisma/client";
import { z } from "zod";
import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { readAssistantSnapshot } from "@/lib/assistants/schema";
import { decodePersistedAssistantToolMessage } from "@/lib/ai/ui-message";
import { taskModel } from "@/lib/scheduler/jobs";
import { readApprovalRule } from "@/lib/approvals/rules";

export const chatTagSchema = z.string().trim().min(1).max(32)
  .transform(value => value.normalize("NFKC").trim().toLowerCase()).pipe(z.string().min(1).max(32).regex(/^[^,\u0000-\u001f\u007f]+$/));
const cursorSchema = z.strictObject({ v: z.literal(2), scope: z.string(), pinned: z.boolean(), date: z.iso.datetime(), id: z.string().min(1).max(200) });
const querySchema = z.strictObject({
  q: z.string().trim().max(200).regex(/^[^\u0000-\u001f\u007f]*$/).refine(value => !value || [...value].length >= 2, "Search requires at least two characters").default(""),
  tag: chatTagSchema.optional(),
  state: z.enum(["active", "archived", "all"]).default("active"),
  limit: z.string().regex(/^[1-9]\d{0,2}$/).transform(Number).pipe(z.number().max(100)).default(30),
  cursor: z.string().min(1).max(1500).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

function readConversationQuery(params: URLSearchParams) {
  for (const key of new Set(params.keys())) if (params.getAll(key).length !== 1) throw new ApiError({ code: "VALIDATION_ERROR", message: "Duplicate query parameter" });
  const input = querySchema.parse(Object.fromEntries(params));
  const scope = createHash("sha256").update(JSON.stringify([input.q, input.tag ?? "", input.state])).digest("hex");
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (input.cursor) {
    try {
      cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
      if (cursor.scope !== scope) throw new Error("Cursor scope mismatch");
    } catch { throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid conversation cursor; refresh the list" }); }
  }
  return { ...input, scope, cursor };
}

/** What a conversation is read with: its tags, its size, and the task it belongs to, if any. */
export const conversationInclude = {
  tags: { orderBy: { label: "asc" } },
  _count: { select: { messages: true } },
  scheduledJobs: { select: { id: true, modelProvider: true, modelId: true, workspaceGrantId: true, approvalRule: true, usesMemory: true, lastStatus: true }, take: 1 },
} as const;

type TaskLink = { id: string; modelProvider: string | null; modelId: string | null; workspaceGrantId: string | null; approvalRule: string; usesMemory: boolean; lastStatus: string | null };

/**
 * The conversations among `chatIds` whose latest answer waits for the user to
 * approve a tool call: the list shows them as needing attention. Only each
 * conversation's latest message is read.
 */
export async function awaitingApproval(chatIds: string[], client: Pick<typeof db, "$queryRaw"> = db): Promise<Set<string>> {
  if (!chatIds.length) return new Set();
  const latest = await client.$queryRaw<Array<{ chatId: string; content: string }>>(Prisma.sql`
    SELECT m.chatId, m.content FROM messages m
    WHERE m.chatId IN (${Prisma.join(chatIds)}) AND m.role = 'assistant'
      AND m.id = (SELECT l.id FROM messages l WHERE l.chatId = m.chatId ORDER BY l.createdAt DESC, l.id DESC LIMIT 1)`);
  return new Set(latest.filter(row => decodePersistedAssistantToolMessage(row.content)?.tools.some(tool => tool.state === "approval-requested")).map(row => row.chatId));
}

/** `waiting`: whether the conversation's latest answer waits for an approval, from `awaitingApproval`. */
export function conversationSummary(chat: Chat & { tags: { label: string }[]; _count: { messages: number }; scheduledJobs: TaskLink[] }, waiting = false) {
  const task = chat.scheduledJobs[0] ?? null;
  return {
    // A task's conversation takes its memory switch and approval rule from the task.
    id: chat.id, title: chat.title, pinned: chat.pinned, archived: chat.archived, ephemeral: task ? !task.usesMemory : chat.ephemeral,
    approvalRule: readApprovalRule(task ? task.approvalRule : chat.approvalRule), documentScope: encodeDocumentScope(conversationCollections(chat)),
    // A task's conversation works in the task's folder and takes no template.
    workspaceGrantId: task ? task.workspaceGrantId : chat.workspaceGrantId,
    assistantConfig: task ? null : readAssistantSnapshot(chat.assistantConfig),
    createdAt: chat.createdAt, updatedAt: chat.updatedAt, lastMessageAt: chat.lastMessageAt,
    tags: chat.tags.map(tag => tag.label), messageCount: chat._count.messages,
    // The task that owns this conversation: it writes here by itself, so an open
    // page looks for what it added, and it decides the model every turn uses.
    task: task ? { id: task.id, model: taskModel(task), running: task.lastStatus === "running" } : null,
    awaitingApproval: waiting,
  };
}

function searchCondition(query: string) {
  const phrase = `"${query.replaceAll('"', '""')}"`;
  const titleMatch = [...query].length >= 3
    ? Prisma.sql`s.text MATCH ${phrase}` : Prisma.sql`instr(lower(s.text),lower(${query})) > 0`;
  const messageMatch = [...query].length >= 3
    ? Prisma.sql`s.text MATCH ${phrase}` : Prisma.sql`instr(lower(s.text),lower(${query})) > 0`;
  return Prisma.sql`AND (
    c.id IN (SELECT s.id FROM chat_title_search s WHERE ${titleMatch})
    OR c.id IN (SELECT m.chatId FROM messages m JOIN message_text_search s ON s.id=m.id
      WHERE ${messageMatch})
  )`;
}

export async function listConversations(params: URLSearchParams) {
  const options = readConversationQuery(params);
  const cursor = options.cursor;
  const state = options.state === "all" ? Prisma.empty : Prisma.sql`AND c.archived=${options.state === "archived"}`;
  const tags = options.tag ? Prisma.sql`AND EXISTS (SELECT 1 FROM chat_tags t WHERE t.chatId=c.id AND t.label=${options.tag})` : Prisma.empty;
  const boundary = cursor ? Prisma.sql`AND (c.pinned < ${cursor.pinned} OR (c.pinned=${cursor.pinned} AND
    (c.lastMessageAt < ${new Date(cursor.date)} OR (c.lastMessageAt=${new Date(cursor.date)} AND c.id < ${cursor.id}))))` : Prisma.empty;
  return db.$transaction(async tx => {
  const ids = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT c.id FROM chats c WHERE 1=1 ${state} ${tags} ${boundary}
    ${options.q ? searchCondition(options.q) : Prisma.empty}
    ORDER BY c.pinned DESC,c.lastMessageAt DESC,c.id DESC LIMIT ${options.limit + 1}`);
  const rows = await tx.chat.findMany({ where: { id: { in: ids.map(row => row.id) } }, include: conversationInclude });
  const byId = new Map(rows.map(row => [row.id, row]));
  const ordered = ids.flatMap(row => { const chat = byId.get(row.id); return chat ? [chat] : []; });
  const page = ordered.slice(0, options.limit);
  const waiting = await awaitingApproval(page.map(chat => chat.id), tx);
  const data = page.map(chat => conversationSummary(chat, waiting.has(chat.id)));
  const last = data.at(-1);
  const nextCursor = ordered.length > options.limit && last ? Buffer.from(JSON.stringify({
    v: 2, scope: options.scope, pinned: last.pinned, date: last.lastMessageAt.toISOString(), id: last.id,
  })).toString("base64url") : null;
  return { data, pageInfo: { nextCursor, hasMore: nextCursor !== null } };
  });
}
