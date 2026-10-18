import { NextRequest } from "next/server";
import { z } from "zod";
import { protectDataOperation } from "@/lib/server/data-operations";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { setPluginState, uninstallPlugin } from "@/lib/plugins/store";

type Context = { params: Promise<{ id: string }> };
export const PATCH = protectDataOperation(async (req: NextRequest, context: Context) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("extensions");
    const id = z.string().uuid().parse((await context.params).id);
    return Response.json({ data: await setPluginState(id, await readJsonBody(req, 4096)) });
  } catch (error) { return createApiErrorResponse(error, "插件状态未更新。"); }
});
export const DELETE = protectDataOperation(async (req: NextRequest, context: Context) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("extensions");
    const id = z.string().uuid().parse((await context.params).id);
    const revision = z.coerce.number().int().positive().parse(req.nextUrl.searchParams.get("revision"));
    await uninstallPlugin(id, revision);
    return Response.json({ data: { deleted: true } });
  } catch (error) { return createApiErrorResponse(error, "插件未卸载。"); }
});
