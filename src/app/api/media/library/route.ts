import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { listMediaLibrary } from "@/lib/media/library";
import { t } from "@/lib/locale";
async function GETHandler(req: NextRequest) {
  try { await requireLocalWorkspace(req); return Response.json(await listMediaLibrary(req.nextUrl.searchParams), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return createApiErrorResponse(error, t("api.media.libraryFailed")); }
}

export const GET = protectDataOperation(GETHandler);
