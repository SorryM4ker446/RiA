import { NextRequest } from "next/server";
import { z } from "zod";
import { protectDataOperation } from "@/lib/server/data-operations";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { topicIdSchema } from "@/lib/topics/schema";
import { getArtifact, deleteArtifact } from "@/lib/topics/artifacts";
import { topicResponse } from "@/lib/topics/api";
type Context = { params: Promise<{ id: string; artifactId: string }> };
export const GET = protectDataOperation((req: NextRequest, ctx: Context) => topicResponse(req, async () => {
  const params = await ctx.params; return getArtifact(topicIdSchema.parse(params.id), z.string().uuid().parse(params.artifactId));
}));
export const DELETE = protectDataOperation((req: NextRequest, ctx: Context) => topicResponse(req, async () => {
  enforceRateLimit("topics"); z.strictObject({ confirm: z.literal("true") }).parse(Object.fromEntries(req.nextUrl.searchParams));
  const params = await ctx.params; await deleteArtifact(topicIdSchema.parse(params.id), z.string().uuid().parse(params.artifactId)); return { deleted: true };
}, true));
