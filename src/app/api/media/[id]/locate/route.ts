import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { getMediaAsset, locateMediaAsset } from "@/lib/media/storage";
import { t } from "@/lib/locale";

/**
 * Where an asset's file is, so the desktop app can select it in the file
 * manager. The service resolves the path from the asset's id and checks it;
 * the desktop side only shows what it is handed.
 */
async function POSTHandler(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requireLocalWorkspace(req);
    const asset = await getMediaAsset((await context.params).id);
    return Response.json({ data: { absolutePath: await locateMediaAsset(asset) } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.media.locateFailed")); }
}

export const POST = protectDataOperation(POSTHandler);
