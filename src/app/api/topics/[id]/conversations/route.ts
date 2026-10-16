import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { protectDataOperation } from "@/lib/server/data-operations";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { topicIdSchema } from "@/lib/topics/schema";
import { getTopic, createTopicChat } from "@/lib/topics/store";
import { topicResponse } from "@/lib/topics/api";
type Context = { params: Promise<{ id: string }> };
export const GET = protectDataOperation((req: NextRequest, ctx: Context) => topicResponse(req, async () => {
  const id = topicIdSchema.parse((await ctx.params).id); await getTopic(id);
  return db.chat.findMany({ where: { topicId: id }, orderBy: [{ lastMessageAt: "desc" }, { id: "asc" }], take: 50, select: { id: true, title: true, archived: true, documentScope: true, lastMessageAt: true } });
}));
export const POST = protectDataOperation((req: NextRequest, ctx: Context) => topicResponse(req, async () => {
  enforceRateLimit("topics"); const input = z.strictObject({ revision: z.number().int().positive(), title: z.string().trim().min(1).max(120) }).parse(await readJsonBody(req, 4000));
  return createTopicChat(topicIdSchema.parse((await ctx.params).id), input.revision, input.title);
}));
