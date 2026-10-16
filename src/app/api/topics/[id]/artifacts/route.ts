import { NextRequest } from "next/server";
import { protectDataOperation } from "@/lib/server/data-operations";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { topicIdSchema, artifactInputSchema } from "@/lib/topics/schema";
import { listArtifacts, generateArtifact } from "@/lib/topics/artifacts";
import { topicResponse } from "@/lib/topics/api";
type Context = { params: Promise<{ id: string }> };
export const GET = protectDataOperation((req: NextRequest, ctx: Context) => topicResponse(req, async () => listArtifacts(topicIdSchema.parse((await ctx.params).id))));
export const POST = protectDataOperation((req: NextRequest, ctx: Context) => topicResponse(req, async () => {
  enforceRateLimit("topicGeneration"); return generateArtifact(topicIdSchema.parse((await ctx.params).id), artifactInputSchema.parse(await readJsonBody(req, 12_000)), req.signal);
}));
