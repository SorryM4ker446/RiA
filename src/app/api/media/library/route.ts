import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { listMediaLibrary } from "@/lib/media/library";
async function GETHandler(req: NextRequest) {
  try { await requireLocalWorkspace(req); return Response.json(await listMediaLibrary(req.nextUrl.searchParams), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return createApiErrorResponse(error, "无法读取媒体资源库。"); }
}

export const GET = protectDataOperation(GETHandler);
