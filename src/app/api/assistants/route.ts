import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { assistantConfigSchema } from "@/lib/assistants/schema";
import { listAssistants, saveAssistant } from "@/lib/assistants/store";
async function GETHandler(req: NextRequest) {
  try { await requireLocalWorkspace(req); return Response.json({ data: await listAssistants() }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return createApiErrorResponse(error, "读取助理模板失败。"); }
}
async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("assistantTemplates");
    return Response.json({ data: await saveAssistant(assistantConfigSchema.parse(await readJsonBody(req))) }, { status: 201 });
  } catch (error) { return createApiErrorResponse(error, "保存助理模板失败。"); }
}
export const GET = protectDataOperation(GETHandler);
export const POST = protectDataOperation(POSTHandler);
