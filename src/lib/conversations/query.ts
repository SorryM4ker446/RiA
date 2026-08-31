import { createHash } from "node:crypto";
import { Prisma, type Chat } from "@prisma/client";
import { z } from "zod";
import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";

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

export function readConversationQuery(userId: string, params: URLSearchParams) {
  for (const key of new Set(params.keys())) if (params.getAll(key).length !== 1) throw new ApiError({ code: "VALIDATION_ERROR", message: "Duplicate query parameter" });
  const input = querySchema.parse(Object.fromEntries(params));
  const scope = createHash("sha256").update(JSON.stringify([userId, input.q, input.tag ?? "", input.state])).digest("hex");
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (input.cursor) {
    try {
      cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
      if (cursor.scope !== scope) throw new Error("Cursor scope mismatch");
    } catch { throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid conversation cursor; refresh the list" }); }
  }
  return { ...input, scope, cursor };
}

export function conversationSummary(chat: Chat & { tags: { label: string }[]; _count: { messages: number } }) {
  return {
    id: chat.id, title: chat.title, pinned: chat.pinned, archived: chat.archived,
    createdAt: chat.createdAt, updatedAt: chat.updatedAt, lastMessageAt: chat.lastMessageAt,
    tags: chat.tags.map(tag => tag.label), messageCount: chat._count.messages,
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
      JOIN chats owned ON owned.id=m.chatId WHERE owned.userId=c.userId AND ${messageMatch})
  )`;
}

export async function listConversations(userId: string, params: URLSearchParams) {
  const options = readConversationQuery(userId, params);
  const cursor = options.cursor;
  const state = options.state === "all" ? Prisma.empty : Prisma.sql`AND c.archived=${options.state === "archived"}`;
  const tags = options.tag ? Prisma.sql`AND EXISTS (SELECT 1 FROM chat_tags t WHERE t.chatId=c.id AND t.label=${options.tag})` : Prisma.empty;
  const boundary = cursor ? Prisma.sql`AND (c.pinned < ${cursor.pinned} OR (c.pinned=${cursor.pinned} AND
    (c.lastMessageAt < ${new Date(cursor.date)} OR (c.lastMessageAt=${new Date(cursor.date)} AND c.id < ${cursor.id}))))` : Prisma.empty;
  return db.$transaction(async tx => {
  const ids = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT c.id FROM chats c WHERE c.userId=${userId} ${state} ${tags} ${boundary}
    ${options.q ? searchCondition(options.q) : Prisma.empty}
    ORDER BY c.pinned DESC,c.lastMessageAt DESC,c.id DESC LIMIT ${options.limit + 1}`);
  const rows = await tx.chat.findMany({ where: { id: { in: ids.map(row => row.id) }, userId }, include: { tags: { orderBy: { label: "asc" } }, _count: { select: { messages: true } } } });
  const byId = new Map(rows.map(row => [row.id, row]));
  const ordered = ids.flatMap(row => { const chat = byId.get(row.id); return chat ? [chat] : []; });
  const data = ordered.slice(0, options.limit).map(conversationSummary);
  const last = data.at(-1);
  const nextCursor = ordered.length > options.limit && last ? Buffer.from(JSON.stringify({
    v: 2, scope: options.scope, pinned: last.pinned, date: last.lastMessageAt.toISOString(), id: last.id,
  })).toString("base64url") : null;
  return { data, pageInfo: { nextCursor, hasMore: nextCursor !== null } };
  });
}
