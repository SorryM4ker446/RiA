import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { listExtensions, saveExtension } from "@/lib/extensions/store";
import { saveExtensionSchema } from "@/lib/extensions/schema";
import { localProcessConnectionsAllowed } from "@/lib/extensions/transport";

export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    return Response.json({ data: { ...await listExtensions(), localProcessesAllowed: localProcessConnectionsAllowed() } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "无法读取扩展配置。"); }
});
export const POST = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("extensions");
    const input = saveExtensionSchema.parse(await readJsonBody(req, 131_072));
    return Response.json({ data: await saveExtension(input) }, { status: 201 });
  } catch (error) { return createApiErrorResponse(error, "无法保存扩展配置。"); }
});
