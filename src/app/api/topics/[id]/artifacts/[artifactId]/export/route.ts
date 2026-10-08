import { NextRequest } from "next/server";
import { z } from "zod";
import { protectDataOperation } from "@/lib/server/data-operations";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse, ApiError } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { topicIdSchema } from "@/lib/topics/schema";
import { getArtifact, exportArtifact } from "@/lib/topics/artifacts";
export const GET = protectDataOperation(async (req: NextRequest, ctx: { params: Promise<{ id: string; artifactId: string }> }) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("conversationExport");
    if ([...req.nextUrl.searchParams.keys()].some(key => key !== "format") || req.nextUrl.searchParams.getAll("format").length !== 1) throw new ApiError({ code: "VALIDATION_ERROR", message: "Specify one export format" });
    const format = z.enum(["markdown", "json"]).parse(req.nextUrl.searchParams.get("format")); const params = await ctx.params;
    const row = await getArtifact(topicIdSchema.parse(params.id), z.string().uuid().parse(params.artifactId));
    return new Response(exportArtifact(row, format), { headers: { "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="artifact-${row.id}.${format === "json" ? "json" : "md"}"` } });
  } catch (error) { return createApiErrorResponse(error, "成果导出失败。"); }
});
