import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { getMediaDetail } from "@/lib/media/library";
import { t } from "@/lib/locale";
async function GETHandler(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try { await requireLocalWorkspace(req);return Response.json({ data: await getMediaDetail((await context.params).id) }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return createApiErrorResponse(error, t("api.media.detailFailed")); }
}

export const GET = protectDataOperation(GETHandler);
