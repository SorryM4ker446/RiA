import { NextRequest } from "next/server";
import { z } from "zod";
import { protectDataOperation } from "@/lib/server/data-operations";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { topicConfigSchema, topicIdSchema } from "@/lib/topics/schema";
import { getTopic, saveTopic } from "@/lib/topics/store";
import { deleteTopic } from "@/lib/topics/artifacts";
import { topicResponse } from "@/lib/topics/api";
type Context = { params: Promise<{ id: string }> };
export const GET = protectDataOperation((req: NextRequest, ctx: Context) => topicResponse(req, async () => getTopic(topicIdSchema.parse((await ctx.params).id))));
export const PATCH = protectDataOperation((req: NextRequest, ctx: Context) => topicResponse(req, async () => {
  enforceRateLimit("topics"); const input = topicConfigSchema.extend({ revision: z.number().int().positive() }).parse(await readJsonBody(req, 12_000));
  const { revision, ...config } = input; return saveTopic(config, topicIdSchema.parse((await ctx.params).id), revision);
}));
export const DELETE = protectDataOperation((req: NextRequest, ctx: Context) => topicResponse(req, async () => {
  enforceRateLimit("topics"); const input = z.strictObject({ confirm: z.literal("true"), revision: z.string().regex(/^[1-9]\d{0,8}$/).transform(Number) }).parse(Object.fromEntries(req.nextUrl.searchParams));
  await deleteTopic(topicIdSchema.parse((await ctx.params).id), input.revision); return { deleted: true };
}, true));
