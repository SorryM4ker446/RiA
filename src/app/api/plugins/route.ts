import { NextRequest } from "next/server";
import { protectDataOperation } from "@/lib/server/data-operations";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { installPlugin, listPlugins } from "@/lib/plugins/store";
import { pluginCatalog } from "@/lib/plugins/catalog";
import { PLUGIN_LIMITS } from "@/lib/plugins/schema";

export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    return Response.json({ data: { ...await listPlugins(), catalog: pluginCatalog } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "无法读取插件。"); }
});
export const POST = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("extensions");
    return Response.json({ data: await installPlugin(await readJsonBody(req, PLUGIN_LIMITS.bytes + 1024)) }, { status: 201 });
  } catch (error) { return createApiErrorResponse(error, "插件未安装，请检查包格式与本地程序配置。"); }
});
