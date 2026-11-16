import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { assistantConfigSchema, assistantIdSchema } from "@/lib/assistants/schema";
import { saveAssistant } from "@/lib/assistants/store";
import { t } from "@/lib/locale";
const updateSchema = z.strictObject({ revision: z.number().int().positive(), config: assistantConfigSchema });
type Context = { params: Promise<{ id: string }> };
async function PATCHHandler(req: NextRequest, context: Context) {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("assistantTemplates");
    const id = assistantIdSchema.parse((await context.params).id);
    const input = updateSchema.parse(await readJsonBody(req));
    return Response.json({ data: await saveAssistant(input.config, id, input.revision) });
  } catch (error) { return createApiErrorResponse(error, t("server.fallback.assistantUpdate")); }
}
async function DELETEHandler(req: NextRequest, context: Context) {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("assistantTemplates");
    const id = assistantIdSchema.parse((await context.params).id);
    const params = req.nextUrl.searchParams;
    if ([...params.keys()].some(key => params.getAll(key).length !== 1)) throw new ApiError({ code: "VALIDATION_ERROR", message: t("errors.duplicateDeletionParameters") });
    const input = z.strictObject({ confirm: z.literal("true"), revision: z.string().regex(/^[1-9]\d{0,8}$/).transform(Number) }).parse(Object.fromEntries(params));
    const count = await db.assistantTemplate.deleteMany({ where: { id, revision: input.revision } });
    if (!count.count) throw new ApiError({ code: "CONFLICT", message: t("errors.templateChangedOrWasDeletedRefreshAndTry") });
    return Response.json({ success: true });
  } catch (error) { return createApiErrorResponse(error, t("server.fallback.assistantDelete")); }
}
export const PATCH = protectDataOperation(PATCHHandler);
export const DELETE = protectDataOperation(DELETEHandler);
