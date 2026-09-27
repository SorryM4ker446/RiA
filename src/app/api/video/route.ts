import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { generateStoredMedia } from "@/lib/media/generation";
import { t } from "@/lib/locale";

async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("video");
    return Response.json(await generateStoredMedia("video", await readJsonBody(req), req.signal), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.video.generateFailed")); }
}

export const POST = protectDataOperation(POSTHandler);
