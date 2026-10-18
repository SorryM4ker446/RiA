import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { activateExtension, deleteExtension, saveExtension } from "@/lib/extensions/store";
import { extensionIdSchema, saveExtensionSchema } from "@/lib/extensions/schema";

type Context = { params: Promise<{ id: string }> };
export const PUT = protectDataOperation(async (req: NextRequest, context: Context) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("extensions");
    const id = extensionIdSchema.parse((await context.params).id);
    return Response.json({ data: await saveExtension(saveExtensionSchema.parse(await readJsonBody(req, 131_072)), id) });
  } catch (error) { return createApiErrorResponse(error, "无法更新扩展配置。"); }
});
export const PATCH = protectDataOperation(async (req: NextRequest, context: Context) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("extensions");
    const id = extensionIdSchema.parse((await context.params).id);
    return Response.json({ data: await activateExtension(id, await readJsonBody(req, 16_384)) });
  } catch (error) { return createApiErrorResponse(error, "无法更新扩展状态。"); }
});
export const DELETE = protectDataOperation(async (req: NextRequest, context: Context) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("extensions");
    const id = extensionIdSchema.parse((await context.params).id);
    const revision = z.coerce.number().int().positive().parse(req.nextUrl.searchParams.get("revision"));
    await deleteExtension(id, revision);
    return Response.json({ data: { deleted: true } });
  } catch (error) { return createApiErrorResponse(error, "无法删除扩展。"); }
});
