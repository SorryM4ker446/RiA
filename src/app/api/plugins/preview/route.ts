import { NextRequest } from "next/server";
import { protectDataOperation } from "@/lib/server/data-operations";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { parsePlugin, PLUGIN_LIMITS } from "@/lib/plugins/schema";

export const POST = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("extensions");
    return Response.json({ data: parsePlugin(await readJsonBody(req, PLUGIN_LIMITS.bytes)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "无法预览插件，请检查 JSON 包格式。"); }
});
