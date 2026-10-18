import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { createApiErrorResponse, ApiError } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { registryQuerySchema, searchRegistry } from "@/lib/extensions/registry";

export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("extensionRegistry");
    const params = req.nextUrl.searchParams;
    for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new ApiError({ code: "VALIDATION_ERROR", message: "目录参数不能重复。" });
    const input = registryQuerySchema.parse(Object.fromEntries(params));
    return Response.json({ data: await searchRegistry(input, req.signal) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "无法读取 MCP 官方目录。" ); }
});
